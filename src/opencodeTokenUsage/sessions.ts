import type Database from "better-sqlite3";
import { canonicalizePath } from "../path/canonical.js";

/**
 * `opencode_session`（V58）的写入端。
 *
 * 为什么需要它：V57 的事件表只有 `session_id`，而看板的一切聚合都按项目。
 * index.db 里唯一带 opencode 项目信息的是 `agent_user_messages.project`，
 * 但那是 slug（`/` → `-`），目录名本身带 `-` 的反解不回来。
 */

export type OpencodeSessionRow = {
  sessionId: string;
  directory: string;
  title: string | null;
  createdAtIso: string | null;
  lastUpdatedAtIso: string;
  archivedAtIso: string | null;
  humanMessageCount: number;
  totalMessageCount: number;
};

/**
 * `project_key` 与 claude/codex/kimi 同口径：`canonicalizePath(dir, {bestEffort})`。
 * 它要 `realpathSync`，进不了 SQL，所以在这里算好再存 —— 旧实现是在 JS 里
 * 每次查询现算，那意味着每次看板加载都要打开 3.2 GB 的外部库。
 */
export function projectKeyFromDirectory(directory: string): string | null {
  const trimmed = directory.trim();
  if (!trimmed) return null;
  return canonicalizePath(trimmed, { bestEffort: true }) ?? trimmed;
}

export function upsertOpencodeSessions(
  db: Database.Database,
  rows: OpencodeSessionRow[],
  nowIso: string
): number {
  if (rows.length === 0) return 0;
  const stmt = db.prepare(
    `INSERT INTO opencode_session
       (session_id, directory, project_key, project_path, title, created_at,
        last_updated_at, archived_at, human_message_count, total_message_count, updated_at)
     VALUES (@sessionId, @directory, @projectKey, @projectPath, @title, @createdAt,
             @lastUpdatedAt, @archivedAt, @humanMessageCount, @totalMessageCount, @now)
     ON CONFLICT(session_id) DO UPDATE SET
        directory = excluded.directory,
        project_key = excluded.project_key,
        project_path = excluded.project_path,
        title = excluded.title,
        created_at = excluded.created_at,
        last_updated_at = excluded.last_updated_at,
        archived_at = excluded.archived_at,
        human_message_count = excluded.human_message_count,
        total_message_count = excluded.total_message_count,
        updated_at = excluded.updated_at`
  );
  let written = 0;
  const run = db.transaction((batch: OpencodeSessionRow[]) => {
    for (const r of batch) {
      const key = projectKeyFromDirectory(r.directory);
      if (!key) continue; // 没有可用目录 → 进不了任何项目聚合,不写
      stmt.run({
        sessionId: r.sessionId,
        directory: r.directory,
        projectKey: key,
        projectPath: key,
        title: r.title,
        createdAt: r.createdAtIso,
        lastUpdatedAt: r.lastUpdatedAtIso,
        archivedAt: r.archivedAtIso,
        humanMessageCount: r.humanMessageCount,
        totalMessageCount: r.totalMessageCount,
        now: nowIso,
      });
      written++;
    }
  });
  run(rows);
  return written;
}
