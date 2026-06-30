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

/**
 * 构造 threads 的 WHERE 子句。projects 与 sessions 共用,保证两端过滤语义一致。
 * - **cwd(D3)**:用 `rtrim(.,'/')` 两端归一化匹配,避免 `/repo` 与 `/repo/` 因尾
 *   斜杠被当成不同项目 / 查不到。左栏项目 key 也用同一 `rtrim`,契约才闭合。
 * - **archived(D4,include 语义)**:`archived` 为真 = 「包含已归档」→ 不加任何
 *   archived 约束(已归档+未归档全显);为假 → 只未归档。修掉旧的 `archived = @archived`
 *   精确匹配(那会让「包含已归档」反而只显已归档)。
 */
export function buildThreadsWhere(
  filters: Pick<CodexListFilters, "cwd" | "gitBranch" | "model" | "archived">
): { where: string[]; params: Record<string, unknown> } {
  const where: string[] = [];
  const params: Record<string, unknown> = {};

  if (!filters.archived) {
    where.push("archived = 0");
  }
  if (filters.cwd?.trim()) {
    where.push("rtrim(cwd, '/') = rtrim(@cwd, '/')");
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
  // 全包含(无任何过滤)时 where 为空,补恒真避免 `WHERE ` 语法错误。
  if (where.length === 0) {
    where.push("1 = 1");
  }
  return { where, params };
}

export function listThreadsFromStateDb(
  db: Database.Database,
  dbPath: string,
  filters: CodexListFilters
): CodexThreadRow[] {
  assertThreadsSchema(db, dbPath);
  const { where, params } = buildThreadsWhere(filters);

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

export function listAllThreadsFromStateDb(
  db: Database.Database,
  dbPath: string,
  filters: Omit<CodexListFilters, "limit" | "maxFiles">
): CodexThreadRow[] {
  assertThreadsSchema(db, dbPath);
  const { where, params } = buildThreadsWhere(filters);

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

export type CodexProjectAggRow = {
  /** 归一化项目 key:`rtrim(cwd,'/')`;根 `/` 保护回 `/`;空串=未知项目。 */
  proj: string;
  sessionCount: number;
  lastUpdatedAt: Date;
};

/**
 * 按归一化 cwd 聚合出「项目」列表(左栏)。D1:只受 archived 影响,不接 branch/model。
 * SQL 端 GROUP BY,不把全量行拉到 JS。归一化与 session 端的 `rtrim` 完全一致(D3)。
 * 根 `/`(rtrim 后为空但 cwd 非空)保护回 `/`,与真正的空 cwd(未知项目)区分。
 */
export function listCodexProjectsFromStateDb(
  db: Database.Database,
  dbPath: string,
  filters: Pick<CodexListFilters, "archived">
): CodexProjectAggRow[] {
  assertThreadsSchema(db, dbPath);
  const { where, params } = buildThreadsWhere(filters);
  const sql = `
    SELECT
      CASE WHEN trim(cwd) = '' THEN ''
           WHEN rtrim(cwd, '/') = '' THEN '/'
           ELSE rtrim(cwd, '/') END AS proj,
      COUNT(*) AS sessionCount,
      MAX(COALESCE(updated_at_ms, updated_at * 1000)) AS lastMs
    FROM threads
    WHERE ${where.join(" AND ")}
    GROUP BY proj
    ORDER BY lastMs DESC, proj ASC
  `;
  let rows: Record<string, unknown>[];
  try {
    rows = db.prepare(sql).all(params) as Record<string, unknown>[];
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new CodexHistoryError("schema-incompatible", msg, dbPath);
  }
  return rows.map((r) => ({
    proj: String(r.proj ?? ""),
    sessionCount: Number(r.sessionCount ?? 0),
    lastUpdatedAt: dateFromMsOrSeconds(r.lastMs, null),
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
