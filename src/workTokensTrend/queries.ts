import type Database from "better-sqlite3";
import { computeCost, PRICE_SNAPSHOT_DATE } from "../cost/pricing.js";
import { latestSyncedAt, loadPriceMap } from "../cost/priceStore.js";
import { bucketExpr } from "./bucket.js";
import type {
  BucketGranularity,
  MonthRange,
  WorkTokensTrendBucket,
  WorkTokensTrendCoverage,
  WorkTokensTrendTotals,
} from "./types.js";

type Source = "claude" | "codex";

const TABLE: Record<Source, string> = {
  claude: "claude_session_token_usage",
  codex: "codex_session_token_usage",
};

/**
 * Per-(bucket, model) token components for USD cost pricing. Cost lives on a
 * SEPARATE path from token bucketing — the model dimension is only needed to
 * price, and pricing is done in TS (rates never enter SQL). Only token_status
 * = 'full' rows contribute (real tokens only). Codex pulls from the per-event
 * timeline (so multi-day costs land on the right day) and JOINs the session
 * table for the model.
 */
export type CostComponentRow = {
  bucket_key: string;
  /** Empty string when the session has no model (→ unpriced downstream). */
  model: string;
  fresh: number;
  cache_hit: number;
  cache_creation: number;
  output: number;
};

export function queryCostComponentsByBucket(
  db: Database.Database,
  source: Source,
  from: Date,
  to: Date,
  granularity: BucketGranularity
): CostComponentRow[] {
  const sql =
    source === "claude"
      ? `
        SELECT
          ${bucketExpr(granularity)} AS bucket_key,
          COALESCE(model, '') AS model,
          COALESCE(SUM(input_tokens - cache_read_input_tokens - cache_creation_input_tokens), 0) AS fresh,
          COALESCE(SUM(cache_read_input_tokens), 0) AS cache_hit,
          COALESCE(SUM(cache_creation_input_tokens), 0) AS cache_creation,
          COALESCE(SUM(output_tokens), 0) AS output
        FROM claude_session_token_usage
        WHERE last_updated_at >= ? AND last_updated_at < ?
          AND missing_since IS NULL AND token_status = 'full'
        GROUP BY bucket_key, model
      `
      : `
        SELECT
          ${bucketExpr(granularity, "e.event_at")} AS bucket_key,
          COALESCE(s.model, '') AS model,
          COALESCE(SUM(e.input_tokens - e.cached_input_tokens), 0) AS fresh,
          COALESCE(SUM(e.cached_input_tokens), 0) AS cache_hit,
          0 AS cache_creation,
          COALESCE(SUM(e.output_tokens), 0) AS output
        FROM codex_token_usage_event e
        JOIN codex_session_token_usage s ON s.session_id = e.session_id
        WHERE e.event_at >= ? AND e.event_at < ?
          AND s.missing_since IS NULL AND s.token_status = 'full'
        GROUP BY bucket_key, model
      `;
  return db
    .prepare(sql)
    .all(from.toISOString(), to.toISOString()) as CostComponentRow[];
}

export type BucketCost = { claudeCostUsd: number; codexCostUsd: number };

/**
 * Price both sources per (bucket, model) and fold into per-bucket USD cost.
 * Returns the per-bucket cost map + total tokens whose model had no price
 * (surfaced, never summed into cost). Pricing is in TS via the vendored
 * snapshot; SQL only aggregated the token components.
 */
export function priceCostByBucket(
  db: Database.Database,
  from: Date,
  to: Date,
  granularity: BucketGranularity
): {
  byBucket: Map<string, BucketCost>;
  unpricedTokenCount: number;
  priceSnapshotDate: string;
} {
  const byBucket = new Map<string, BucketCost>();
  let unpricedTokenCount = 0;
  // Merge vendored snapshot ← synced DB prices (synced wins). One read per request.
  const priceMap = loadPriceMap(db);
  const apply = (source: Source) => {
    for (const r of queryCostComponentsByBucket(db, source, from, to, granularity)) {
      const result = computeCost(
        {
          fresh: r.fresh,
          cacheHit: r.cache_hit,
          cacheCreation: r.cache_creation,
          output: r.output,
        },
        r.model || null,
        priceMap
      );
      if (!result.priced) {
        // input(fresh+hit+creation) + output tokens that we couldn't price.
        unpricedTokenCount +=
          r.fresh + r.cache_hit + r.cache_creation + r.output;
        continue;
      }
      const cur = byBucket.get(r.bucket_key) ?? {
        claudeCostUsd: 0,
        codexCostUsd: 0,
      };
      if (source === "claude") cur.claudeCostUsd += result.usd;
      else cur.codexCostUsd += result.usd;
      byBucket.set(r.bucket_key, cur);
    }
  };
  apply("claude");
  apply("codex");
  // Snapshot date shown on the UI: latest sync, else the vendored snapshot.
  const priceSnapshotDate = latestSyncedAt(db) ?? PRICE_SNAPSHOT_DATE;
  return { byBucket, unpricedTokenCount, priceSnapshotDate };
}

type RawBucketRow = {
  bucket_key: string;
  total_tokens: number;
  input_tokens: number;
  output_tokens: number;
  /** Claude-only prompt-cache split. Always 0 for codex (no such columns). */
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
  /** Codex-only reasoning output. Always 0 for claude (no such column). */
  reasoning_output_tokens: number;
  /** Codex-only cached input (cache-hit replay). Always 0 for claude. */
  codex_cached_input_tokens: number;
  session_count: number;
  full_count: number;
  unknown_count: number;
  error_count: number;
};

/**
 * Per-source aggregate for a single `[from, to)` range bucketed by `granularity`.
 *
 * Claude reads straight from its per-session table (one short-lived session per
 * conversation, so per-session bucketing is already correct). **Codex is
 * special**: a session can be resumed across many days (Codex appends to one
 * rollout), so bucketing its total on `last_updated_at` collapses a week of
 * usage onto one day. For Codex the token sums come from the per-event timeline
 * (`codex_token_usage_event`, bucketed by `event_at`) while session counts /
 * coverage stay on the per-session table. See `queryCodexBuckets`.
 */
export function queryBucketsBySource(
  db: Database.Database,
  source: Source,
  from: Date,
  to: Date,
  granularity: BucketGranularity
): RawBucketRow[] {
  if (source === "codex") {
    return queryCodexBuckets(db, from, to, granularity);
  }
  return querySessionTableBuckets(db, source, from, to, granularity);
}

/**
 * Per-session-table aggregate, bucketed by `last_updated_at`.
 *
 * Filter rules (P11, single predicate for both SUM and count):
 *   - `last_updated_at` BETWEEN from AND to (half-open: < to)
 *   - `missing_since IS NULL` (exclude vanished sessions)
 *
 * **Token sum uses `token_status='full'` ONLY.** Sessions whose status is
 * `unknown` / `error` contribute to session counts (for coverage badge) but
 * NOT to the token sum. This is the ai2nao "real tokens only, never estimate"
 * convention — same as `buildWorkTokenRanking()`.
 */
function querySessionTableBuckets(
  db: Database.Database,
  source: Source,
  from: Date,
  to: Date,
  granularity: BucketGranularity
): RawBucketRow[] {
  // Prompt-cache columns only exist on the Claude table. For Codex we emit
  // literal 0 so the row shape stays uniform across sources.
  const cacheReadExpr =
    source === "claude"
      ? "COALESCE(SUM(CASE WHEN token_status = 'full' THEN cache_read_input_tokens ELSE 0 END), 0)"
      : "0";
  const cacheCreationExpr =
    source === "claude"
      ? "COALESCE(SUM(CASE WHEN token_status = 'full' THEN cache_creation_input_tokens ELSE 0 END), 0)"
      : "0";
  // Mirror of the cache columns, opposite direction: reasoning_output_tokens
  // only exists on the Codex table. For Claude emit literal 0.
  const reasoningExpr =
    source === "codex"
      ? "COALESCE(SUM(CASE WHEN token_status = 'full' THEN reasoning_output_tokens ELSE 0 END), 0)"
      : "0";
  const sql = `
    SELECT
      ${bucketExpr(granularity)} AS bucket_key,
      COALESCE(SUM(CASE WHEN token_status = 'full' THEN total_tokens ELSE 0 END), 0) AS total_tokens,
      COALESCE(SUM(CASE WHEN token_status = 'full' THEN input_tokens ELSE 0 END), 0) AS input_tokens,
      COALESCE(SUM(CASE WHEN token_status = 'full' THEN output_tokens ELSE 0 END), 0) AS output_tokens,
      ${cacheReadExpr} AS cache_read_input_tokens,
      ${cacheCreationExpr} AS cache_creation_input_tokens,
      ${reasoningExpr} AS reasoning_output_tokens,
      0 AS codex_cached_input_tokens,
      COUNT(*) AS session_count,
      SUM(CASE WHEN token_status = 'full' THEN 1 ELSE 0 END) AS full_count,
      SUM(CASE WHEN token_status = 'unknown' THEN 1 ELSE 0 END) AS unknown_count,
      SUM(CASE WHEN token_status = 'error' THEN 1 ELSE 0 END) AS error_count
    FROM ${TABLE[source]}
    WHERE last_updated_at >= ?
      AND last_updated_at < ?
      AND missing_since IS NULL
    GROUP BY bucket_key
    ORDER BY bucket_key ASC
  `;
  const fromIso = from.toISOString();
  const toIso = to.toISOString();
  return db.prepare(sql).all(fromIso, toIso) as RawBucketRow[];
}

type CodexTokenSumRow = {
  bucket_key: string;
  total_tokens: number;
  input_tokens: number;
  output_tokens: number;
  reasoning_output_tokens: number;
  cached_input_tokens: number;
};

/**
 * Codex token sums bucketed by `event_at` (the per-event timeline), joined to
 * the per-session table so the same `token_status='full'` + `missing_since IS
 * NULL` filters apply. `total = input + output` (Codex/OpenAI semantics, same
 * as the session table's `total_tokens`); reasoning is a subset of output,
 * reported separately.
 */
function queryCodexTokenSumsByBucket(
  db: Database.Database,
  from: Date,
  to: Date,
  granularity: BucketGranularity
): CodexTokenSumRow[] {
  const sql = `
    SELECT
      ${bucketExpr(granularity, "e.event_at")} AS bucket_key,
      COALESCE(SUM(e.input_tokens + e.output_tokens), 0) AS total_tokens,
      COALESCE(SUM(e.input_tokens), 0) AS input_tokens,
      COALESCE(SUM(e.output_tokens), 0) AS output_tokens,
      COALESCE(SUM(e.reasoning_output_tokens), 0) AS reasoning_output_tokens,
      COALESCE(SUM(e.cached_input_tokens), 0) AS cached_input_tokens
    FROM codex_token_usage_event e
    JOIN codex_session_token_usage s ON s.session_id = e.session_id
    WHERE e.event_at >= ?
      AND e.event_at < ?
      AND s.missing_since IS NULL
      AND s.token_status = 'full'
    GROUP BY bucket_key
    ORDER BY bucket_key ASC
  `;
  return db
    .prepare(sql)
    .all(from.toISOString(), to.toISOString()) as CodexTokenSumRow[];
}

/**
 * Codex bucket rows: token sums from the per-event timeline (bucketed by the
 * day each token was consumed), session counts / coverage from the per-session
 * table (bucketed by `last_updated_at`, unchanged). A bucket can therefore have
 * tokens with `session_count = 0` (a still-running session consumed tokens that
 * day but was last *touched* on a later day) — that's honest, and the per-bucket
 * session-count detail only surfaces in the tooltip when coverage is partial.
 */
function queryCodexBuckets(
  db: Database.Database,
  from: Date,
  to: Date,
  granularity: BucketGranularity
): RawBucketRow[] {
  const byKey = new Map<string, RawBucketRow>();
  // Counts / coverage from the session table; zero the token fields — they'll
  // be replaced by the event-timeline sums below.
  for (const c of querySessionTableBuckets(db, "codex", from, to, granularity)) {
    byKey.set(c.bucket_key, {
      ...c,
      total_tokens: 0,
      input_tokens: 0,
      output_tokens: 0,
      reasoning_output_tokens: 0,
      codex_cached_input_tokens: 0,
    });
  }
  // Token sums from the per-event timeline.
  for (const t of queryCodexTokenSumsByBucket(db, from, to, granularity)) {
    const existing = byKey.get(t.bucket_key);
    if (existing) {
      existing.total_tokens = t.total_tokens;
      existing.input_tokens = t.input_tokens;
      existing.output_tokens = t.output_tokens;
      existing.reasoning_output_tokens = t.reasoning_output_tokens;
      existing.codex_cached_input_tokens = t.cached_input_tokens;
    } else {
      byKey.set(t.bucket_key, {
        bucket_key: t.bucket_key,
        total_tokens: t.total_tokens,
        input_tokens: t.input_tokens,
        output_tokens: t.output_tokens,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
        reasoning_output_tokens: t.reasoning_output_tokens,
        codex_cached_input_tokens: t.cached_input_tokens,
        session_count: 0,
        full_count: 0,
        unknown_count: 0,
        error_count: 0,
      });
    }
  }
  return [...byKey.values()].sort((a, b) =>
    a.bucket_key < b.bucket_key ? -1 : a.bucket_key > b.bucket_key ? 1 : 0
  );
}

/**
 * Zero-fill: take per-source raw rows + the enumerated continuous buckets,
 * and produce one `WorkTokensTrendBucket` per enumerated bucket. Buckets
 * with no row for a source default to 0 for every field of that source.
 */
export function mergeAndZeroFill(
  bucketKeys: { key: string; start: Date; end: Date }[],
  claudeRows: RawBucketRow[],
  codexRows: RawBucketRow[]
): WorkTokensTrendBucket[] {
  const claudeMap = new Map(claudeRows.map((r) => [r.bucket_key, r]));
  const codexMap = new Map(codexRows.map((r) => [r.bucket_key, r]));
  return bucketKeys.map((b) => {
    const c = claudeMap.get(b.key);
    const x = codexMap.get(b.key);
    return {
      bucketStart: b.start.toISOString(),
      bucketEnd: b.end.toISOString(),
      claudeTokens: c?.total_tokens ?? 0,
      codexTokens: x?.total_tokens ?? 0,
      claudeInputTokens: c?.input_tokens ?? 0,
      claudeOutputTokens: c?.output_tokens ?? 0,
      codexInputTokens: x?.input_tokens ?? 0,
      codexOutputTokens: x?.output_tokens ?? 0,
      claudeCacheReadInputTokens: c?.cache_read_input_tokens ?? 0,
      claudeCacheCreationInputTokens: c?.cache_creation_input_tokens ?? 0,
      codexReasoningOutputTokens: x?.reasoning_output_tokens ?? 0,
      codexCachedInputTokens: x?.codex_cached_input_tokens ?? 0,
      // Cost is patched in by the service after pricing (separate path).
      claudeCostUsd: 0,
      codexCostUsd: 0,
      claudeSessionCount: c?.session_count ?? 0,
      codexSessionCount: x?.session_count ?? 0,
      claudeCoveredSessionCount: c?.full_count ?? 0,
      codexCoveredSessionCount: x?.full_count ?? 0,
      claudeUnknownSessionCount: c?.unknown_count ?? 0,
      codexUnknownSessionCount: x?.unknown_count ?? 0,
      claudeErrorSessionCount: c?.error_count ?? 0,
      codexErrorSessionCount: x?.error_count ?? 0,
    };
  });
}

/**
 * Aggregate the per-bucket DTOs into the standalone Totals card.
 *
 * Coverage derivation (3-state, F2):
 *   - all sessions full (or zero sessions) → "full"
 *   - some full + some not  → "partial"
 *   - no full sessions       → "unknown"
 *
 * "error" sessions count as non-full for coverage purposes (they don't have
 * usable token numbers), but they're reported separately so the UI can
 * distinguish "we don't know" from "the parser broke".
 */
export function computeTotals(
  buckets: WorkTokensTrendBucket[]
): WorkTokensTrendTotals {
  let claudeTokens = 0;
  let codexTokens = 0;
  let claudeInputTokens = 0;
  let claudeOutputTokens = 0;
  let codexInputTokens = 0;
  let codexOutputTokens = 0;
  let claudeCacheReadInputTokens = 0;
  let claudeCacheCreationInputTokens = 0;
  let codexReasoningOutputTokens = 0;
  let codexCachedInputTokens = 0;
  let claudeCostUsd = 0;
  let codexCostUsd = 0;
  let coveredSessionCount = 0;
  let unknownSessionCount = 0;
  let errorSessionCount = 0;
  for (const b of buckets) {
    claudeTokens += b.claudeTokens;
    codexTokens += b.codexTokens;
    claudeInputTokens += b.claudeInputTokens;
    claudeOutputTokens += b.claudeOutputTokens;
    codexInputTokens += b.codexInputTokens;
    codexOutputTokens += b.codexOutputTokens;
    claudeCacheReadInputTokens += b.claudeCacheReadInputTokens;
    claudeCacheCreationInputTokens += b.claudeCacheCreationInputTokens;
    codexReasoningOutputTokens += b.codexReasoningOutputTokens;
    codexCachedInputTokens += b.codexCachedInputTokens;
    claudeCostUsd += b.claudeCostUsd;
    codexCostUsd += b.codexCostUsd;
    coveredSessionCount +=
      b.claudeCoveredSessionCount + b.codexCoveredSessionCount;
    unknownSessionCount +=
      b.claudeUnknownSessionCount + b.codexUnknownSessionCount;
    errorSessionCount +=
      b.claudeErrorSessionCount + b.codexErrorSessionCount;
  }
  const totalTokens = claudeTokens + codexTokens;
  const totalSessionCount =
    coveredSessionCount + unknownSessionCount + errorSessionCount;

  let coverage: WorkTokensTrendCoverage;
  if (totalSessionCount === 0) {
    coverage = "full"; // zero sessions = trivially fully accounted for
  } else if (coveredSessionCount === totalSessionCount) {
    coverage = "full";
  } else if (coveredSessionCount === 0) {
    coverage = "unknown";
  } else {
    coverage = "partial";
  }

  return {
    totalTokens,
    claudeTokens,
    codexTokens,
    claudeInputTokens,
    claudeOutputTokens,
    codexInputTokens,
    codexOutputTokens,
    claudeCacheReadInputTokens,
    claudeCacheCreationInputTokens,
    codexReasoningOutputTokens,
    codexCachedInputTokens,
    totalCostUsd: claudeCostUsd + codexCostUsd,
    claudeCostUsd,
    codexCostUsd,
    // unpricedTokenCount is patched in by the service (cross-cutting, not
    // derivable from per-bucket DTOs); default 0 here.
    unpricedTokenCount: 0,
    priceSnapshotDate: PRICE_SNAPSHOT_DATE,
    claudeShare: totalTokens === 0 ? 0 : claudeTokens / totalTokens,
    codexShare: totalTokens === 0 ? 0 : codexTokens / totalTokens,
    coverage,
    coveredSessionCount,
    unknownSessionCount,
    errorSessionCount,
    totalSessionCount,
  };
}

/**
 * Strictly-preceding equal-length window total. Returns 0 (never null) when
 * the prior range has no qualifying sessions — design doc F2 / Open Questions.
 *
 * Also returns the Claude `cache_read_input_tokens` summed over the SAME prior
 * window so the frontend "exclude cache hits" toggle can recompute the
 * comparison total (prev − cacheRead) consistently with the rest of the page.
 */
export function computePreviousWindowTotal(
  db: Database.Database,
  from: Date,
  to: Date
): {
  total: number;
  claudeCacheReadInputTokens: number;
  codexCachedInputTokens: number;
} {
  const span = to.getTime() - from.getTime();
  const prevFrom = new Date(from.getTime() - span);
  const prevTo = new Date(from.getTime());

  // Claude from its per-session table (bucketed by last_updated_at); Codex from
  // the per-event timeline (bucketed by event_at) so the comparison window
  // matches how the bars distribute resumed-session tokens by consumption day.
  const sql = `
    SELECT
      COALESCE(SUM(total_tokens), 0) AS total,
      COALESCE(SUM(claude_cache_read), 0) AS claude_cache_read,
      COALESCE(SUM(codex_cached), 0) AS codex_cached
    FROM (
      SELECT total_tokens,
             cache_read_input_tokens AS claude_cache_read,
             0 AS codex_cached
        FROM claude_session_token_usage
       WHERE last_updated_at >= ?
         AND last_updated_at < ?
         AND missing_since IS NULL
         AND token_status = 'full'
      UNION ALL
      SELECT (e.input_tokens + e.output_tokens) AS total_tokens,
             0 AS claude_cache_read,
             e.cached_input_tokens AS codex_cached
        FROM codex_token_usage_event e
        JOIN codex_session_token_usage s ON s.session_id = e.session_id
       WHERE e.event_at >= ?
         AND e.event_at < ?
         AND s.missing_since IS NULL
         AND s.token_status = 'full'
    )
  `;
  const fromIso = prevFrom.toISOString();
  const toIso = prevTo.toISOString();
  const row = db.prepare(sql).get(fromIso, toIso, fromIso, toIso) as {
    total: number;
    claude_cache_read: number;
    codex_cached: number;
  };
  return {
    total: row.total,
    claudeCacheReadInputTokens: row.claude_cache_read,
    codexCachedInputTokens: row.codex_cached,
  };
}

/**
 * MIN / MAX of `last_updated_at` across both token tables, projected to local
 * YYYY-MM strings. When both tables are empty, fall back to the current local
 * month so the picker still has a usable lower bound.
 */
export function computeMonthRange(
  db: Database.Database,
  now: Date = new Date()
): MonthRange {
  const sql = `
    SELECT
      MIN(local_month) AS earliest,
      MAX(local_month) AS latest
    FROM (
      SELECT strftime('%Y-%m', last_updated_at, 'localtime') AS local_month
        FROM claude_session_token_usage
       WHERE missing_since IS NULL
      UNION ALL
      SELECT strftime('%Y-%m', last_updated_at, 'localtime') AS local_month
        FROM codex_session_token_usage
       WHERE missing_since IS NULL
    )
  `;
  const row = db.prepare(sql).get() as {
    earliest: string | null;
    latest: string | null;
  };
  if (row.earliest && row.latest) {
    return { earliest: row.earliest, latest: row.latest };
  }
  const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  return { earliest: currentMonth, latest: currentMonth };
}
