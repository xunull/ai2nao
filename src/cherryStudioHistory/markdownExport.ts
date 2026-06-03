import { existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import type {
  ChatSession,
  ChatSessionSummary,
  Message,
  MessageRole,
} from "../cursorHistory/types.js";

export type CherryMarkdownListOptions = {
  maxFiles?: number;
  maxBytes?: number;
};

export type CherryMarkdownListResult = {
  sessions: ChatSessionSummary[];
  warnings: string[];
  scannedCount: number;
  truncated: boolean;
};

export type CherryMarkdownLoadResult = {
  session: ChatSession;
  warnings: string[];
};

const DEFAULT_MAX_FILES = 500;
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;

type MarkdownFile = {
  filePath: string;
  id: string;
  mtimeMs: number;
};

export async function listCherryMarkdownSessions(
  exportRoot: string | undefined,
  options: CherryMarkdownListOptions = {}
): Promise<CherryMarkdownListResult> {
  if (!exportRoot || !existsSync(exportRoot)) {
    return {
      sessions: [],
      warnings: exportRoot ? [`export root not found: ${exportRoot}`] : ["export root not configured"],
      scannedCount: 0,
      truncated: false,
    };
  }

  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
  const files = await listMarkdownFiles(exportRoot, maxFiles);
  const warnings: string[] = [];
  const sessions: ChatSessionSummary[] = [];

  for (const file of files.files) {
    try {
      const loaded = await loadCherryMarkdownSession(exportRoot, file.id, options);
      sessions.push(summaryFromSession(loaded.session));
      warnings.push(...loaded.warnings);
    } catch (e) {
      warnings.push(`${relative(exportRoot, file.filePath)}: ${errorMessage(e)}`);
    }
  }

  sessions.sort(
    (a, b) =>
      b.lastUpdatedAt.getTime() - a.lastUpdatedAt.getTime() ||
      a.id.localeCompare(b.id)
  );
  sessions.forEach((s, i) => {
    s.index = i + 1;
  });

  return {
    sessions,
    warnings,
    scannedCount: files.scannedCount,
    truncated: files.truncated,
  };
}

export async function loadCherryMarkdownSession(
  exportRoot: string,
  id: string,
  options: CherryMarkdownListOptions = {}
): Promise<CherryMarkdownLoadResult> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const files = await listMarkdownFiles(exportRoot, options.maxFiles ?? DEFAULT_MAX_FILES);
  const hit = files.files.find((file) => file.id === id);
  if (!hit) throw new Error("Cherry Studio export session not found");

  const st = await stat(hit.filePath);
  if (st.size > maxBytes) {
    return {
      session: emptySessionFromFile(exportRoot, hit, "(文件过大)"),
      warnings: [`${relative(exportRoot, hit.filePath)} exceeds ${maxBytes} bytes`],
    };
  }

  const text = await readFile(hit.filePath, "utf8");
  return {
    session: sessionFromMarkdown(exportRoot, hit, text),
    warnings: [],
  };
}

async function listMarkdownFiles(
  exportRoot: string,
  maxFiles: number
): Promise<{ files: MarkdownFile[]; scannedCount: number; truncated: boolean }> {
  const root = exportRoot;
  const found: MarkdownFile[] = [];
  let scannedCount = 0;
  let truncated = false;

  async function walk(dir: string): Promise<void> {
    if (found.length >= maxFiles) {
      truncated = true;
      return;
    }
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (found.length >= maxFiles) {
        truncated = true;
        return;
      }
      if (entry.name.startsWith(".")) continue;
      const filePath = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(filePath);
        continue;
      }
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".md")) continue;
      scannedCount += 1;
      const st = await stat(filePath);
      const rel = relative(root, filePath);
      found.push({
        filePath,
        id: `export:${encodeURIComponent(rel)}`,
        mtimeMs: st.mtimeMs,
      });
    }
  }

  await walk(root);
  return { files: found, scannedCount, truncated };
}

function sessionFromMarkdown(exportRoot: string, file: MarkdownFile, text: string): ChatSession {
  const title = markdownTitle(text) || titleFromFile(file.filePath);
  const timestamp = new Date(file.mtimeMs);
  const messages = parseMessages(text, timestamp);
  return {
    id: file.id,
    index: 0,
    title,
    createdAt: messages[0]?.timestamp ?? timestamp,
    lastUpdatedAt: messages[messages.length - 1]?.timestamp ?? timestamp,
    messageCount: messages.length,
    messages,
    workspaceId: "cherry-studio-export",
    workspacePath: relative(exportRoot, file.filePath),
    source: "cherry-studio",
    metadata: {
      cherryStudio: {
        kind: "markdown-export",
        filePath: file.filePath,
      },
    },
  };
}

function emptySessionFromFile(exportRoot: string, file: MarkdownFile, title: string): ChatSession {
  const timestamp = new Date(file.mtimeMs);
  return {
    id: file.id,
    index: 0,
    title,
    createdAt: timestamp,
    lastUpdatedAt: timestamp,
    messageCount: 0,
    messages: [],
    workspaceId: "cherry-studio-export",
    workspacePath: relative(exportRoot, file.filePath),
    source: "cherry-studio",
    metadata: {
      cherryStudio: {
        kind: "markdown-export",
        filePath: file.filePath,
      },
    },
  };
}

function parseMessages(text: string, timestamp: Date): Message[] {
  const lines = text.split(/\r?\n/);
  const messages: Message[] = [];
  let current: { role: MessageRole; heading: string; lines: string[] } | undefined;

  function flush() {
    if (!current) return;
    const content = trimSeparators(current.lines.join("\n"));
    if (content.trim().length === 0) {
      current = undefined;
      return;
    }
    messages.push({
      id: `m-${messages.length + 1}`,
      role: current.role,
      content,
      timestamp: new Date(timestamp.getTime() + messages.length),
      codeBlocks: extractCodeBlocks(content),
      metadata: {
        cherryRoleHeading: current.heading,
      },
    });
    current = undefined;
  }

  for (const line of lines) {
    const match = line.match(/^##\s+(.+?)\s*$/);
    if (match) {
      const role = roleFromHeading(match[1]);
      if (role) {
        flush();
        current = { role, heading: match[1], lines: [] };
        continue;
      }
    }
    if (current) current.lines.push(line);
  }
  flush();

  return messages;
}

function markdownTitle(text: string): string | null {
  const line = text.split(/\r?\n/).find((candidate) => candidate.trim().startsWith("# "));
  const clean = line?.replace(/^#\s+/, "").trim();
  return clean || null;
}

function titleFromFile(filePath: string): string {
  const name = basename(filePath).replace(/\.md$/i, "").trim();
  return name || "Cherry Studio 导出";
}

function roleFromHeading(raw: string): MessageRole | null {
  const lower = raw.toLowerCase();
  if (lower.includes("user") || raw.includes("用户") || raw.includes("🧑")) return "user";
  if (lower.includes("assistant") || raw.includes("助手") || raw.includes("🤖")) return "assistant";
  return null;
}

function trimSeparators(value: string): string {
  return value
    .replace(/^\s*---\s*/g, "")
    .replace(/\s*---\s*$/g, "")
    .trim();
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
    preview: session.messages[0]?.content.slice(0, 240) ?? "",
    source: "cherry-studio",
    metadata: session.metadata,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
