import type Database from "better-sqlite3";
import {
  CODEX_TOKEN_USAGE_RULE_VERSION,
  type CodexProjectTokenUsage,
  type CodexTokenUsageEventRow,
  type CodexTokenUsageRow,
  type CodexTokenUsageStateRow,
  type CodexTokenUsageStatus,
} from "./types.js";

export function getCodexTokenUsageState(
  db: Database.Database
): CodexTokenUsageStateRow | null {
  return (
    db
      .prepare(
        `SELECT id, rule_version, last_rebuilt_at, last_error,
                source_session_count, indexed_session_count,
                token_known_session_count, token_unknown_session_count,
                error_session_count, skipped_unchanged_count,
                duration_ms, updated_at
         FROM codex_token_usage_state
         WHERE id = 1`
      )
      .get() as CodexTokenUsageStateRow | undefined
  ) ?? null;
}

export function getCodexTokenUsageStatus(
  db: Database.Database
): CodexTokenUsageStatus {
  const state = getCodexTokenUsageState(db);
  const staleReasons: string[] = [];
  if (!state) staleReasons.push("not_built");
  if (state && state.rule_version !== CODEX_TOKEN_USAGE_RULE_VERSION) {
    staleReasons.push("rule_version_mismatch");
  }
  if (state?.last_error) staleReasons.push("last_refresh_error");
  return { state, fresh: staleReasons.length === 0, staleReasons };
}

export function getCodexTokenUsageRow(
  db: Database.Database,
  sessionId: string
): CodexTokenUsageRow | null {
  return (
    db
      .prepare(
        `SELECT session_id, rollout_path, rollout_mtime_ms, rollout_size_bytes,
                cwd, project_key, project_path, identity_confidence, title, model,
                git_branch, created_at, last_updated_at, input_tokens, output_tokens,
                total_tokens, reasoning_output_tokens, cached_input_tokens, token_status,
                parse_error, missing_since, source_seen_at, updated_at
         FROM codex_session_token_usage
         WHERE session_id = ?`
      )
      .get(sessionId) as CodexTokenUsageRow | undefined
  ) ?? null;
}

export function upsertCodexTokenUsageRow(
  db: Database.Database,
  row: CodexTokenUsageRow
): void {
  db.prepare(
    `INSERT INTO codex_session_token_usage (
      session_id, rollout_path, rollout_mtime_ms, rollout_size_bytes,
      cwd, project_key, project_path, identity_confidence, title, model,
      git_branch, created_at, last_updated_at, input_tokens, output_tokens,
      total_tokens, reasoning_output_tokens, cached_input_tokens, token_status, parse_error, missing_since, source_seen_at, updated_at
    ) VALUES (
      @session_id, @rollout_path, @rollout_mtime_ms, @rollout_size_bytes,
      @cwd, @project_key, @project_path, @identity_confidence, @title, @model,
      @git_branch, @created_at, @last_updated_at, @input_tokens, @output_tokens,
      @total_tokens, @reasoning_output_tokens, @cached_input_tokens, @token_status, @parse_error, @missing_since, @source_seen_at, @updated_at
    )
    ON CONFLICT(session_id) DO UPDATE SET
      rollout_path = excluded.rollout_path,
      rollout_mtime_ms = excluded.rollout_mtime_ms,
      rollout_size_bytes = excluded.rollout_size_bytes,
      cwd = excluded.cwd,
      project_key = excluded.project_key,
      project_path = excluded.project_path,
      identity_confidence = excluded.identity_confidence,
      title = excluded.title,
      model = excluded.model,
      git_branch = excluded.git_branch,
      created_at = excluded.created_at,
      last_updated_at = excluded.last_updated_at,
      input_tokens = excluded.input_tokens,
      output_tokens = excluded.output_tokens,
      total_tokens = excluded.total_tokens,
      reasoning_output_tokens = excluded.reasoning_output_tokens,
      cached_input_tokens = excluded.cached_input_tokens,
      token_status = excluded.token_status,
      parse_error = excluded.parse_error,
      missing_since = excluded.missing_since,
      source_seen_at = excluded.source_seen_at,
      updated_at = excluded.updated_at`
  ).run(row);
}

/**
 * Replace ALL per-event token rows for one session (delete-then-insert in a
 * single transaction). Called on every reparse so the event timeline always
 * matches the current rollout contents. Pass `[]` to clear (unknown/error
 * sessions have no usable per-event tokens).
 */
export function replaceCodexTokenUsageEvents(
  db: Database.Database,
  sessionId: string,
  events: CodexTokenUsageEventRow[]
): void {
  const del = db.prepare(
    "DELETE FROM codex_token_usage_event WHERE session_id = ?"
  );
  const ins = db.prepare(
    `INSERT INTO codex_token_usage_event
       (session_id, event_at, input_tokens, output_tokens, reasoning_output_tokens, cached_input_tokens)
     VALUES (@session_id, @event_at, @input_tokens, @output_tokens, @reasoning_output_tokens, @cached_input_tokens)`
  );
  const tx = db.transaction(() => {
    del.run(sessionId);
    for (const event of events) ins.run(event);
  });
  tx();
}

export function markCodexTokenUsageRowSeen(
  db: Database.Database,
  sessionId: string,
  nowIso: string
): void {
  db.prepare(
    `UPDATE codex_session_token_usage
     SET missing_since = NULL, source_seen_at = ?, updated_at = ?
     WHERE session_id = ?`
  ).run(nowIso, nowIso, sessionId);
}

export function markUnseenCodexTokenRowsMissing(
  db: Database.Database,
  seenSessionIds: Set<string>,
  nowIso: string
): number {
  const rows = db
    .prepare("SELECT session_id FROM codex_session_token_usage WHERE missing_since IS NULL")
    .all() as { session_id: string }[];
  const mark = db.prepare(
    `UPDATE codex_session_token_usage
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

export function upsertCodexTokenUsageState(
  db: Database.Database,
  values: Omit<CodexTokenUsageStateRow, "id">
): void {
  db.prepare(
    `INSERT INTO codex_token_usage_state (
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

export function listCodexProjectTokenUsage(
  db: Database.Database,
  args: { projectKeys?: string[]; from?: Date | null }
): Map<string, CodexProjectTokenUsage> {
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
       FROM codex_session_token_usage
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
