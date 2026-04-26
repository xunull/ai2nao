import BetterSqlite from "better-sqlite3";
import type Database from "better-sqlite3";
import { existsSync } from "node:fs";
import {
  CodexHistoryError,
  classifySqliteOpenError,
} from "./errors.js";
import type { CodexListFilters, CodexThreadRow } from "./types.js";

const REQUIRED_THREAD_COLUMNS = [
  "id",
  "rollout_path",
  "created_at",
  "updated_at",
  "cwd",
  "title",
  "archived",
] as const;

function dateFromMsOrSeconds(ms: unknown, seconds: unknown): Date {
  if (typeof ms === "number" && Number.isFinite(ms) && ms > 0) {
    return new Date(ms);
  }
  if (typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0) {
    return new Date(seconds * 1000);
  }
  return new Date(0);
}

export function openCodexStateDb(dbPath: string): Database.Database {
  if (!existsSync(dbPath)) {
    throw new CodexHistoryError("state-db-unavailable", "state DB not found", dbPath);
  }
  try {
    return new BetterSqlite(dbPath, { readonly: true, fileMustExist: true });
  } catch (e) {
    throw classifySqliteOpenError(e, dbPath);
  }
}

export function assertThreadsSchema(db: Database.Database, dbPath: string): void {
  let rows: { name?: string }[];
  try {
    rows = db.prepare("PRAGMA table_info(threads)").all() as { name?: string }[];
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new CodexHistoryError("schema-incompatible", msg, dbPath);
  }
  const names = new Set(rows.map((r) => r.name).filter(Boolean));
  for (const col of REQUIRED_THREAD_COLUMNS) {
    if (!names.has(col)) {
      throw new CodexHistoryError(
        "schema-incompatible",
        `threads table missing required column: ${col}`,
        dbPath
      );
    }
  }
}

export function listThreadsFromStateDb(
  db: Database.Database,
  dbPath: string,
  filters: CodexListFilters
): CodexThreadRow[] {
  assertThreadsSchema(db, dbPath);
  const where: string[] = [];
  const params: Record<string, unknown> = {};

  where.push("archived = @archived");
  params.archived = filters.archived ? 1 : 0;

  if (filters.cwd?.trim()) {
    where.push("cwd = @cwd");
    params.cwd = filters.cwd.trim();
  }
  if (filters.gitBranch?.trim()) {
    where.push("git_branch = @gitBranch");
    params.gitBranch = filters.gitBranch.trim();
  }
  if (filters.model?.trim()) {
    where.push("model = @model");
    params.model = filters.model.trim();
  }

  const limit = Math.min(Math.max(filters.limit ?? 200, 1), 1000);
  params.limit = limit;

  const sql = `
    SELECT
      id,
      rollout_path AS rolloutPath,
      created_at AS createdAt,
      updated_at AS updatedAt,
      created_at_ms AS createdAtMs,
      updated_at_ms AS updatedAtMs,
      cwd,
      title,
      archived,
      git_branch AS gitBranch,
      model,
      first_user_message AS firstUserMessage
    FROM threads
    WHERE ${where.join(" AND ")}
    ORDER BY COALESCE(updated_at_ms, updated_at * 1000) DESC, id DESC
    LIMIT @limit
  `;

  let rows: Record<string, unknown>[];
  try {
    rows = db.prepare(sql).all(params) as Record<string, unknown>[];
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new CodexHistoryError("schema-incompatible", msg, dbPath);
  }

  return rows.map((r) => ({
    id: String(r.id ?? ""),
    rolloutPath: String(r.rolloutPath ?? ""),
    createdAt: dateFromMsOrSeconds(r.createdAtMs, r.createdAt),
    lastUpdatedAt: dateFromMsOrSeconds(r.updatedAtMs, r.updatedAt),
    title: String(r.title ?? ""),
    cwd: String(r.cwd ?? ""),
    archived: Boolean(r.archived),
    gitBranch: typeof r.gitBranch === "string" ? r.gitBranch : undefined,
    model: typeof r.model === "string" ? r.model : undefined,
    firstUserMessage:
      typeof r.firstUserMessage === "string" ? r.firstUserMessage : undefined,
  }));
}

export function getThreadFromStateDb(
  db: Database.Database,
  dbPath: string,
  sessionId: string
): CodexThreadRow | null {
  assertThreadsSchema(db, dbPath);
  let r: Record<string, unknown> | undefined;
  try {
    r = db
      .prepare(
        `
        SELECT
          id,
          rollout_path AS rolloutPath,
          created_at AS createdAt,
          updated_at AS updatedAt,
          created_at_ms AS createdAtMs,
          updated_at_ms AS updatedAtMs,
          cwd,
          title,
          archived,
          git_branch AS gitBranch,
          model,
          first_user_message AS firstUserMessage
        FROM threads
        WHERE id = ?
        LIMIT 1
      `
      )
      .get(sessionId) as Record<string, unknown> | undefined;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new CodexHistoryError("schema-incompatible", msg, dbPath);
  }
  if (!r) return null;
  return {
    id: String(r.id ?? ""),
    rolloutPath: String(r.rolloutPath ?? ""),
    createdAt: dateFromMsOrSeconds(r.createdAtMs, r.createdAt),
    lastUpdatedAt: dateFromMsOrSeconds(r.updatedAtMs, r.updatedAt),
    title: String(r.title ?? ""),
    cwd: String(r.cwd ?? ""),
    archived: Boolean(r.archived),
    gitBranch: typeof r.gitBranch === "string" ? r.gitBranch : undefined,
    model: typeof r.model === "string" ? r.model : undefined,
    firstUserMessage:
      typeof r.firstUserMessage === "string" ? r.firstUserMessage : undefined,
  };
}
