import BetterSqlite from "better-sqlite3";
import type Database from "better-sqlite3";
import { existsSync } from "node:fs";
import { HermesHistoryError, classifySqliteOpenError } from "./errors.js";
import {
  assistantText,
  attachToolResults,
  isoFromEpochSeconds,
  normalizeOrigin,
  parseToolCalls,
  resolveTitle,
} from "./normalize.js";
import type {
  HermesMessage,
  HermesSessionDetail,
  HermesSessionSummary,
} from "./types.js";

/**
 * 关键表 → 必备列。hermes 自带 schema 版本(实测 schema_version = 26)且
 * `sessions` 有 56 列,只断言我们真正读的那些;缺任一就报 schema-incompatible,
 * 由调用方降级 —— **不崩、不影响其它六个源**。
 */
const REQUIRED: Record<string, readonly string[]> = {
  sessions: [
    "id",
    "source",
    "model",
    "started_at",
    "ended_at",
    "end_reason",
    "title",
    "message_count",
    "tool_call_count",
    "input_tokens",
    "output_tokens",
    "cache_read_tokens",
  ],
  messages: [
    "id",
    "session_id",
    "role",
    "content",
    "reasoning_content",
    "tool_calls",
    "tool_call_id",
    "timestamp",
  ],
};

/**
 * 只读打开 state.db。库随 hermes gateway 运行处于活跃 WAL(实测有 3.6 MB 的 -wal),故:
 * - `readonly:true`(**不用 `immutable=1`**,否则可能读不到 WAL 里的最新提交)。
 * - `query_only = ON` 兜底防写。
 * - `busy_timeout` 让 checkpoint / 写入高峰下的只读查询等待而非立即失败。
 *
 * 与 `opencodeHistory/stateDb.ts` 的 `openOpencodeDb` 同一套家法。
 */
export function openHermesDb(dbPath: string): Database.Database {
  if (!existsSync(dbPath)) {
    throw new HermesHistoryError("db-not-found", "hermes state.db not found", dbPath);
  }
  let db: Database.Database;
  try {
    db = new BetterSqlite(dbPath, { readonly: true, fileMustExist: true });
  } catch (e) {
    throw classifySqliteOpenError(e, dbPath);
  }
  try {
    db.pragma("busy_timeout = 3000");
    db.pragma("query_only = ON");
  } catch {
    // pragma 失败不致命,忽略。
  }
  return db;
}

export function assertSchema(db: Database.Database, dbPath: string): void {
  for (const [table, cols] of Object.entries(REQUIRED)) {
    let rows: { name?: string }[];
    try {
      rows = db.prepare(`PRAGMA table_info("${table}")`).all() as { name?: string }[];
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new HermesHistoryError("schema-incompatible", msg, dbPath);
    }
    if (rows.length === 0) {
      throw new HermesHistoryError(
        "schema-incompatible",
        `missing required table: ${table}`,
        dbPath
      );
    }
    const have = new Set(rows.map((r) => r.name).filter(Boolean));
    for (const c of cols) {
      if (!have.has(c)) {
        throw new HermesHistoryError(
          "schema-incompatible",
          `missing required column: ${table}.${c}`,
          dbPath
        );
      }
    }
  }
}

type SessionRow = {
  id: string;
  source: string | null;
  model: string | null;
  started_at: number | null;
  ended_at: number | null;
  end_reason: string | null;
  title: string | null;
  message_count: number | null;
  tool_call_count: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  first_user_text: string | null;
};

const SESSION_SELECT = `
  SELECT s.id, s.source, s.model, s.started_at, s.ended_at, s.end_reason, s.title,
         s.message_count, s.tool_call_count,
         s.input_tokens, s.output_tokens, s.cache_read_tokens,
         (SELECT m.content FROM messages m
           WHERE m.session_id = s.id AND m.role = 'user'
             AND COALESCE(m.content,'') != ''
           ORDER BY m.timestamp ASC, m.id ASC LIMIT 1) AS first_user_text
    FROM sessions s`;

function toSummary(r: SessionRow): HermesSessionSummary {
  const { title, fallback } = resolveTitle(r.title, r.first_user_text);
  return {
    id: r.id,
    sourceRaw: r.source ?? "",
    origin: normalizeOrigin(r.source),
    title,
    titleFallback: fallback,
    model: r.model,
    startedAtIso: r.started_at == null ? null : isoFromEpochSeconds(r.started_at),
    endedAtIso: r.ended_at == null ? null : isoFromEpochSeconds(r.ended_at),
    endReason: r.end_reason,
    messageCount: r.message_count ?? 0,
    toolCallCount: r.tool_call_count ?? 0,
    inputTokens: r.input_tokens ?? 0,
    outputTokens: r.output_tokens ?? 0,
    cacheReadTokens: r.cache_read_tokens ?? 0,
  };
}

/** 列表页:全部会话,最近活跃在前。120 场量级,不分页。 */
export function listSessions(db: Database.Database): HermesSessionSummary[] {
  const rows = db
    .prepare(`${SESSION_SELECT} ORDER BY COALESCE(s.ended_at, s.started_at, 0) DESC, s.id ASC`)
    .all() as SessionRow[];
  return rows.map(toSummary);
}

type MessageRow = {
  id: number;
  session_id: string;
  role: string;
  content: string | null;
  reasoning_content: string | null;
  tool_calls: string | null;
  tool_call_id: string | null;
  timestamp: number | null;
};

const MESSAGE_SELECT = `
  SELECT id, session_id, role, content, reasoning_content,
         tool_calls, tool_call_id, timestamp
    FROM messages`;

/**
 * 把一个会话的原始消息行折成展示消息:
 * - `tool` 行按 `tool_call_id` 挂回宿主 assistant(真库 649/649 零孤儿)
 * - `session_meta` 丢弃(真库 11 条 content 全为 NULL),但报数
 */
export function foldMessages(rows: readonly MessageRow[]): {
  messages: HermesMessage[];
  metaSkipped: number;
} {
  const resultsByCallId = new Map<string, string>();
  let metaSkipped = 0;
  for (const r of rows) {
    if (r.role === "tool") {
      if (r.tool_call_id) resultsByCallId.set(r.tool_call_id, r.content ?? "");
    } else if (r.role === "session_meta") {
      metaSkipped++;
    }
  }

  const messages: HermesMessage[] = [];
  for (const r of rows) {
    if (r.role === "user") {
      messages.push({
        id: r.id,
        role: "user",
        eventAtIso: isoFromEpochSeconds(r.timestamp),
        text: (r.content ?? "").trim(),
        textKind: "content",
        toolCalls: [],
      });
    } else if (r.role === "assistant") {
      const calls = parseToolCalls(r.tool_calls);
      const { text, kind } = assistantText(r.content, r.reasoning_content, calls);
      messages.push({
        id: r.id,
        role: "assistant",
        eventAtIso: isoFromEpochSeconds(r.timestamp),
        text,
        textKind: kind,
        toolCalls: attachToolResults(calls, resultsByCallId),
      });
    }
  }
  return { messages, metaSkipped };
}

export function loadSession(
  db: Database.Database,
  sessionId: string
): HermesSessionDetail | null {
  const row = db.prepare(`${SESSION_SELECT} WHERE s.id = ? LIMIT 1`).get(sessionId) as
    | SessionRow
    | undefined;
  if (!row) return null;
  const msgs = db
    .prepare(`${MESSAGE_SELECT} WHERE session_id = ? ORDER BY timestamp ASC, id ASC`)
    .all(sessionId) as MessageRow[];
  const { messages, metaSkipped } = foldMessages(msgs);
  return { session: toSummary(row), messages, metaSkipped };
}

/** ingest 用:一次取全库消息,按会话分组。1537 条量级,不分批。 */
export function listAllMessagesForIngest(
  db: Database.Database
): Map<string, MessageRow[]> {
  const rows = db
    .prepare(`${MESSAGE_SELECT} ORDER BY session_id ASC, timestamp ASC, id ASC`)
    .all() as MessageRow[];
  const by = new Map<string, MessageRow[]>();
  for (const r of rows) {
    const list = by.get(r.session_id);
    if (list) list.push(r);
    else by.set(r.session_id, [r]);
  }
  return by;
}

export type { MessageRow };
