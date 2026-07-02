/**
 * MiniMax per-hour billing-history events.
 *
 * Source: MiniMax's UNDOCUMENTED console endpoint `GET /account/amount`
 * (Bearer key). Unlike claude/codex (parsed from LOCAL JSONL), this is pulled
 * from a REMOTE billing API, lags T+1~T+2, and is opt-in per provider. Each
 * charge_record is pre-aggregated per (hour × method × model). See
 * `docs/minimax-token-accounting.md` for the full field verification.
 *
 * The `method` string is the CALIBER classifier and is stored VERBATIM (so a
 * future/unknown method is never silently dropped — only known non-usage
 * account events like `code_plan_purchase` and 0-token rows are dropped). The
 * trend query classifies cache vs fresh by matching these method strings.
 */

/** Known method strings whose consumption is prompt-cache (booked as input). */
export const MINIMAX_METHOD_CACHE_READ = "cache-read(Text API)";
export const MINIMAX_METHOD_CACHE_CREATE = "cache-create(Text API)";

/**
 * Methods that are NOT token usage (account/billing events). Dropped at ingest.
 * 0-token rows are also dropped regardless of method.
 */
export const MINIMAX_NON_USAGE_METHODS = new Set<string>(["code_plan_purchase"]);

/** One normalized billing event → one `minimax_token_usage_event` row. */
export type MinimaxTokenEvent = {
  /** ISO instant = start of the Beijing clock hour (`created_at` * 1000). */
  event_at: string;
  /** Verbatim method string (classifier). */
  method: string;
  model: string;
  api_token_name: string;
  /** `consume_input_token` (for cache-* methods this IS the cache token count). */
  input_tokens: number;
  /** `consume_output_token` (only chatcompletion has output). */
  output_tokens: number;
  /** Raw `consume_cash` string, kept for a future pay-as-you-go cost path. */
  consume_cash: string | null;
  /** Verbatim record JSON — the endpoint is undocumented and may drift. */
  raw_json: string;
};
