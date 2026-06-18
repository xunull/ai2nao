/**
 * Bump when the Codex parsing/aggregation rules change in a way that makes
 * previously-indexed `codex_session_token_usage` rows incorrect. The refresh
 * entry point auto-forces `full=true` when the stored `state.rule_version`
 * differs from this constant, so old DBs self-heal on the next refresh.
 *
 * History:
 *   v1: output = output_tokens + reasoning_output_tokens (DOUBLE-COUNTED —
 *       reasoning is a subset of output, so this inflated Codex output by
 *       ~22.6%).
 *   v2: output = output_tokens (reasoning already included). 2026-06-18.
 *   v3: also persists reasoning_output_tokens in its own column (subset of
 *       output) to power the "Codex 输出构成" display. 2026-06-18.
 */
export const CODEX_TOKEN_USAGE_RULE_VERSION = 3;

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
  /** Subset of output_tokens that was reasoning (thinking). */
  reasoning_output_tokens: number;
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
