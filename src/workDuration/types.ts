export const WORK_DURATION_RULE_VERSION = 1;
export const WORK_DURATION_IDLE_THRESHOLD_MS = 10 * 60 * 1000;

export type WorkDurationSource = "claude-code" | "codex";

export type WorkDurationStatus = "full" | "unknown" | "error";

export type WorkDurationRow = {
  source: WorkDurationSource;
  session_id: string;
  transcript_path: string;
  transcript_mtime_ms: number;
  transcript_size_bytes: number;
  cwd: string;
  project_key: string;
  project_path: string;
  identity_confidence: "high" | "low";
  title: string | null;
  started_at: string | null;
  ended_at: string | null;
  wall_ms: number;
  active_ms: number;
  event_count: number;
  idle_threshold_ms: number;
  duration_status: WorkDurationStatus;
  parse_error: string | null;
  missing_since: string | null;
  source_seen_at: string;
  updated_at: string;
};

export type WorkDurationStateRow = {
  source: WorkDurationSource;
  rule_version: number;
  last_rebuilt_at: string | null;
  last_error: string | null;
  source_session_count: number;
  indexed_session_count: number;
  duration_known_session_count: number;
  duration_unknown_session_count: number;
  error_session_count: number;
  skipped_unchanged_count: number;
  duration_ms: number | null;
  updated_at: string;
};

export type WorkDurationRefreshResult = {
  ok: boolean;
  status: "success" | "partial" | "failed";
  source: WorkDurationSource;
  sourceSessionCount: number;
  indexedSessionCount: number;
  durationKnownSessionCount: number;
  durationUnknownSessionCount: number;
  errorSessionCount: number;
  skippedUnchangedCount: number;
  missingMarkedCount: number;
  durationMs: number;
  errors: string[];
};

export type WorkDurationCombinedRefreshResult = {
  ok: boolean;
  status: "success" | "partial" | "failed";
  claude: WorkDurationRefreshResult;
  codex: WorkDurationRefreshResult;
  errors: string[];
};

export type WorkProjectDurationUsage = {
  projectKey: string;
  projectPath: string;
  activeMs: number;
  wallMs: number;
  knownSessions: number;
  totalSessions: number;
  errorSessions: number;
  coverage: "full" | "partial" | "unknown";
};

export type WorkDurationStatusSummary = {
  states: WorkDurationStateRow[];
  fresh: boolean;
  staleReasons: string[];
};
