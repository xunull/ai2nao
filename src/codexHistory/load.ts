import { existsSync } from "node:fs";
import { open, readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { sessionSummaryToJson } from "../cursorHistory/json.js";
import type { ChatSessionSummary } from "../cursorHistory/types.js";
import { assertRealPathInsideRoot, isPathInsideRoot } from "../localJsonl/path.js";
import { parseJsonlText } from "../localJsonl/parse.js";
import {
  CODEX_PREVIEW_BYTES,
  MAX_CODEX_FALLBACK_FILES,
  MAX_CODEX_JSONL_BYTES,
  MAX_CODEX_JSONL_LINES,
} from "./constants.js";
import { listCodexTranscriptFiles } from "./discover.js";
import {
  CodexHistoryError,
  diagnosticFromError,
  type CodexDiagnostic,
} from "./errors.js";
import { buildCodexSession } from "./normalize.js";
import { codexSessionsRoot, codexStateDbPath, resolveCodexRoot } from "./paths.js";
import {
  getThreadFromStateDb,
  listThreadsFromStateDb,
  openCodexStateDb,
} from "./stateDb.js";
import type {
  BuiltCodexSession,
  CodexListFilters,
  CodexListResult,
  CodexThreadRow,
} from "./types.js";

function emptyMetricsMetadata(thread: CodexThreadRow, degraded?: CodexDiagnostic) {
  return {
    codex: {
      cwd: thread.cwd,
      gitBranch: thread.gitBranch,
      model: thread.model,
      archived: thread.archived,
      rolloutPath: thread.rolloutPath,
      degraded: Boolean(degraded),
      degradationReason: degraded?.kind,
      metrics: {
        toolCallCount: 0,
        commandCount: 0,
        failedCommandCount: 0,
        fileCount: 0,
      },
    },
  };
}

function summaryFromThread(
  thread: CodexThreadRow,
  degraded?: CodexDiagnostic
): ChatSessionSummary {
  const preview = thread.firstUserMessage?.trim() || thread.title || "(无用户消息)";
  return {
    id: thread.id,
    index: 0,
    title: thread.title || preview,
    createdAt: thread.createdAt,
    lastUpdatedAt: thread.lastUpdatedAt,
    messageCount: 0,
    workspaceId: thread.cwd,
    workspacePath: thread.cwd,
    preview,
    source: "codex",
    metadata: emptyMetricsMetadata(thread, degraded),
  };
}

async function resolveTranscriptPath(
  sessionsRoot: string,
  rolloutPath: string
): Promise<string> {
  const candidate = resolve(rolloutPath);
  if (!isPathInsideRoot(sessionsRoot, candidate)) {
    throw new CodexHistoryError(
      "transcript-missing",
      "rollout path is outside Codex sessions root",
      candidate
    );
  }
  if (!existsSync(candidate)) {
    throw new CodexHistoryError("transcript-missing", "transcript not found", candidate);
  }
  try {
    return await assertRealPathInsideRoot(sessionsRoot, candidate);
  } catch {
    throw new CodexHistoryError(
      "transcript-missing",
      "transcript realpath is outside Codex sessions root",
      candidate
    );
  }
}

async function readTranscriptText(filePath: string): Promise<{ text: string; mtimeMs: number }> {
  const st = await stat(filePath);
  if (st.size > MAX_CODEX_JSONL_BYTES) {
    throw new CodexHistoryError(
      "transcript-too-large",
      `transcript exceeds ${MAX_CODEX_JSONL_BYTES} bytes`,
      filePath
    );
  }
  const text = await readFile(filePath, "utf8");
  if (text.split("\n").length > MAX_CODEX_JSONL_LINES) {
    throw new CodexHistoryError(
      "transcript-too-large",
      `transcript exceeds ${MAX_CODEX_JSONL_LINES} lines`,
      filePath
    );
  }
  return { text, mtimeMs: st.mtimeMs };
}

async function previewSummaryFromFile(filePath: string, id: string): Promise<ChatSessionSummary> {
  const st = await stat(filePath);
  const size = Math.min(st.size, CODEX_PREVIEW_BYTES);
  const buf = Buffer.alloc(size);
  const fh = await open(filePath, "r");
  try {
    await fh.read(buf, 0, size, 0);
  } finally {
    await fh.close();
  }
  const text = buf.toString("utf8");
  const parse = parseJsonlText(text);
  const built = buildCodexSession({
    sessionId: id,
    parse,
    fileMtimeMs: st.mtimeMs,
    rolloutPath: filePath,
  });
  built.summary.messageCount = 0;
  return built.summary;
}

async function fallbackList(
  codexRoot: string,
  sessionsRoot: string,
  stateDbPath: string,
  diagnostics: CodexDiagnostic[],
  filters: CodexListFilters
): Promise<CodexListResult> {
  const { files, truncated, scannedCount } = await listCodexTranscriptFiles(sessionsRoot, {
    maxFiles: filters.maxFiles ?? MAX_CODEX_FALLBACK_FILES,
  });
  const sessions: ChatSessionSummary[] = [];
  for (const f of files.slice(0, filters.limit ?? 200)) {
    try {
      sessions.push(await previewSummaryFromFile(f.filePath, f.id));
    } catch (e) {
      sessions.push({
        id: f.id,
        index: 0,
        title: "(读取失败)",
        createdAt: new Date(f.mtimeMs),
        lastUpdatedAt: new Date(f.mtimeMs),
        messageCount: 0,
        workspaceId: "codex",
        workspacePath: "",
        preview: e instanceof Error ? e.message : "无法解析此会话文件",
        source: "codex",
      });
    }
  }
  sessions.forEach((s, i) => {
    s.index = i + 1;
  });
  return {
    ok: true,
    source: "fallback",
    codexRoot,
    sessionsRoot,
    stateDbPath,
    diagnostics,
    scannedCount,
    truncated,
    sessions,
  };
}

export async function listCodexSessionSummaries(
  rawCodexRoot: string | undefined,
  filters: CodexListFilters
): Promise<CodexListResult> {
  const codexRoot = resolveCodexRoot(rawCodexRoot);
  const sessionsRoot = codexSessionsRoot(codexRoot);
  const stateDbPath = codexStateDbPath(codexRoot);
  const diagnostics: CodexDiagnostic[] = [];

  if (!existsSync(codexRoot)) {
    diagnostics.push({
      kind: "root-not-found",
      message: "Codex root not found",
      path: codexRoot,
    });
    return fallbackList(codexRoot, sessionsRoot, stateDbPath, diagnostics, filters);
  }

  let db;
  try {
    db = openCodexStateDb(stateDbPath);
    const threads = listThreadsFromStateDb(db, stateDbPath, filters);
    const sessions: ChatSessionSummary[] = [];
    for (const thread of threads) {
      let degraded: CodexDiagnostic | undefined;
      try {
        await resolveTranscriptPath(sessionsRoot, thread.rolloutPath);
      } catch (e) {
        degraded = diagnosticFromError(e);
      }
      sessions.push(summaryFromThread(thread, degraded));
    }
    sessions.forEach((s, i) => {
      s.index = i + 1;
    });
    return {
      ok: true,
      source: "sqlite",
      codexRoot,
      sessionsRoot,
      stateDbPath,
      diagnostics,
      scannedCount: sessions.length,
      truncated: false,
      sessions,
    };
  } catch (e) {
    diagnostics.push(diagnosticFromError(e));
    return fallbackList(codexRoot, sessionsRoot, stateDbPath, diagnostics, filters);
  } finally {
    db?.close();
  }
}

async function findThreadById(
  stateDbPath: string,
  sessionId: string
): Promise<CodexThreadRow | null> {
  let db;
  try {
    db = openCodexStateDb(stateDbPath);
    return getThreadFromStateDb(db, stateDbPath, sessionId);
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

export async function loadCodexSessionDetail(
  rawCodexRoot: string | undefined,
  sessionId: string
): Promise<BuiltCodexSession | null> {
  const codexRoot = resolveCodexRoot(rawCodexRoot);
  const sessionsRoot = codexSessionsRoot(codexRoot);
  const stateDbPath = codexStateDbPath(codexRoot);
  const thread = await findThreadById(stateDbPath, sessionId);

  let filePath: string | null = null;
  let degraded: CodexDiagnostic | undefined;
  if (thread) {
    try {
      filePath = await resolveTranscriptPath(sessionsRoot, thread.rolloutPath);
    } catch (e) {
      degraded = diagnosticFromError(e);
    }
  }

  if (!filePath) {
    const { files } = await listCodexTranscriptFiles(sessionsRoot, {
      maxFiles: MAX_CODEX_FALLBACK_FILES,
    });
    const hit = files.find((f) => f.id === sessionId);
    if (!hit) {
      if (thread && degraded) {
        return buildCodexSession({
          sessionId,
          parse: { okLines: [], errors: [] },
          fileMtimeMs: thread.lastUpdatedAt.getTime(),
          thread,
          degraded: true,
          degradationReason: degraded.kind,
        });
      }
      return null;
    }
    filePath = hit.filePath;
  }

  const { text, mtimeMs } = await readTranscriptText(filePath);
  const parse = parseJsonlText(text);
  return buildCodexSession({
    sessionId,
    parse,
    fileMtimeMs: mtimeMs,
    thread: thread ?? undefined,
    rolloutPath: filePath,
    degraded: Boolean(degraded),
    degradationReason: degraded?.kind,
  });
}

export function codexSessionSummaryToJson(s: ChatSessionSummary) {
  return sessionSummaryToJson(s);
}
