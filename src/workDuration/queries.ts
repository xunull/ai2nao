import type Database from "better-sqlite3";
import {
  WORK_DURATION_RULE_VERSION,
  type WorkDurationRow,
  type WorkDurationSource,
  type WorkDurationStateRow,
  type WorkDurationStatusSummary,
  type WorkProjectDurationUsage,
} from "./types.js";

export function getWorkDurationRow(
  db: Database.Database,
  source: WorkDurationSource,
  sessionId: string
): WorkDurationRow | null {
  return (
    db
      .prepare(
        `SELECT source, session_id, transcript_path, transcript_mtime_ms,
                transcript_size_bytes, cwd, project_key, project_path,
                identity_confidence, title, started_at, ended_at, wall_ms,
                active_ms, event_count, idle_threshold_ms, duration_status,
                parse_error, missing_since, source_seen_at, updated_at
         FROM work_session_duration
         WHERE source = ? AND session_id = ?`
      )
      .get(source, sessionId) as WorkDurationRow | undefined
  ) ?? null;
}

export function upsertWorkDurationRow(
  db: Database.Database,
  row: WorkDurationRow
): void {
  db.prepare(
    `INSERT INTO work_session_duration (
      source, session_id, transcript_path, transcript_mtime_ms,
      transcript_size_bytes, cwd, project_key, project_path,
      identity_confidence, title, started_at, ended_at, wall_ms,
      active_ms, event_count, idle_threshold_ms, duration_status,
      parse_error, missing_since, source_seen_at, updated_at
    ) VALUES (
      @source, @session_id, @transcript_path, @transcript_mtime_ms,
      @transcript_size_bytes, @cwd, @project_key, @project_path,
      @identity_confidence, @title, @started_at, @ended_at, @wall_ms,
      @active_ms, @event_count, @idle_threshold_ms, @duration_status,
      @parse_error, @missing_since, @source_seen_at, @updated_at
    )
    ON CONFLICT(source, session_id) DO UPDATE SET
      transcript_path = excluded.transcript_path,
      transcript_mtime_ms = excluded.transcript_mtime_ms,
      transcript_size_bytes = excluded.transcript_size_bytes,
      cwd = excluded.cwd,
      project_key = excluded.project_key,
      project_path = excluded.project_path,
      identity_confidence = excluded.identity_confidence,
      title = excluded.title,
      started_at = excluded.started_at,
      ended_at = excluded.ended_at,
      wall_ms = excluded.wall_ms,
      active_ms = excluded.active_ms,
      event_count = excluded.event_count,
      idle_threshold_ms = excluded.idle_threshold_ms,
      duration_status = excluded.duration_status,
      parse_error = excluded.parse_error,
      missing_since = excluded.missing_since,
      source_seen_at = excluded.source_seen_at,
      updated_at = excluded.updated_at`
  ).run(row);
}

export function markWorkDurationRowSeen(
  db: Database.Database,
  source: WorkDurationSource,
  sessionId: string,
  nowIso: string
): void {
  db.prepare(
    `UPDATE work_session_duration
     SET missing_since = NULL, source_seen_at = ?, updated_at = ?
     WHERE source = ? AND session_id = ?`
  ).run(nowIso, nowIso, source, sessionId);
}

export function markUnseenWorkDurationRowsMissing(
  db: Database.Database,
  source: WorkDurationSource,
  seenSessionIds: Set<string>,
  nowIso: string
): number {
  const rows = db
    .prepare(
      `SELECT session_id
       FROM work_session_duration
       WHERE source = ? AND missing_since IS NULL`
    )
    .all(source) as { session_id: string }[];
  const mark = db.prepare(
    `UPDATE work_session_duration
     SET missing_since = ?, updated_at = ?
     WHERE source = ? AND session_id = ?`
  );
  let count = 0;
  const tx = db.transaction(() => {
    for (const row of rows) {
      if (seenSessionIds.has(row.session_id)) continue;
      mark.run(nowIso, nowIso, source, row.session_id);
      count++;
    }
  });
  tx();
  return count;
}

export function upsertWorkDurationState(
  db: Database.Database,
  values: WorkDurationStateRow
): void {
  db.prepare(
    `INSERT INTO work_duration_state (
      source, rule_version, last_rebuilt_at, last_error,
      source_session_count, indexed_session_count,
      duration_known_session_count, duration_unknown_session_count,
      error_session_count, skipped_unchanged_count, duration_ms, updated_at
    ) VALUES (
      @source, @rule_version, @last_rebuilt_at, @last_error,
      @source_session_count, @indexed_session_count,
      @duration_known_session_count, @duration_unknown_session_count,
      @error_session_count, @skipped_unchanged_count, @duration_ms, @updated_at
    )
    ON CONFLICT(source) DO UPDATE SET
      rule_version = excluded.rule_version,
      last_rebuilt_at = excluded.last_rebuilt_at,
      last_error = excluded.last_error,
      source_session_count = excluded.source_session_count,
      indexed_session_count = excluded.indexed_session_count,
      duration_known_session_count = excluded.duration_known_session_count,
      duration_unknown_session_count = excluded.duration_unknown_session_count,
      error_session_count = excluded.error_session_count,
      skipped_unchanged_count = excluded.skipped_unchanged_count,
      duration_ms = excluded.duration_ms,
      updated_at = excluded.updated_at`
  ).run(values);
}

export function getWorkDurationState(
  db: Database.Database,
  source?: WorkDurationSource
): WorkDurationStateRow[] {
  const sql = `SELECT source, rule_version, last_rebuilt_at, last_error,
                      source_session_count, indexed_session_count,
                      duration_known_session_count, duration_unknown_session_count,
                      error_session_count, skipped_unchanged_count,
                      duration_ms, updated_at
               FROM work_duration_state`;
  if (source) {
    return db.prepare(`${sql} WHERE source = ?`).all(source) as WorkDurationStateRow[];
  }
  return db.prepare(sql).all() as WorkDurationStateRow[];
}

export function getWorkDurationStatus(
  db: Database.Database
): WorkDurationStatusSummary {
  const states = getWorkDurationState(db);
  const staleReasons: string[] = [];
  const bySource = new Set(states.map((state) => state.source));
  if (!bySource.has("claude-code")) staleReasons.push("claude_not_built");
  if (!bySource.has("codex")) staleReasons.push("codex_not_built");
  for (const state of states) {
    if (state.rule_version !== WORK_DURATION_RULE_VERSION) {
      staleReasons.push(`${state.source}_rule_version_mismatch`);
    }
    if (state.last_error) staleReasons.push(`${state.source}_last_refresh_error`);
  }
  return { states, fresh: staleReasons.length === 0, staleReasons };
}

export function listWorkProjectDurationUsage(
  db: Database.Database,
  args: {
    projectKeys?: string[];
    from?: Date | null;
    sources?: WorkDurationSource[];
  }
): Map<string, WorkProjectDurationUsage> {
  const clauses = ["missing_since IS NULL"];
  const params: unknown[] = [];
  if (args.from) {
    clauses.push("ended_at >= ?");
    params.push(args.from.toISOString());
  }
  if (args.projectKeys && args.projectKeys.length > 0) {
    clauses.push(`project_key IN (${args.projectKeys.map(() => "?").join(", ")})`);
    params.push(...args.projectKeys);
  }
  if (args.sources && args.sources.length > 0) {
    clauses.push(`source IN (${args.sources.map(() => "?").join(", ")})`);
    params.push(...args.sources);
  }

  const rows = db
    .prepare(
      `SELECT project_key AS projectKey,
              MIN(project_path) AS projectPath,
              COALESCE(SUM(CASE WHEN duration_status = 'full' THEN active_ms ELSE 0 END), 0) AS activeMs,
              COALESCE(SUM(CASE WHEN duration_status = 'full' THEN wall_ms ELSE 0 END), 0) AS wallMs,
              COUNT(*) AS totalSessions,
              SUM(CASE WHEN duration_status = 'full' THEN 1 ELSE 0 END) AS knownSessions,
              SUM(CASE WHEN duration_status = 'error' THEN 1 ELSE 0 END) AS errorSessions
       FROM work_session_duration
       WHERE ${clauses.join(" AND ")}
       GROUP BY project_key`
    )
    .all(...params) as Array<{
      projectKey: string;
      projectPath: string;
      activeMs: number;
      wallMs: number;
      totalSessions: number;
      knownSessions: number;
      errorSessions: number;
    }>;

  return new Map(
    rows.map((row) => {
      const coverage =
        row.knownSessions === 0
          ? "unknown"
          : row.knownSessions === row.totalSessions && row.errorSessions === 0
            ? "full"
            : "partial";
      return [row.projectKey, { ...row, coverage }];
    })
  );
}
