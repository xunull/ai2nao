import type Database from "better-sqlite3";
import type { ProjectSessionTime } from "../claudeCodeHistory/projectLastActive.js";
import {
  CLAUDE_TOKEN_USAGE_RULE_VERSION,
  type ClaudeProjectTokenUsage,
  type ClaudeTokenStatus,
  type ClaudeTokenUsageRow,
  type ClaudeTokenUsageStateRow,
  type ClaudeTokenUsageStatus,
} from "./types.js";

export function getClaudeTokenUsageState(
  db: Database.Database
): ClaudeTokenUsageStateRow | null {
  return (
    db
      .prepare(
        `SELECT id, rule_version, last_rebuilt_at, last_error,
                source_session_count, indexed_session_count,
                token_known_session_count, token_unknown_session_count,
                error_session_count, skipped_unchanged_count,
                duration_ms, updated_at
         FROM claude_session_token_usage_state
         WHERE id = 1`
      )
      .get() as ClaudeTokenUsageStateRow | undefined
  ) ?? null;
}

export function getClaudeTokenUsageStatus(
  db: Database.Database
): ClaudeTokenUsageStatus {
  const state = getClaudeTokenUsageState(db);
  const staleReasons: string[] = [];
  if (!state) staleReasons.push("not_built");
  if (state && state.rule_version !== CLAUDE_TOKEN_USAGE_RULE_VERSION) {
    staleReasons.push("rule_version_mismatch");
  }
  if (state?.last_error) staleReasons.push("last_refresh_error");
  return { state, fresh: staleReasons.length === 0, staleReasons };
}

export function getClaudeTokenUsageRow(
  db: Database.Database,
  sessionId: string
): ClaudeTokenUsageRow | null {
  return (
    db
      .prepare(
        `SELECT session_id, project_id, file_path, file_mtime_ms, file_size_bytes,
                cwd, project_key, project_path, identity_confidence, title,
                created_at, last_updated_at, input_tokens, output_tokens,
                total_tokens, cache_read_input_tokens, cache_creation_input_tokens,
                model, token_status, parse_error, missing_since,
                source_seen_at, updated_at
         FROM claude_session_token_usage
         WHERE session_id = ?`
      )
      .get(sessionId) as ClaudeTokenUsageRow | undefined
  ) ?? null;
}

export function upsertClaudeTokenUsageRow(
  db: Database.Database,
  row: ClaudeTokenUsageRow
): void {
  db.prepare(
    `INSERT INTO claude_session_token_usage (
      session_id, project_id, file_path, file_mtime_ms, file_size_bytes,
      cwd, project_key, project_path, identity_confidence, title,
      created_at, last_updated_at, input_tokens, output_tokens,
      total_tokens, cache_read_input_tokens, cache_creation_input_tokens,
      model, token_status, parse_error, missing_since, source_seen_at, updated_at,
      preview, message_count
    ) VALUES (
      @session_id, @project_id, @file_path, @file_mtime_ms, @file_size_bytes,
      @cwd, @project_key, @project_path, @identity_confidence, @title,
      @created_at, @last_updated_at, @input_tokens, @output_tokens,
      @total_tokens, @cache_read_input_tokens, @cache_creation_input_tokens,
      @model, @token_status, @parse_error, @missing_since, @source_seen_at, @updated_at,
      @preview, @message_count
    )
    ON CONFLICT(session_id) DO UPDATE SET
      project_id = excluded.project_id,
      file_path = excluded.file_path,
      file_mtime_ms = excluded.file_mtime_ms,
      file_size_bytes = excluded.file_size_bytes,
      cwd = excluded.cwd,
      project_key = excluded.project_key,
      project_path = excluded.project_path,
      identity_confidence = excluded.identity_confidence,
      title = excluded.title,
      created_at = excluded.created_at,
      last_updated_at = excluded.last_updated_at,
      input_tokens = excluded.input_tokens,
      output_tokens = excluded.output_tokens,
      total_tokens = excluded.total_tokens,
      cache_read_input_tokens = excluded.cache_read_input_tokens,
      cache_creation_input_tokens = excluded.cache_creation_input_tokens,
      model = excluded.model,
      token_status = excluded.token_status,
      parse_error = excluded.parse_error,
      missing_since = excluded.missing_since,
      source_seen_at = excluded.source_seen_at,
      updated_at = excluded.updated_at,
      preview = excluded.preview,
      message_count = excluded.message_count`
  ).run(row);
}

export function markClaudeTokenUsageRowSeen(
  db: Database.Database,
  sessionId: string,
  nowIso: string
): void {
  db.prepare(
    `UPDATE claude_session_token_usage
     SET missing_since = NULL, source_seen_at = ?, updated_at = ?
     WHERE session_id = ?`
  ).run(nowIso, nowIso, sessionId);
}

export function markUnseenClaudeTokenRowsMissing(
  db: Database.Database,
  seenSessionIds: Set<string>,
  nowIso: string
): number {
  const rows = db
    .prepare("SELECT session_id FROM claude_session_token_usage WHERE missing_since IS NULL")
    .all() as { session_id: string }[];
  const mark = db.prepare(
    `UPDATE claude_session_token_usage
     SET missing_since = ?, updated_at = ?
     WHERE session_id = ?`
  );
  let count = 0;
  const tx = db.transaction(() => {
    for (const row of rows) {
      if (seenSessionIds.has(row.session_id)) continue;
      mark.run(nowIso, nowIso, row.session_id);
      count++;
    }
  });
  tx();
  return count;
}

export function upsertClaudeTokenUsageState(
  db: Database.Database,
  values: Omit<ClaudeTokenUsageStateRow, "id">
): void {
  db.prepare(
    `INSERT INTO claude_session_token_usage_state (
      id, rule_version, last_rebuilt_at, last_error,
      source_session_count, indexed_session_count, token_known_session_count,
      token_unknown_session_count, error_session_count, skipped_unchanged_count,
      duration_ms, updated_at
    ) VALUES (
      1, @rule_version, @last_rebuilt_at, @last_error,
      @source_session_count, @indexed_session_count, @token_known_session_count,
      @token_unknown_session_count, @error_session_count, @skipped_unchanged_count,
      @duration_ms, @updated_at
    )
    ON CONFLICT(id) DO UPDATE SET
      rule_version = excluded.rule_version,
      last_rebuilt_at = excluded.last_rebuilt_at,
      last_error = excluded.last_error,
      source_session_count = excluded.source_session_count,
      indexed_session_count = excluded.indexed_session_count,
      token_known_session_count = excluded.token_known_session_count,
      token_unknown_session_count = excluded.token_unknown_session_count,
      error_session_count = excluded.error_session_count,
      skipped_unchanged_count = excluded.skipped_unchanged_count,
      duration_ms = excluded.duration_ms,
      updated_at = excluded.updated_at`
  ).run(values);
}

export function listClaudeProjectTokenUsage(
  db: Database.Database,
  args: { projectKeys?: string[]; from?: Date | null }
): Map<string, ClaudeProjectTokenUsage> {
  const clauses = ["missing_since IS NULL"];
  const params: unknown[] = [];
  if (args.from) {
    clauses.push("last_updated_at >= ?");
    params.push(args.from.toISOString());
  }
  if (args.projectKeys && args.projectKeys.length > 0) {
    clauses.push(`project_key IN (${args.projectKeys.map(() => "?").join(", ")})`);
    params.push(...args.projectKeys);
  }

  const rows = db
    .prepare(
      `SELECT project_key AS projectKey,
              MIN(project_path) AS projectPath,
              COALESCE(SUM(input_tokens), 0) AS inputTokens,
              COALESCE(SUM(output_tokens), 0) AS outputTokens,
              COALESCE(SUM(total_tokens), 0) AS totalTokens,
              COUNT(*) AS totalSessions,
              SUM(CASE WHEN token_status = 'full' THEN 1 ELSE 0 END) AS coveredSessions,
              SUM(CASE WHEN token_status = 'error' THEN 1 ELSE 0 END) AS errorSessions
       FROM claude_session_token_usage
       WHERE ${clauses.join(" AND ")}
       GROUP BY project_key`
    )
    .all(...params) as Array<{
      projectKey: string;
      projectPath: string;
      inputTokens: number;
      outputTokens: number;
      totalTokens: number;
      totalSessions: number;
      coveredSessions: number;
      errorSessions: number;
    }>;

  return new Map(
    rows.map((row) => {
      const coverage =
        row.coveredSessions === 0
          ? "unknown"
          : row.coveredSessions === row.totalSessions && row.errorSessions === 0
            ? "full"
            : "partial";
      return [row.projectKey, { ...row, coverage }];
    })
  );
}

export type ClaudeDashboardSessionRow = {
  sessionId: string;
  projectId: string;
  projectKey: string;
  projectPath: string;
  identityConfidence: "high" | "low";
  title: string | null;
  preview: string | null;
  createdAt: string | null;
  lastUpdatedAt: string;
  messageCount: number | null;
  inputTokens: number;
  outputTokens: number;
  tokenStatus: ClaudeTokenStatus;
};

/**
 * Per-session rows for the work-dashboard Claude list, straight from the index —
 * no transcript parsing. Identity (project_key/path/confidence) is the value
 * stored at sync time, so the dashboard reuses it verbatim with no
 * re-normalization drift. `from` prunes by last_updated_at; newest first.
 */
export function listClaudeDashboardSessions(
  db: Database.Database,
  args: { from?: Date | null } = {}
): ClaudeDashboardSessionRow[] {
  const clauses = ["missing_since IS NULL"];
  const params: unknown[] = [];
  if (args.from) {
    clauses.push("last_updated_at >= ?");
    params.push(args.from.toISOString());
  }
  return db
    .prepare(
      `SELECT session_id AS sessionId, project_id AS projectId,
              project_key AS projectKey, project_path AS projectPath,
              identity_confidence AS identityConfidence,
              title, preview, created_at AS createdAt,
              last_updated_at AS lastUpdatedAt, message_count AS messageCount,
              input_tokens AS inputTokens, output_tokens AS outputTokens,
              token_status AS tokenStatus
       FROM claude_session_token_usage
       WHERE ${clauses.join(" AND ")}
       ORDER BY last_updated_at DESC`
    )
    .all(...params) as ClaudeDashboardSessionRow[];
}

/**
 * Per-session timing facts (parsed last_updated_at + the file mtime/size captured
 * at sync), grouped `project_id -> file_path -> {...}`. Feeds
 * {@link computeProjectLastActive} so the project list can sort by recency without
 * re-parsing any jsonl. Joins on `project_id` (the dir slug, == ClaudeProjectRow.id);
 * the `project_key` index does not apply, but the table is a few hundred rows.
 *
 * `missing_since IS NULL` mirrors {@link listClaudeProjectTokenUsage} so deleted
 * (and later restored) sessions never surface stale rows.
 */
export function projectSessionTimes(
  db: Database.Database,
  projectIds: string[]
): Map<string, Map<string, ProjectSessionTime>> {
  const out = new Map<string, Map<string, ProjectSessionTime>>();
  if (projectIds.length === 0) return out;

  const rows = db
    .prepare(
      `SELECT project_id   AS projectId,
              file_path     AS filePath,
              last_updated_at AS lastUpdatedAt,
              file_mtime_ms  AS fileMtimeMs,
              file_size_bytes AS fileSizeBytes
       FROM claude_session_token_usage
       WHERE missing_since IS NULL
         AND project_id IN (${projectIds.map(() => "?").join(", ")})`
    )
    .all(...projectIds) as Array<{
      projectId: string;
      filePath: string;
      lastUpdatedAt: string | null;
      fileMtimeMs: number;
      fileSizeBytes: number;
    }>;

  for (const row of rows) {
    if (!row.lastUpdatedAt) continue;
    let byPath = out.get(row.projectId);
    if (!byPath) {
      byPath = new Map<string, ProjectSessionTime>();
      out.set(row.projectId, byPath);
    }
    byPath.set(row.filePath, {
      lastUpdatedAt: row.lastUpdatedAt,
      fileMtimeMs: row.fileMtimeMs,
      fileSizeBytes: row.fileSizeBytes,
    });
  }

  return out;
}
