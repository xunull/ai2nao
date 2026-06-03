import { execFile } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import type {
  ChatSession,
  ChatSessionSummary,
  Message,
  MessageRole,
} from "../cursorHistory/types.js";
import {
  cherryStudioIndexedDbPath,
  cherryStudioIndexedDbRoot,
} from "./paths.js";

type RawRecord = Record<string, unknown>;

type CherryIndexedDbRawSnapshot = {
  topics: RawRecord[];
  topicMetadata: RawRecord[];
  messageBlocks: RawRecord[];
  stores: string[];
};

type CherryIndexedDbSnapshot = {
  indexedDbPath: string;
  topics: RawRecord[];
  topicMetadataById: Map<string, RawRecord>;
  messageBlocks: RawRecord[];
  blockById: Map<string, RawRecord>;
  blocksByMessageId: Map<string, RawRecord[]>;
  warnings: string[];
};

export type CherryIndexedDbListResult = {
  sessions: ChatSessionSummary[];
  warnings: string[];
  topicCount: number;
};

export type CherryIndexedDbLoadResult = {
  session: ChatSession | null;
  warnings: string[];
};

const CACHE_TTL_MS = 5_000;
const MAX_HELPER_STDOUT_BYTES = 100 * 1024 * 1024;
const execFileAsync = promisify(execFile);
const requireFromHere = createRequire(import.meta.url);
const snapshotCache = new Map<string, { expiresAt: number; promise: Promise<CherryIndexedDbSnapshot> }>();

export async function countCherryIndexedDbTopics(root: string): Promise<{ count: number; warnings: string[] }> {
  const snapshot = await readCherryIndexedDbSnapshot(root);
  return { count: snapshot.topics.length, warnings: snapshot.warnings };
}

export async function listCherryIndexedDbSessions(root: string): Promise<CherryIndexedDbListResult> {
  const snapshot = await readCherryIndexedDbSnapshot(root);
  return sessionsFromSnapshot(snapshot);
}

export async function loadCherryIndexedDbSession(root: string, prefixedSessionId: string): Promise<CherryIndexedDbLoadResult> {
  const snapshot = await readCherryIndexedDbSnapshot(root);
  return {
    session: sessionFromSnapshot(snapshot, prefixedSessionId),
    warnings: snapshot.warnings,
  };
}

export function sessionsFromCherryIndexedDbRecords(input: {
  topics: RawRecord[];
  topicMetadata?: RawRecord[];
  messageBlocks: RawRecord[];
  indexedDbPath?: string;
  warnings?: string[];
}): CherryIndexedDbListResult {
  return sessionsFromSnapshot(buildSnapshot(input));
}

export function sessionFromCherryIndexedDbRecords(
  input: {
    topics: RawRecord[];
    topicMetadata?: RawRecord[];
    messageBlocks: RawRecord[];
    indexedDbPath?: string;
    warnings?: string[];
  },
  prefixedSessionId: string
): CherryIndexedDbLoadResult {
  const snapshot = buildSnapshot(input);
  return {
    session: sessionFromSnapshot(snapshot, prefixedSessionId),
    warnings: snapshot.warnings,
  };
}

async function readCherryIndexedDbSnapshot(root: string): Promise<CherryIndexedDbSnapshot> {
  const indexedDbPath = cherryStudioIndexedDbPath(root);
  if (!existsSync(indexedDbPath)) {
    return buildSnapshot({
      topics: [],
      topicMetadata: [],
      messageBlocks: [],
      indexedDbPath,
      warnings: [`IndexedDB not found: ${indexedDbPath}`],
    });
  }

  const cached = snapshotCache.get(root);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.promise;
  }

  const promise = readSnapshotViaPlaywright(root).catch((error: unknown) =>
    buildSnapshot({
      topics: [],
      topicMetadata: [],
      messageBlocks: [],
      indexedDbPath,
      warnings: [`IndexedDB read failed: ${errorMessage(error)}`],
    })
  );
  snapshotCache.set(root, { expiresAt: Date.now() + CACHE_TTL_MS, promise });
  return promise;
}

async function readSnapshotViaPlaywright(root: string): Promise<CherryIndexedDbSnapshot> {
  const indexedDbPath = cherryStudioIndexedDbPath(root);
  const sourceIndexedDbRoot = cherryStudioIndexedDbRoot(root);
  const userDataDir = mkdtempSync(join(tmpdir(), "ai2nao-cherry-indexeddb-"));
  const probePath = join(tmpdir(), `ai2nao-cherry-indexeddb-${Date.now()}-${Math.random().toString(36).slice(2)}.html`);
  const helperPath = join(tmpdir(), `ai2nao-cherry-indexeddb-${Date.now()}-${Math.random().toString(36).slice(2)}.mjs`);

  try {
    mkdirSync(join(userDataDir, "Default"), { recursive: true });
    cpSync(sourceIndexedDbRoot, join(userDataDir, "Default", "IndexedDB"), {
      recursive: true,
      force: true,
      errorOnExist: false,
    });
    const sourceLocalStorage = join(root, "Local Storage");
    if (existsSync(sourceLocalStorage)) {
      cpSync(sourceLocalStorage, join(userDataDir, "Default", "Local Storage"), {
        recursive: true,
        force: true,
        errorOnExist: false,
      });
    }
    writeFileSync(probePath, "<!doctype html><title>ai2nao cherry indexeddb reader</title>", "utf8");
    writeFileSync(helperPath, indexedDbReaderHelperSource(), "utf8");

    const raw = await readIndexedDbWithPlaywright(userDataDir, probePath).catch(async (directError: unknown) => {
      try {
        return await runIndexedDbReaderHelper(helperPath, userDataDir, probePath);
      } catch (helperError) {
        throw new Error(`${errorMessage(directError)}; helper fallback: ${errorMessage(helperError)}`);
      }
    });
    return buildSnapshot({
      topics: raw.topics,
      topicMetadata: raw.topicMetadata,
      messageBlocks: raw.messageBlocks,
      indexedDbPath,
      warnings: warningsFromStores(raw.stores),
    });
  } finally {
    rmSync(userDataDir, { recursive: true, force: true });
    rmSync(probePath, { force: true });
    rmSync(helperPath, { force: true });
  }
}

async function readIndexedDbWithPlaywright(
  userDataDir: string,
  probePath: string
): Promise<CherryIndexedDbRawSnapshot> {
  const { chromium } = await import("playwright");
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: true,
  });
  try {
    const page = await context.newPage();
    await page.goto(`file://${probePath}`);
    return await page.evaluate(cherryIndexedDbBrowserEvalSource()) as CherryIndexedDbRawSnapshot;
  } finally {
    await context.close();
  }
}

async function runIndexedDbReaderHelper(
  helperPath: string,
  userDataDir: string,
  probePath: string
): Promise<CherryIndexedDbRawSnapshot> {
  const playwrightUrl = pathToFileURL(requireFromHere.resolve("playwright")).href;
  const { stdout } = await execFileAsync(process.execPath, [helperPath, userDataDir, probePath, playwrightUrl], {
    maxBuffer: MAX_HELPER_STDOUT_BYTES,
  });
  const parsed = JSON.parse(stdout) as unknown;
  if (!isRecord(parsed) || !Array.isArray(parsed.topics) || !Array.isArray(parsed.messageBlocks) || !Array.isArray(parsed.stores)) {
    throw new Error("Cherry Studio IndexedDB helper returned invalid data");
  }
  return {
    topics: parsed.topics.filter(isRecord),
    topicMetadata: Array.isArray(parsed.topicMetadata) ? parsed.topicMetadata.filter(isRecord) : [],
    messageBlocks: parsed.messageBlocks.filter(isRecord),
    stores: parsed.stores.filter((store): store is string => typeof store === "string"),
  };
}

function indexedDbReaderHelperSource(): string {
  const browserEval = JSON.stringify(cherryIndexedDbBrowserEvalSource());
  return String.raw`
const [userDataDir, probePath, playwrightUrl] = process.argv.slice(2);
const playwright = await import(playwrightUrl);
const chromium = playwright.chromium ?? playwright.default?.chromium;
if (!chromium) throw new Error("Unable to load Playwright chromium");

const context = await chromium.launchPersistentContext(userDataDir, { headless: true });
try {
  const page = await context.newPage();
  await page.goto("file://" + probePath);
  const raw = await page.evaluate(${browserEval});
  process.stdout.write(JSON.stringify(raw));
} finally {
  await context.close();
}
`;
}

function cherryIndexedDbBrowserEvalSource(): string {
  return String.raw`
(async () => {
  function requestToPromise(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  const db = await new Promise((resolve, reject) => {
    const open = indexedDB.open("CherryStudio");
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error);
    open.onupgradeneeded = () => {
      open.transaction?.abort();
      reject(new Error("CherryStudio IndexedDB database is missing in the snapshot"));
    };
  });

  try {
    const stores = Array.from(db.objectStoreNames);
    const topics = stores.includes("topics")
      ? await requestToPromise(db.transaction(["topics"], "readonly").objectStore("topics").getAll())
      : [];
    const messageBlocks = stores.includes("message_blocks")
      ? await requestToPromise(db.transaction(["message_blocks"], "readonly").objectStore("message_blocks").getAll())
      : [];
    return { topics, topicMetadata: topicMetadataFromLocalStorage(), messageBlocks, stores };
  } finally {
    db.close();
  }

  function topicMetadataFromLocalStorage() {
    try {
      const persisted = localStorage.getItem("persist:cherry-studio");
      if (!persisted) return [];
      const parsed = JSON.parse(persisted);
      const assistantsRaw = typeof parsed.assistants === "string"
        ? JSON.parse(parsed.assistants)
        : parsed.assistants;
      if (!assistantsRaw || typeof assistantsRaw !== "object") return [];
      const assistants = [];
      if (assistantsRaw.defaultAssistant && typeof assistantsRaw.defaultAssistant === "object") {
        assistants.push(assistantsRaw.defaultAssistant);
      }
      if (Array.isArray(assistantsRaw.assistants)) {
        assistants.push(...assistantsRaw.assistants.filter((assistant) => assistant && typeof assistant === "object"));
      }
      const metadata = [];
      for (const assistant of assistants) {
        const topics = Array.isArray(assistant.topics) ? assistant.topics : [];
        for (const topic of topics) {
          if (!topic || typeof topic !== "object" || typeof topic.id !== "string") continue;
          metadata.push({
            ...topic,
            assistantId: typeof topic.assistantId === "string" ? topic.assistantId : assistant.id,
            assistantName: typeof assistant.name === "string" ? assistant.name : undefined,
          });
        }
      }
      return metadata;
    } catch {
      return [];
    }
  }
})()
`;
}

function buildSnapshot(input: {
  topics: RawRecord[];
  topicMetadata?: RawRecord[];
  messageBlocks: RawRecord[];
  indexedDbPath?: string;
  warnings?: string[];
}): CherryIndexedDbSnapshot {
  const topicMetadataById = new Map<string, RawRecord>();
  const blockById = new Map<string, RawRecord>();
  const blocksByMessageId = new Map<string, RawRecord[]>();

  for (const metadata of input.topicMetadata ?? []) {
    const id = stringField(metadata.id);
    if (id) topicMetadataById.set(id, metadata);
  }

  for (const block of input.messageBlocks) {
    const id = stringField(block.id);
    const messageId = stringField(block.messageId);
    if (id) blockById.set(id, block);
    if (messageId) {
      const existing = blocksByMessageId.get(messageId) ?? [];
      existing.push(block);
      blocksByMessageId.set(messageId, existing);
    }
  }

  return {
    indexedDbPath: input.indexedDbPath ?? "",
    topics: input.topics,
    topicMetadataById,
    messageBlocks: input.messageBlocks,
    blockById,
    blocksByMessageId,
    warnings: input.warnings ?? [],
  };
}

function sessionsFromSnapshot(snapshot: CherryIndexedDbSnapshot): CherryIndexedDbListResult {
  const sessions = snapshot.topics
    .map((topic) => sessionFromTopic(snapshot, topic))
    .filter((session): session is ChatSession => Boolean(session))
    .map(summaryFromSession)
    .sort(
      (a, b) =>
        b.lastUpdatedAt.getTime() - a.lastUpdatedAt.getTime() ||
        a.id.localeCompare(b.id)
    );

  sessions.forEach((session, index) => {
    session.index = index + 1;
  });

  return {
    sessions,
    warnings: snapshot.warnings,
    topicCount: snapshot.topics.length,
  };
}

function sessionFromSnapshot(snapshot: CherryIndexedDbSnapshot, prefixedSessionId: string): ChatSession | null {
  const topicId = prefixedSessionId.startsWith("indexeddb:")
    ? prefixedSessionId.slice("indexeddb:".length)
    : prefixedSessionId;
  const topic = snapshot.topics.find((candidate) => stringField(candidate.id) === topicId);
  return topic ? sessionFromTopic(snapshot, topic) : null;
}

function sessionFromTopic(snapshot: CherryIndexedDbSnapshot, topic: RawRecord): ChatSession | null {
  const topicId = stringField(topic.id);
  if (!topicId) return null;
  const topicMetadata = snapshot.topicMetadataById.get(topicId);
  const rawMessages = Array.isArray(topic.messages) ? topic.messages.filter(isRecord) : [];
  const messages = rawMessages
    .map((message, index) => messageFromRaw(snapshot, topicId, message, index))
    .filter((message): message is Message => Boolean(message));
  const timestamp = dateOrFallback(
    stringField(topicMetadata?.createdAt) ||
    stringField(topic.createdAt) ||
    messages[0]?.timestamp.toISOString()
  );
  const lastUpdatedAt = dateOrFallback(
    stringField(topicMetadata?.updatedAt) ||
    stringField(topic.updatedAt) ||
    messages[messages.length - 1]?.timestamp.toISOString() ||
    timestamp.toISOString()
  );
  const title = titleFromTopic(topicMetadata ?? topic, messages, topicId);

  return {
    id: `indexeddb:${topicId}`,
    index: 0,
    title,
    createdAt: timestamp,
    lastUpdatedAt,
    messageCount: messages.length,
    messages,
    workspaceId: "cherry-studio-indexeddb",
    workspacePath: `IndexedDB/topics/${topicId}`,
    source: "cherry-studio",
    metadata: {
      cherryStudio: {
        kind: "indexeddb-topic",
        topicId,
        topicName: stringField(topicMetadata?.name),
        assistantId: stringField(topicMetadata?.assistantId),
        assistantName: stringField(topicMetadata?.assistantName),
        isNameManuallyEdited: typeof topicMetadata?.isNameManuallyEdited === "boolean"
          ? topicMetadata.isNameManuallyEdited
          : undefined,
        indexedDbPath: snapshot.indexedDbPath,
      },
    },
  };
}

function messageFromRaw(
  snapshot: CherryIndexedDbSnapshot,
  topicId: string,
  raw: RawRecord,
  index: number
): Message | null {
  const id = stringField(raw.id) || `${topicId}-${index + 1}`;
  const orderedBlocks = blocksForMessage(snapshot, raw);
  const content = contentFromBlocks(orderedBlocks) || stringField(raw.content) || "";
  const timestamp = dateOrFallback(stringField(raw.createdAt) || stringField(raw.updatedAt));
  const role = roleFromRaw(raw.role);
  const model = modelName(raw.model) || stringField(raw.modelId);
  return {
    id,
    role,
    content,
    timestamp,
    codeBlocks: extractCodeBlocks(content),
    model: role === "assistant" ? model : undefined,
    tokenUsage: tokenUsage(raw.usage),
    metadata: {
      cherryMessageMetadata: {
        topicId,
        status: stringField(raw.status),
        type: stringField(raw.type),
        blockCount: orderedBlocks.length,
        missingBlocks: missingBlockCount(snapshot, raw),
      },
    },
  };
}

function blocksForMessage(snapshot: CherryIndexedDbSnapshot, raw: RawRecord): RawRecord[] {
  const blockIds = Array.isArray(raw.blocks)
    ? raw.blocks.map((id) => stringField(id)).filter((id): id is string => Boolean(id))
    : [];
  if (blockIds.length > 0) {
    return blockIds
      .map((id) => snapshot.blockById.get(id))
      .filter((block): block is RawRecord => Boolean(block));
  }
  const messageId = stringField(raw.id);
  return messageId ? snapshot.blocksByMessageId.get(messageId) ?? [] : [];
}

function contentFromBlocks(blocks: RawRecord[]): string {
  const mainText = blocks
    .filter((block) => stringField(block.type) === "main_text")
    .map((block) => stringField(block.content))
    .filter((content): content is string => Boolean(content?.trim()));
  if (mainText.length > 0) return mainText.join("\n\n").trim();

  return blocks
    .map((block) => stringField(block.content))
    .filter((content): content is string => Boolean(content?.trim()))
    .join("\n\n")
    .trim();
}

function missingBlockCount(snapshot: CherryIndexedDbSnapshot, raw: RawRecord): number {
  if (!Array.isArray(raw.blocks)) return 0;
  return raw.blocks
    .map((id) => stringField(id))
    .filter((id): id is string => Boolean(id))
    .filter((id) => !snapshot.blockById.has(id))
    .length;
}

function titleFromTopic(topic: RawRecord, messages: Message[], topicId: string): string {
  const topicName = stringField(topic.name);
  if (topicName) return truncate(topicName, 120);
  return titleFromMessages(messages, topicId);
}

function titleFromMessages(messages: Message[], topicId: string): string {
  const firstUser = messages.find((message) => message.role === "user" && message.content.trim());
  const firstMessage = firstUser ?? messages.find((message) => message.content.trim());
  const title = firstMessage?.content.trim().split(/\r?\n/)[0]?.trim() ?? "";
  return truncate(title.replace(/^#+\s*/, ""), 80) || `Cherry topic ${topicId.slice(0, 8)}`;
}

function summaryFromSession(session: ChatSession): ChatSessionSummary {
  return {
    id: session.id,
    index: session.index,
    title: session.title,
    createdAt: session.createdAt,
    lastUpdatedAt: session.lastUpdatedAt,
    messageCount: session.messageCount,
    workspaceId: session.workspaceId,
    workspacePath: session.workspacePath ?? "",
    preview: session.messages.find((message) => message.content.trim())?.content.slice(0, 240) ?? "",
    source: "cherry-studio",
    metadata: session.metadata,
  };
}

function roleFromRaw(value: unknown): MessageRole {
  return value === "user" ? "user" : "assistant";
}

function tokenUsage(value: unknown): Message["tokenUsage"] {
  if (!isRecord(value)) return undefined;
  const input = numberField(value.promptTokens) ?? numberField(value.inputTokens) ?? numberField(value.prompt_tokens);
  const output = numberField(value.completionTokens) ?? numberField(value.outputTokens) ?? numberField(value.completion_tokens);
  const total = numberField(value.totalTokens) ?? numberField(value.total_tokens);
  if (input == null && output == null && total == null) return undefined;
  return {
    inputTokens: input ?? 0,
    outputTokens: output ?? total ?? 0,
  };
}

function modelName(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  return stringField(value.name) || stringField(value.id);
}

function warningsFromStores(stores: string[]): string[] {
  const warnings: string[] = [];
  if (!stores.includes("topics")) warnings.push("CherryStudio IndexedDB store missing: topics");
  if (!stores.includes("message_blocks")) warnings.push("CherryStudio IndexedDB store missing: message_blocks");
  return warnings;
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function numberField(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isRecord(value: unknown): value is RawRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function dateOrFallback(value: string | undefined): Date {
  const date = value ? new Date(value) : new Date(0);
  return Number.isNaN(date.getTime()) ? new Date(0) : date;
}

function extractCodeBlocks(content: string): Message["codeBlocks"] {
  const blocks: Message["codeBlocks"] = [];
  const re = /```([^\n`]*)\n([\s\S]*?)```/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(content))) {
    blocks.push({
      language: match[1]?.trim() || null,
      content: match[2] ?? "",
      startLine: content.slice(0, match.index).split("\n").length,
    });
  }
  return blocks;
}

function truncate(value: string, maxChars: number): string {
  return value.length > maxChars ? `${value.slice(0, Math.max(0, maxChars - 3))}...` : value;
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.split(/\r?\n/).slice(0, 4).join("\n").slice(0, 1000);
}
