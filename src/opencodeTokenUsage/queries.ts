import type Database from "better-sqlite3";
import { existsSync } from "node:fs";
import { canonicalizePath } from "../path/canonical.js";
import { openOpencodeDb } from "../opencodeHistory/stateDb.js";
import { opencodeDbPath, resolveOpencodeDataDir } from "../opencodeHistory/paths.js";
import type { OpencodeProjectTokenUsage, OpencodeTokenUsageStatus } from "./types.js";

/** opencode 的 token 列（旧 schema 可能缺）。 */
const TOKEN_COLS = ["tokens_input", "tokens_output"] as const;

function hasTokenColumns(db: Database.Database): boolean {
  const have = new Set(
    (db.prepare(`PRAGMA table_info("session")`).all() as { name?: string }[])
      .map((r) => r.name)
      .filter(Boolean) as string[]
  );
  return TOKEN_COLS.every((c) => have.has(c));
}

/** project_key 与 claude/codex 同口径：canonicalizePath(directory, bestEffort)。 */
function projectKeyFromDirectory(directory: string): string | null {
  const trimmed = directory.trim();
  if (!trimmed) return null;
  return canonicalizePath(trimmed, { bestEffort: true }) ?? trimmed;
}

/**
 * 按 project(= canonicalizePath(session.directory)) 聚合 opencode 的 token。
 * - 排除已归档 session（time_archived IS NULL），与 opencode 列表口径一致。
 * - token 列缺失(旧 schema) → 返回空 Map（opencode 不贡献 token；诊断走 getOpencodeTokenUsageStatus）。
 * - SQL 按原始 directory 聚合，JS 再 canonicalize + 按 key 合并（realpathSync 不能进 SQL），
 *   最后按请求的 projectKeys 过滤。
 */
export function listOpencodeProjectTokenUsage(
  rawDataDir: string | undefined,
  args: { projectKeys?: string[]; from?: Date | null }
): Map<string, OpencodeProjectTokenUsage> {
  const out = new Map<string, OpencodeProjectTokenUsage>();
  const dbPath = opencodeDbPath(resolveOpencodeDataDir(rawDataDir));
  if (!existsSync(dbPath)) return out;

  let db: Database.Database | undefined;
  try {
    db = openOpencodeDb(dbPath);
    if (!hasTokenColumns(db)) return out; // 缺列 → 空（coverage unknown 由 status 报）
    const clauses = ["time_archived IS NULL"];
    const params: unknown[] = [];
    if (args.from) {
      clauses.push("time_updated >= ?");
      params.push(args.from.getTime());
    }
    const rows = db
      .prepare(
        `SELECT directory,
                COALESCE(SUM(tokens_input), 0) AS inputTokens,
                COALESCE(SUM(tokens_output), 0) AS outputTokens,
                COUNT(*) AS totalSessions
         FROM session
         WHERE ${clauses.join(" AND ")}
         GROUP BY directory`
      )
      .all(...params) as Array<{
        directory: string;
        inputTokens: number;
        outputTokens: number;
        totalSessions: number;
      }>;

    const wanted = args.projectKeys && args.projectKeys.length > 0 ? new Set(args.projectKeys) : null;
    for (const row of rows) {
      const key = projectKeyFromDirectory(String(row.directory ?? ""));
      if (!key) continue;
      const prev = out.get(key);
      const input = prev ? prev.inputTokens + row.inputTokens : row.inputTokens;
      const output = prev ? prev.outputTokens + row.outputTokens : row.outputTokens;
      const totalSessions = (prev?.totalSessions ?? 0) + row.totalSessions;
      out.set(key, {
        projectKey: key,
        projectPath: prev?.projectPath ?? key,
        inputTokens: input,
        outputTokens: output,
        totalTokens: input + output,
        coveredSessions: totalSessions, // 列都在 → 每条都算覆盖
        totalSessions,
        errorSessions: 0,
        coverage: "full",
      });
    }
    if (wanted) {
      for (const key of [...out.keys()]) if (!wanted.has(key)) out.delete(key);
    }
    return out;
  } catch {
    return out; // 打不开/查询失败 → 空（不崩，opencode 不贡献 token）
  } finally {
    db?.close();
  }
}

/** opencode 无 refresh；token 列在 → fresh；缺列 → 报 stale（触发看板诊断）。 */
export function getOpencodeTokenUsageStatus(
  rawDataDir: string | undefined
): OpencodeTokenUsageStatus {
  const dbPath = opencodeDbPath(resolveOpencodeDataDir(rawDataDir));
  // No opencode.db = user doesn't use opencode. That's absence, not staleness —
  // report fresh so the dashboard doesn't warn. Reserve stale for real problems
  // (e.g. missing token columns on an existing db).
  if (!existsSync(dbPath)) return { fresh: true, staleReasons: [] };
  let db: Database.Database | undefined;
  try {
    db = openOpencodeDb(dbPath);
    if (!hasTokenColumns(db)) {
      return { fresh: false, staleReasons: ["opencode.db session table missing token columns"] };
    }
    return { fresh: true, staleReasons: [] };
  } catch (e) {
    return { fresh: false, staleReasons: [e instanceof Error ? e.message : String(e)] };
  } finally {
    db?.close();
  }
}
