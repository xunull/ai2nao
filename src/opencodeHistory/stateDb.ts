import BetterSqlite from "better-sqlite3";
import type Database from "better-sqlite3";
import { existsSync } from "node:fs";
import { OpencodeHistoryError, classifySqliteOpenError } from "./errors.js";
import type {
  OpencodeListFilters,
  OpencodeProjectSummary,
  OpencodeSessionRow,
} from "./types.js";

// 关键表 → 必备列。opencode 迭代快(Drizzle 多次迁移),只断言我们真正读的列,
// 缺任一就报 schema-incompatible(由调用方降级，不崩、不影响其它 4 个源)。
const REQUIRED: Record<string, readonly string[]> = {
  project: ["id", "worktree", "name"],
  session: [
    "id",
    "project_id",
    "directory",
    "title",
    "time_created",
    "time_updated",
    "time_archived",
  ],
  message: ["id", "session_id", "time_created", "data"],
  part: ["id", "message_id", "session_id", "time_created", "data"],
};

function dateFromMs(ms: unknown): Date {
  if (typeof ms === "number" && Number.isFinite(ms) && ms > 0) return new Date(ms);
  return new Date(0);
}

/**
 * 只读打开 opencode.db。库随 opencode 运行处于活跃 WAL，故:
 * - `readonly:true`(不用 immutable=1，否则可能读不到 WAL 里的最新提交)。
 * - `query_only=ON` 兜底防写。
 * - `busy_timeout` 让 checkpoint / 写入高峰下的只读查询等待而非立即失败。
 */
export function openOpencodeDb(dbPath: string): Database.Database {
  if (!existsSync(dbPath)) {
    throw new OpencodeHistoryError("db-not-found", "opencode.db not found", dbPath);
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
    // pragma 失败不致命，忽略。
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
      throw new OpencodeHistoryError("schema-incompatible", msg, dbPath);
    }
    if (rows.length === 0) {
      throw new OpencodeHistoryError(
        "schema-incompatible",
        `missing required table: ${table}`,
        dbPath
      );
    }
    const have = new Set(rows.map((r) => r.name).filter(Boolean));
    for (const c of cols) {
      if (!have.has(c)) {
        throw new OpencodeHistoryError(
          "schema-incompatible",
          `table ${table} missing column: ${c}`,
          dbPath
        );
      }
    }
  }
}

/** archived = include 语义:真→不加约束(全显);假→只未归档(time_archived IS NULL)。 */
function archivedClause(archived: boolean | undefined): string {
  return archived ? "" : "AND s.time_archived IS NULL";
}

export function listProjectsFromDb(
  db: Database.Database,
  dbPath: string,
  filters: Pick<OpencodeListFilters, "archived">
): OpencodeProjectSummary[] {
  assertSchema(db, dbPath);
  const sql = `
    SELECT p.id AS id, p.worktree AS worktree, p.name AS name,
           COUNT(s.id) AS sessionCount,
           MAX(s.time_updated) AS lastMs
    FROM project p
    JOIN session s ON s.project_id = p.id
    WHERE 1=1 ${archivedClause(filters.archived)}
    GROUP BY p.id
    ORDER BY lastMs DESC, p.id ASC
  `;
  let rows: Record<string, unknown>[];
  try {
    rows = db.prepare(sql).all() as Record<string, unknown>[];
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new OpencodeHistoryError("schema-incompatible", msg, dbPath);
  }
  return rows.map((r) => {
    const worktree = String(r.worktree ?? "");
    const name =
      (typeof r.name === "string" && r.name.trim()) ||
      worktree.split("/").filter(Boolean).pop() ||
      worktree ||
      "(unknown)";
    return {
      id: String(r.id ?? ""),
      path: worktree,
      name,
      sessionCount: Number(r.sessionCount ?? 0),
      lastActiveAt: dateFromMs(r.lastMs).toISOString(),
    };
  });
}

function mapSessionRow(r: Record<string, unknown>): OpencodeSessionRow {
  let model: string | undefined;
  const rawModel = r.model;
  if (typeof rawModel === "string" && rawModel.trim()) {
    try {
      const m = JSON.parse(rawModel) as { id?: string; modelID?: string };
      model = m.id ?? m.modelID ?? undefined;
    } catch {
      model = rawModel;
    }
  }
  return {
    id: String(r.id ?? ""),
    projectId: String(r.project_id ?? ""),
    title: String(r.title ?? ""),
    directory: String(r.directory ?? ""),
    model,
    agent: typeof r.agent === "string" ? r.agent : undefined,
    archived: r.time_archived != null,
    createdAt: dateFromMs(r.time_created),
    lastUpdatedAt: dateFromMs(r.time_updated),
    tokensInput: Number(r.tokens_input ?? 0),
    tokensOutput: Number(r.tokens_output ?? 0),
    cost: Number(r.cost ?? 0),
  };
}

// session 表里 model/agent/tokens/cost 列在旧 schema 可能缺；动态探测，缺则不选。
function sessionSelectCols(db: Database.Database): string {
  const have = new Set(
    (db.prepare(`PRAGMA table_info("session")`).all() as { name?: string }[])
      .map((r) => r.name)
      .filter(Boolean) as string[]
  );
  const opt = (c: string) => (have.has(c) ? c : `NULL AS ${c}`);
  return [
    "id",
    "project_id",
    "directory",
    "title",
    opt("model"),
    opt("agent"),
    "time_created",
    "time_updated",
    "time_archived",
    opt("tokens_input"),
    opt("tokens_output"),
    opt("cost"),
  ].join(", ");
}

export function listSessionRowsFromDb(
  db: Database.Database,
  dbPath: string,
  filters: OpencodeListFilters
): OpencodeSessionRow[] {
  assertSchema(db, dbPath);
  const where: string[] = [];
  const params: Record<string, unknown> = {};
  if (filters.projectId?.trim()) {
    where.push("project_id = @projectId");
    params.projectId = filters.projectId.trim();
  }
  if (!filters.archived) where.push("time_archived IS NULL");
  if (filters.agent?.trim()) {
    where.push("agent = @agent");
    params.agent = filters.agent.trim();
  }
  if (where.length === 0) where.push("1=1");
  const limit = Math.min(Math.max(filters.limit ?? 200, 1), 1000);
  params.limit = limit;
  const sql = `
    SELECT ${sessionSelectCols(db)}
    FROM session
    WHERE ${where.join(" AND ")}
    ORDER BY time_updated DESC, id DESC
    LIMIT @limit
  `;
  let rows: Record<string, unknown>[];
  try {
    rows = db.prepare(sql).all(params) as Record<string, unknown>[];
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new OpencodeHistoryError("schema-incompatible", msg, dbPath);
  }
  return rows.map(mapSessionRow);
}

export function getSessionRowFromDb(
  db: Database.Database,
  dbPath: string,
  id: string
): OpencodeSessionRow | null {
  assertSchema(db, dbPath);
  const sql = `SELECT ${sessionSelectCols(db)} FROM session WHERE id = ? LIMIT 1`;
  let r: Record<string, unknown> | undefined;
  try {
    r = db.prepare(sql).get(id) as Record<string, unknown> | undefined;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new OpencodeHistoryError("schema-incompatible", msg, dbPath);
  }
  return r ? mapSessionRow(r) : null;
}

export type OpencodeRawMessage = { id: string; timeCreated: number; data: string };
export type OpencodeRawPart = { messageId: string; timeCreated: number; data: string };

/**
 * 在**同一只读事务**里取 session 的全部 message + part —— 保证一致快照,避免
 * opencode 正写入时中途插入造成孤儿 part / 缺 part / 错序(codex#2)。
 * 稳定排序:message 按 time_created,id;part 按 message_id,time_created,id(codex#3)。
 */
export function loadSessionMessagesAndParts(
  db: Database.Database,
  dbPath: string,
  sessionId: string
): { messages: OpencodeRawMessage[]; parts: OpencodeRawPart[] } {
  assertSchema(db, dbPath);
  const snapshot = db.transaction(() => {
    const messages = (
      db
        .prepare(
          `SELECT id, time_created AS t, data FROM message WHERE session_id = ? ORDER BY time_created, id`
        )
        .all(sessionId) as Record<string, unknown>[]
    ).map((r) => ({
      id: String(r.id ?? ""),
      timeCreated: Number(r.t ?? 0),
      data: String(r.data ?? ""),
    }));
    const parts = (
      db
        .prepare(
          `SELECT message_id AS mid, time_created AS t, data FROM part WHERE session_id = ? ORDER BY message_id, time_created, id`
        )
        .all(sessionId) as Record<string, unknown>[]
    ).map((r) => ({
      messageId: String(r.mid ?? ""),
      timeCreated: Number(r.t ?? 0),
      data: String(r.data ?? ""),
    }));
    return { messages, parts };
  });
  try {
    return snapshot();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new OpencodeHistoryError("schema-incompatible", msg, dbPath);
  }
}
