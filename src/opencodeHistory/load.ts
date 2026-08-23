import { existsSync } from "node:fs";
import { sessionSummaryToJson } from "../cursorHistory/json.js";
import type { ChatSessionSummary } from "../cursorHistory/types.js";
import { diagnosticFromError, type OpencodeDiagnostic } from "./errors.js";
import {
  extractOpencodeUserMessage,
  groupRawPartsByMessage,
} from "./myMessages.js";
import { buildOpencodeSession } from "./normalize.js";
import { opencodeDbPath, resolveOpencodeDataDir } from "./paths.js";
import {
  getSessionRowFromDb,
  listProjectsFromDb,
  listSessionRowsFromDb,
  loadSessionMessagesAndParts,
  openOpencodeDb,
} from "./stateDb.js";
import type {
  BuiltOpencodeSession,
  OpencodeListFilters,
  OpencodeListResult,
  OpencodeProjectsResult,
  OpencodeSessionRow,
} from "./types.js";

function summaryFromRow(
  row: OpencodeSessionRow,
  humanMessageCount = 0
): ChatSessionSummary {
  return {
    id: row.id,
    index: 0,
    title: row.title || "无标题会话",
    createdAt: row.createdAt,
    lastUpdatedAt: row.lastUpdatedAt,
    // 真人提问条数,取自 `opencode_session`(V58)—— 与 kimi 同口径,不是消息总数。
    // 原先写死 0 是因为「列表不读 message,避免 N+1」;有了自己的表之后
    // 那个顾虑消失了,ingest 已经数好存下。拿不到 index.db 时仍退回 0。
    messageCount: humanMessageCount,
    workspaceId: row.projectId,
    workspacePath: row.directory,
    preview: "",
    source: "opencode",
    metadata: {
      opencode: {
        directory: row.directory,
        agent: row.agent,
        model: row.model,
        archived: row.archived,
        tokensInput: row.tokensInput,
        tokensOutput: row.tokensOutput,
        cost: row.cost,
      },
    },
  };
}

export async function listOpencodeProjects(
  rawDataDir: string | undefined,
  filters: Pick<OpencodeListFilters, "archived">
): Promise<OpencodeProjectsResult> {
  const dataDir = resolveOpencodeDataDir(rawDataDir);
  const dbPath = opencodeDbPath(dataDir);
  const diagnostics: OpencodeDiagnostic[] = [];

  if (!existsSync(dbPath)) {
    return {
      ok: true,
      source: "sqlite",
      dbPath,
      diagnostics: [{ kind: "db-not-found", message: "opencode.db not found", path: dbPath }],
      projects: [],
    };
  }

  let db;
  try {
    db = openOpencodeDb(dbPath);
    const projects = listProjectsFromDb(db, dbPath, filters);
    return { ok: true, source: "sqlite", dbPath, diagnostics, projects };
  } catch (e) {
    diagnostics.push(diagnosticFromError(e));
    return { ok: true, source: "sqlite", dbPath, diagnostics, projects: [] };
  } finally {
    db?.close();
  }
}

/** 从 index.db 取每场的真人提问数。表不在或没给 db → 空 Map,列表退回 0。 */
function humanCountsFromIndex(indexDb: unknown): Map<string, number> {
  const out = new Map<string, number>();
  const db = indexDb as { prepare?: (sql: string) => { all: () => unknown[] } } | undefined;
  if (!db?.prepare) return out;
  try {
    const rows = db
      .prepare("SELECT session_id AS id, human_message_count AS n FROM opencode_session")
      .all() as { id: string; n: number }[];
    for (const r of rows) out.set(r.id, r.n);
  } catch {
    // 旧库没有这张表 —— 退回 0,不崩。
  }
  return out;
}

export async function listOpencodeSessionSummaries(
  rawDataDir: string | undefined,
  filters: OpencodeListFilters
): Promise<OpencodeListResult> {
  const counts = humanCountsFromIndex(filters.indexDb);
  const dataDir = resolveOpencodeDataDir(rawDataDir);
  const dbPath = opencodeDbPath(dataDir);
  const diagnostics: OpencodeDiagnostic[] = [];

  if (!existsSync(dbPath)) {
    return {
      ok: true,
      source: "sqlite",
      dbPath,
      diagnostics: [{ kind: "db-not-found", message: "opencode.db not found", path: dbPath }],
      sessions: [],
    };
  }

  let db;
  try {
    db = openOpencodeDb(dbPath);
    const rows = listSessionRowsFromDb(db, dbPath, filters);
    return {
      ok: true,
      source: "sqlite",
      dbPath,
      diagnostics,
      sessions: rows.map((r) => summaryFromRow(r, counts.get(r.id) ?? 0)),
    };
  } catch (e) {
    diagnostics.push(diagnosticFromError(e));
    return { ok: true, source: "sqlite", dbPath, diagnostics, sessions: [] };
  } finally {
    db?.close();
  }
}

export async function loadOpencodeSessionDetail(
  rawDataDir: string | undefined,
  sessionId: string
): Promise<BuiltOpencodeSession | null> {
  const dataDir = resolveOpencodeDataDir(rawDataDir);
  const dbPath = opencodeDbPath(dataDir);
  if (!existsSync(dbPath)) return null;

  let db;
  try {
    db = openOpencodeDb(dbPath);
    const row = getSessionRowFromDb(db, dbPath, sessionId);
    if (!row) return null;
    const { messages, parts } = loadSessionMessagesAndParts(db, dbPath, sessionId);
    return buildOpencodeSession({ row, messages, parts });
  } finally {
    db?.close();
  }
}

export function opencodeSessionSummaryToJson(s: ChatSessionSummary) {
  return sessionSummaryToJson(s);
}

export type OpencodeMyMessage = {
  id: string;
  timestamp: string;
  /** 已过滤注入的「我的输入」;斜杠命令已由 cleaner 压成紧凑 `/名字`。 */
  text: string;
};

/**
 * 「我的输入(已过滤注入)」—— projection over 同一 loader。复用 loadSessionMessagesAndParts
 * (同只读快照,part.data 带 metadata/synthetic),对每条 user message 跑清洗,非空才产出。
 * 找不到 session → null;库不存在 → null。
 */
export async function loadOpencodeMyMessages(
  rawDataDir: string | undefined,
  sessionId: string
): Promise<OpencodeMyMessage[] | null> {
  const dataDir = resolveOpencodeDataDir(rawDataDir);
  const dbPath = opencodeDbPath(dataDir);
  if (!existsSync(dbPath)) return null;

  let db;
  try {
    db = openOpencodeDb(dbPath);
    const row = getSessionRowFromDb(db, dbPath, sessionId);
    if (!row) return null;
    const { messages, parts } = loadSessionMessagesAndParts(db, dbPath, sessionId);
    const byMsg = groupRawPartsByMessage(parts);

    const out: OpencodeMyMessage[] = [];
    for (const m of messages) {
      // 共享 extractor 内含 role 门 + 清洗 + 时间解析(与 ingest 同一口径)。
      const ex = extractOpencodeUserMessage(m, byMsg.get(m.id) ?? []);
      if (!ex || !ex.cleanedText) continue;
      out.push({
        id: m.id,
        timestamp: new Date(ex.eventAtMs).toISOString(),
        text: ex.cleanedText, // 斜杠命令已由 cleaner 压成紧凑 /名字
      });
    }
    return out;
  } finally {
    db?.close();
  }
}
