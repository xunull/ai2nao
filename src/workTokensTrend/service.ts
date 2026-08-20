import type Database from "better-sqlite3";
import {
  assertMonthInDepth,
  iterateBuckets,
  monthToRange,
  previousWindowRange,
  windowToRange,
} from "./bucket.js";
import { ADAPTERS, type SourceBucketRow } from "./adapters.js";
import {
  computeMonthRange,
  computePreviousWindow,
  computeTotals,
  mergeAndZeroFill,
  priceCostByBucket,
  type BucketRowsBySource,
} from "./queries.js";
import {
  isMonthKey,
  isWindowKey,
  TOKEN_SOURCES,
  windowToGranularity,
  type MonthKey,
  type SourceCapabilities,
  type SourceState,
  type TokenSourceKey,
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

/** 各源具备哪些维度。从 adapter 注册表读,不手写。 */
function capabilitiesOf(): Record<TokenSourceKey, SourceCapabilities> {
  const out = {} as Record<TokenSourceKey, SourceCapabilities>;
  for (const key of TOKEN_SOURCES) out[key] = ADAPTERS[key].capabilities;
  return out;
}

/**
 * 组装一次趋势响应。
 *
 * 参数契约:
 *   - `window` / `month` 恰好给一个
 *   - 两个都给 → `month` 胜
 *   - 都不给 → 默认 `window: "1w"`(页面默认)
 *   - 非法值 → 抛 `Error`(路由转 400)
 *
 * 每个源的查询各自 try/catch:一家的表坏了不会 500 掉整个路由,
 * 而且**失败会以 `state: "failed"` 出现在响应里**,不是静静地变成 0。
 */
export function generateTrend(
  db: Database.Database,
  args: GenerateTrendArgs
): WorkTokensTrendResponse {
  const now = args.now ?? new Date();
  if (args.month !== undefined) return generateMonth(db, args.month, now);
  if (args.window !== undefined) return generateWindow(db, args.window, now);
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
  const agg = enumerateAndAggregate(db, from, to, granularity);
  return {
    ok: true,
    generatedAt: now.toISOString(),
    mode: "month",
    monthKey,
    range: { from: from.toISOString(), to: to.toISOString() },
    bucketGranularity: granularity,
    buckets: agg.data,
    totals: agg.totals,
    capabilities: capabilitiesOf(),
    monthRange: safeMonthRange(db, now, agg.diagnostics),
    diagnostics: agg.diagnostics,
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
  const agg = enumerateAndAggregate(db, from, to, granularity);
  const previousWindow = computePreviousWindow(db, from, to, (key, msg) => {
    agg.diagnostics.push({
      severity: "warning",
      kind: "previous_window_query_failed",
      message: `${key} previous window query failed: ${msg}`,
    });
  });
  const prevTotal = previousWindow.totalTokens;
  const deltaRatio =
    prevTotal === 0 ? null : (agg.totals.totalTokens - prevTotal) / prevTotal;
  return {
    ok: true,
    generatedAt: now.toISOString(),
    mode: "window",
    windowKey,
    range: { from: from.toISOString(), to: to.toISOString() },
    bucketGranularity: granularity,
    buckets: agg.data,
    totals: agg.totals,
    capabilities: capabilitiesOf(),
    previousWindow,
    deltaRatio,
    monthRange: safeMonthRange(db, now, agg.diagnostics),
    diagnostics: agg.diagnostics,
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

export function enumerateAndAggregate(
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

  const bySource = {} as BucketRowsBySource;
  const states = {} as Record<TokenSourceKey, SourceState>;

  for (const key of TOKEN_SOURCES) {
    const adapter = ADAPTERS[key];
    // presence 先判:「查不到数据」与「这台机器没这个源」是两件事,
    // 空数组区分不了(没装 / 装了但没会话 / 同步没跑 / 扫描失败留下空表)。
    //
    // presence 探测**本身抛异常**属于第三种情况:表被删了或 schema 漂移。
    // 那是 failed,不是 absent —— 把损坏报成「你不用这个源」比不报还糟。
    let rows: SourceBucketRow[] = [];
    let state: SourceState;
    try {
      state = adapter.probePresence(db) ? "ok" : "absent";
      if (state === "ok") rows = adapter.queryBuckets(db, from, to, granularity);
    } catch (e) {
      state = "failed";
      rows = [];
      diagnostics.push({
        severity: "error",
        kind: "source_query_failed",
        message: `${key} token table query failed: ${
          e instanceof Error ? e.message : String(e)
        }`,
      });
    }
    states[key] = state;
    bySource[key] = new Map(rows.map((r) => [r.bucket_key, r]));
  }

  const data = mergeAndZeroFill(
    bucketKeys.map((b) => ({ key: b.key, start: b.start, end: b.end })),
    bySource,
    states
  );

  // 定价单独隔离:算不出成本不能拖垮 token 数字。
  let priceSnapshotDate: string | null = null;
  try {
    const cost = priceCostByBucket(db, from, to, granularity);
    priceSnapshotDate = cost.priceSnapshotDate;
    const keyByStart = new Map(bucketKeys.map((b) => [b.start.toISOString(), b.key]));
    for (const b of data) {
      const costKey = keyByStart.get(b.bucketStart);
      const cell = costKey ? cost.byBucket.get(costKey) : undefined;
      for (const key of TOKEN_SOURCES) {
        const c = cell?.[key];
        if (c) {
          b.sources[key].costUsd = c.costUsd;
          b.sources[key].pricedTokens = c.priced;
          b.sources[key].unpricedTokens = c.unpriced;
        }
        // 注意:没有定价概念的源(MiniMax)这里**暂不**把 token 计进 unpriced。
        // 那是 T7(X4)的改动 —— 它会改变 totals.unpricedTokenCount,属于
        // 「故意改数」,必须与黄金快照的层二差异清单一起落,不能混进 T3。
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
  if (priceSnapshotDate) totals.priceSnapshotDate = priceSnapshotDate;
  return { data, totals, diagnostics };
}

/** Exposed for tests so they can stub clock + ranges. */
export const __testing = {
  previousWindowRange,
};
