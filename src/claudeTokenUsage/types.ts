/**
 * Bump when the parsing/aggregation rules change in a way that makes
 * previously-indexed `claude_session_token_usage` rows incorrect. The
 * refresh entry point auto-forces `full=true` whenever the stored
 * `state.rule_version` differs from this constant, so old DBs heal
 * themselves on the next refresh tick without the user needing to know.
 *
 * History:
 *   v1: input_tokens + output_tokens only.
 *   v2: also sums cache_creation_input_tokens + cache_read_input_tokens
 *       (Anthropic prompt-cache fields). v1 under-counts Claude Code by
 *       ~100-1000× on long sessions. Investigation 2026-06-12.
 */
export const CLAUDE_TOKEN_USAGE_RULE_VERSION = 2;

export type ClaudeTokenStatus = "full" | "unknown" | "error";

export type ClaudeTokenUsageRow = {
  session_id: string;
  project_id: string;
  file_path: string;
  file_mtime_ms: number;
  file_size_bytes: number;
  cwd: string;
  project_key: string;
  project_path: string;
  identity_confidence: "high" | "low";
  title: string | null;
  created_at: string | null;
  last_updated_at: string;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  token_status: ClaudeTokenStatus;
  parse_error: string | null;
  missing_since: string | null;
  source_seen_at: string;
  updated_at: string;
};

export type ClaudeTokenUsageStateRow = {
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

export type ClaudeTokenUsageRefreshResult = {
  ok: boolean;
  status: "success" | "partial" | "failed";
  projectsRoot: string;
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

export type ClaudeProjectTokenUsage = {
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

export type ClaudeTokenUsageStatus = {
  state: ClaudeTokenUsageStateRow | null;
  fresh: boolean;
  staleReasons: string[];
};
