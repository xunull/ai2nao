import type Database from "better-sqlite3";
import {
  assertMonthInDepth,
  iterateBuckets,
  monthToRange,
  previousWindowRange,
  windowToRange,
} from "./bucket.js";
import {
  computeMonthRange,
  computePreviousWindowTotal,
  computeTotals,
  mergeAndZeroFill,
  priceCostByBucket,
  queryBucketsBySource,
} from "./queries.js";
import {
  isMonthKey,
  isWindowKey,
  windowToGranularity,
  type MonthKey,
  type WindowKey,
  type WorkTokensTrendDiagnostic,
  type WorkTokensTrendResponse,
} from "./types.js";

export type GenerateTrendArgs = {
  window?: WindowKey;
  month?: MonthKey;
  /** Override clock (tests). */
  now?: Date;
};

/**
 * Orchestrate one trend response.
 *
 * Param contract:
 *   - exactly one of `window` / `month` should be provided
 *   - if both arrive, `month` wins (matches design doc Open Questions)
 *   - if neither, default to `window: "1w"` (page default)
 *   - invalid values → `Error` (route handler turns into 400)
 *
 * Each source query is wrapped in try/catch so one failing table (e.g.
 * Codex schema drift) does not 500 the whole route. The other source's
 * data still surfaces with a diagnostic.
 */
export function generateTrend(
  db: Database.Database,
  args: GenerateTrendArgs
): WorkTokensTrendResponse {
  const now = args.now ?? new Date();

  // Month-mode wins if both provided.
  if (args.month !== undefined) {
    return generateMonth(db, args.month, now);
  }
  if (args.window !== undefined) {
    return generateWindow(db, args.window, now);
  }
  return generateWindow(db, "1w", now);
}

function generateMonth(
  db: Database.Database,
  rawMonth: unknown,
  now: Date
): WorkTokensTrendResponse {
  if (!isMonthKey(rawMonth)) {
    throw new Error(
      `invalid month parameter: expected YYYY-MM, got ${JSON.stringify(rawMonth)}`
    );
  }
  const monthKey = rawMonth;
  assertMonthInDepth(monthKey, now);
  const { from, to } = monthToRange(monthKey);
  const granularity = "day" as const;
  const buckets = enumerateAndAggregate(db, from, to, granularity);
  return {
    ok: true,
    generatedAt: now.toISOString(),
    mode: "month",
    monthKey,
    range: { from: from.toISOString(), to: to.toISOString() },
    bucketGranularity: granularity,
    buckets: buckets.data,
    totals: buckets.totals,
    monthRange: safeMonthRange(db, now, buckets.diagnostics),
    diagnostics: buckets.diagnostics,
  };
}

function generateWindow(
  db: Database.Database,
  rawWindow: unknown,
  now: Date
): WorkTokensTrendResponse {
  if (!isWindowKey(rawWindow)) {
    throw new Error(
      `invalid window parameter: expected one of 1d|3d|1w|2w|1m|3m|6m, got ${JSON.stringify(rawWindow)}`
    );
  }
  const windowKey = rawWindow;
  const granularity = windowToGranularity(windowKey);
  const { from, to } = windowToRange(windowKey, now);
  const buckets = enumerateAndAggregate(db, from, to, granularity);
  const prev = safePreviousWindowTotal(db, from, to, buckets.diagnostics);
  const previousWindowTotal = prev.total;
  const deltaRatio =
    previousWindowTotal === 0
      ? null
      : (buckets.totals.totalTokens - previousWindowTotal) / previousWindowTotal;
  return {
    ok: true,
    generatedAt: now.toISOString(),
    mode: "window",
    windowKey,
    range: { from: from.toISOString(), to: to.toISOString() },
    bucketGranularity: granularity,
    buckets: buckets.data,
    totals: buckets.totals,
    previousWindowTotal,
    previousWindowClaudeCacheReadInputTokens: prev.claudeCacheReadInputTokens,
    previousWindowCodexCachedInputTokens: prev.codexCachedInputTokens,
    previousWindowMinimaxCacheTokens: prev.minimaxCacheTokens,
    deltaRatio,
    monthRange: safeMonthRange(db, now, buckets.diagnostics),
    diagnostics: buckets.diagnostics,
  };
}

function safeMonthRange(
  db: Database.Database,
  now: Date,
  diagnostics: WorkTokensTrendDiagnostic[]
): ReturnType<typeof computeMonthRange> {
  try {
    return computeMonthRange(db, now);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    diagnostics.push({
      severity: "warning",
      kind: "month_range_query_failed",
      message: `month range query failed (likely schema drift); month picker depth fallback: ${msg}`,
    });
    const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
    return { earliest: currentMonth, latest: currentMonth };
  }
}

function enumerateAndAggregate(
  db: Database.Database,
  from: Date,
  to: Date,
  granularity: ReturnType<typeof windowToGranularity> | "day"
): {
  data: ReturnType<typeof mergeAndZeroFill>;
  totals: ReturnType<typeof computeTotals>;
  diagnostics: WorkTokensTrendDiagnostic[];
} {
  const diagnostics: WorkTokensTrendDiagnostic[] = [];
  const bucketKeys = iterateBuckets(from, to, granularity);

  const claudeRows = safeQuery(db, "claude", from, to, granularity, diagnostics);
  const codexRows = safeQuery(db, "codex", from, to, granularity, diagnostics);
  // MiniMax is a remote billing-history source; isolated like the others so a
  // failed/absent endpoint never 500s the local sources' trend.
  const minimaxRows = safeQuery(db, "minimax", from, to, granularity, diagnostics);

  // Key conversion: SQL bucketExpr emits local-time string keys; we already
  // matched the format in `bucket.fmtLocal()` via `iterateBuckets().key`, so
  // bucketKeys[i].key === claudeRows[j].bucket_key when they refer to the
  // same bucket. mergeAndZeroFill maps them.
  const data = mergeAndZeroFill(
    bucketKeys.map((b) => ({ key: b.key, start: b.start, end: b.end })),
    claudeRows,
    codexRows,
    minimaxRows
  );

  // USD cost: priced separately (per bucket+model via the static snapshot), then
  // patched onto each bucket DTO. Isolated so a pricing error can't 500 tokens.
  let unpricedTokenCount = 0;
  let priceSnapshotDate: string | null = null;
  try {
    const cost = priceCostByBucket(db, from, to, granularity);
    unpricedTokenCount = cost.unpricedTokenCount;
    priceSnapshotDate = cost.priceSnapshotDate;
    // cost.byBucket is keyed by the local-time bucketExpr key; the DTO carries
    // bucketStart (ISO). Remap via the enumerated bucketKeys.
    const keyByStart = new Map(
      bucketKeys.map((b) => [b.start.toISOString(), b.key])
    );
    for (const b of data) {
      const costKey = keyByStart.get(b.bucketStart);
      const c = costKey ? cost.byBucket.get(costKey) : undefined;
      if (c) {
        b.claudeCostUsd = c.claudeCostUsd;
        b.codexCostUsd = c.codexCostUsd;
      }
    }
  } catch (e) {
    diagnostics.push({
      severity: "warning",
      kind: "cost_pricing_failed",
      message: `cost pricing failed: ${e instanceof Error ? e.message : String(e)}`,
    });
  }

  const totals = computeTotals(data);
  totals.unpricedTokenCount = unpricedTokenCount;
  if (priceSnapshotDate) totals.priceSnapshotDate = priceSnapshotDate;
  return { data, totals, diagnostics };
}

function safeQuery(
  db: Database.Database,
  source: "claude" | "codex" | "minimax",
  from: Date,
  to: Date,
  granularity: ReturnType<typeof windowToGranularity> | "day",
  diagnostics: WorkTokensTrendDiagnostic[]
): ReturnType<typeof queryBucketsBySource> {
  try {
    return queryBucketsBySource(db, source, from, to, granularity);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    diagnostics.push({
      severity: "error",
      kind: "source_query_failed",
      message: `${source} token table query failed: ${msg}`,
    });
    return [];
  }
}

function safePreviousWindowTotal(
  db: Database.Database,
  from: Date,
  to: Date,
  diagnostics: WorkTokensTrendDiagnostic[]
): {
  total: number;
  claudeCacheReadInputTokens: number;
  codexCachedInputTokens: number;
  minimaxCacheTokens: number;
} {
  try {
    return computePreviousWindowTotal(db, from, to);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    diagnostics.push({
      severity: "warning",
      kind: "previous_window_query_failed",
      message: `previous window total query failed: ${msg}`,
    });
    return {
      total: 0,
      claudeCacheReadInputTokens: 0,
      codexCachedInputTokens: 0,
      minimaxCacheTokens: 0,
    };
  }
}

/** Exposed for tests so they can stub clock + ranges. */
export const __testing = {
  previousWindowRange,
};
