export const CODEX_TOKEN_USAGE_RULE_VERSION = 1;

export type CodexTokenStatus = "full" | "unknown" | "error";

export type CodexTokenUsageRow = {
  session_id: string;
  rollout_path: string;
  rollout_mtime_ms: number;
  rollout_size_bytes: number;
  cwd: string;
  project_key: string;
  project_path: string;
  identity_confidence: "high" | "low";
  title: string | null;
  model: string | null;
  git_branch: string | null;
  created_at: string | null;
  last_updated_at: string;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  token_status: CodexTokenStatus;
  parse_error: string | null;
  missing_since: string | null;
  source_seen_at: string;
  updated_at: string;
};

export type CodexTokenUsageStateRow = {
  id: number;
  rule_version: number;
  last_rebuilt_at: string | null;
  last_error: string | null;
  source_session_count: number;
  indexed_session_count: number;
  token_known_session_count: number;
  token_unknown_session_count: number;
  error_session_count: number;
  skipped_unchanged_count: number;
  duration_ms: number | null;
  updated_at: string;
};

export type CodexTokenUsageRefreshResult = {
  ok: boolean;
  status: "success" | "partial" | "failed";
  source: "sqlite" | "fallback";
  codexRoot: string;
  sessionsRoot: string;
  stateDbPath: string;
  sourceSessionCount: number;
  indexedSessionCount: number;
  tokenKnownSessionCount: number;
  tokenUnknownSessionCount: number;
  errorSessionCount: number;
  skippedUnchangedCount: number;
  missingMarkedCount: number;
  durationMs: number;
  errors: string[];
};

export type CodexProjectTokenUsage = {
  projectKey: string;
  projectPath: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  coveredSessions: number;
  totalSessions: number;
  errorSessions: number;
  coverage: "full" | "partial" | "unknown";
};

export type CodexTokenUsageStatus = {
  state: CodexTokenUsageStateRow | null;
  fresh: boolean;
  staleReasons: string[];
};
