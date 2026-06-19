/**
 * Vendored model price snapshot for the tokens-trend USD cost estimate.
 *
 * The cost view is an explicitly-labeled ESTIMATE ("equivalent API cost", not a
 * subscription bill). Prices are a STATIC snapshot from LiteLLM
 * `model_prices_and_context_window.json` (offline by design; we only see a
 * handful of models). Update PRICE_SNAPSHOT_DATE + values when refreshing.
 *
 * Honesty rule: a model with NO entry returns null → its tokens are reported as
 * "unpriced", never guessed or counted as 0 cost.
 *
 * Units: USD per token.
 *
 *      cost = fresh × input
 *           + cacheCreation × cacheCreation     (Claude only; Codex has none)
 *           + cacheHit × cacheRead              (cache replay — ~10x cheaper)
 *           + output × output
 *   where fresh = input − cacheHit − cacheCreation (the genuinely-new bytes).
 */

export const PRICE_SNAPSHOT_DATE = "2026-06-19";

export type ModelPrice = {
  /** USD per fresh (non-cached) input token. */
  input: number;
  /** USD per output token (reasoning is billed as output — priced once). */
  output: number;
  /** USD per cache-read (cache-hit replay) input token. */
  cacheRead: number;
  /** USD per cache-creation (cache-write) input token. Codex has no concept. */
  cacheCreation: number;
};

/**
 * Keyed by the LiteLLM base model name (no provider prefix, no date suffix).
 * Source: LiteLLM model_prices_and_context_window.json @ PRICE_SNAPSHOT_DATE.
 *
 * NOTE: `gpt-5.5` (the dominant Codex model here) is NOT in LiteLLM, so it is
 * intentionally absent → Codex cost shows as unpriced until a real rate is
 * added. Do NOT fabricate it. Fill from OpenAI's published API pricing when
 * known, then it prices automatically.
 */
export const MODEL_PRICES: Record<string, ModelPrice> = {
  "claude-opus-4-8": { input: 5e-6, output: 2.5e-5, cacheRead: 5e-7, cacheCreation: 6.25e-6 },
  "claude-opus-4-7": { input: 5e-6, output: 2.5e-5, cacheRead: 5e-7, cacheCreation: 6.25e-6 },
  "claude-sonnet-4-6": { input: 3e-6, output: 1.5e-5, cacheRead: 3e-7, cacheCreation: 3.75e-6 },
  "claude-haiku-4-5": { input: 1e-6, output: 5e-6, cacheRead: 1e-7, cacheCreation: 1.25e-6 },
  "claude-fable-5": { input: 1e-5, output: 5e-5, cacheRead: 1e-6, cacheCreation: 1.25e-5 },
  // "gpt-5.5": fill from OpenAI pricing — absent from LiteLLM snapshot.
};

/**
 * Resolve a raw model string (from a session) to a price entry.
 *
 * Real model strings carry suffixes the price keys don't: Claude jsonl emits
 * `claude-haiku-4-5-20251001`, Bedrock emits `...-v1:0`, some carry a provider
 * prefix (`anthropic.`). Match in order: exact → strip provider prefix → strip
 * trailing `-YYYYMMDD` / `-vN...` → longest known-key prefix. Null when nothing
 * matches (caller treats as unpriced).
 */
export function priceFor(model: string | null | undefined): ModelPrice | null {
  if (!model) return null;
  if (MODEL_PRICES[model]) return MODEL_PRICES[model];

  // strip provider prefix like "anthropic." / "openai/"
  let key = model.replace(/^[a-z0-9_]+[./]/i, "");
  if (MODEL_PRICES[key]) return MODEL_PRICES[key];

  // strip trailing date (-YYYYMMDD) and/or bedrock version (-vN:N / -vN)
  key = key.replace(/-v\d+(?::\d+)?$/i, "").replace(/-\d{8}$/, "");
  if (MODEL_PRICES[key]) return MODEL_PRICES[key];

  // longest known-key prefix the model starts with (handles unseen suffixes)
  let best: ModelPrice | null = null;
  let bestLen = 0;
  for (const k of Object.keys(MODEL_PRICES)) {
    if (key.startsWith(k) && k.length > bestLen) {
      best = MODEL_PRICES[k];
      bestLen = k.length;
    }
  }
  return best;
}

export type CostComponents = {
  /** Genuinely-new input tokens (input − cacheHit − cacheCreation). */
  fresh: number;
  /** Cache-hit (replay) input tokens. */
  cacheHit: number;
  /** Cache-creation (write) input tokens. Codex: 0. */
  cacheCreation: number;
  /** Output tokens (reasoning included — priced once). */
  output: number;
};

export type CostResult =
  | { priced: true; usd: number }
  /** Model had no price entry — its tokens are unpriced (surface, don't sum). */
  | { priced: false; usd: 0 };

/** USD cost of one model's token components, or unpriced when the model is unknown. */
export function computeCost(
  components: CostComponents,
  model: string | null | undefined
): CostResult {
  const p = priceFor(model);
  if (!p) return { priced: false, usd: 0 };
  const usd =
    components.fresh * p.input +
    components.cacheCreation * p.cacheCreation +
    components.cacheHit * p.cacheRead +
    components.output * p.output;
  return { priced: true, usd };
}
