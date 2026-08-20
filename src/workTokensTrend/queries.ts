import type Database from "better-sqlite3";
import { computeCost, PRICE_SNAPSHOT_DATE } from "../cost/pricing.js";
import { latestSyncedAt, loadPriceMap } from "../cost/priceStore.js";
import { ADAPTERS, type SourceBucketRow } from "./adapters.js";
import {
  emptyUsage,
  TOKEN_SOURCES,
  totalTokens,
  type BucketGranularity,
  type MonthRange,
  type PreviousWindow,
  type CoverageUnit,
  type SourceCostState,
  type SourceUsage,
  type TokenSourceKey,
  type WorkTokensTrendBucket,
  type WorkTokensTrendCoverage,
  type WorkTokensTrendTotals,
} from "./types.js";

/**
 * 聚合层。SQL 全在 `adapters.ts` 里,这里只做「合并、补零、汇总、定价」。
 *
 * 归一之前这里有 800 行,其中一半是三个源各自的查询函数与
 * `source === "claude" ? … : "0"` 这类拼 SQL 的三元。那些已经搬进各自的 adapter。
 */

/** 一个源在一个桶里的原始行,按 bucket_key 索引。 */
export type BucketRowsBySource = Record<TokenSourceKey, Map<string, SourceBucketRow>>;

/** 把 adapter 出的行转成 `SourceUsage`。`state` 由调用方决定(ok / failed / absent)。 */
function rowToUsage(r: SourceBucketRow | undefined, state: SourceUsage["state"]): SourceUsage {
  const u = emptyUsage(state);
  if (!r) return u;
  u.freshInput = r.fresh_input;
  u.cacheReadInput = r.cache_read_input;
  u.cacheCreationInput = r.cache_creation_input;
  u.output = r.output;
  u.reasoningOutput = r.reasoning_output;
  u.sessionCount = r.session_count;
  u.coveredSessionCount = r.full_count;
  u.unknownSessionCount = r.unknown_count;
  u.errorSessionCount = r.error_count;
  return u;
}

/**
 * 枚举出的桶 × 各源的行 → 完整的桶数组(缺的补零)。
 *
 * `states` 决定每个源在**所有**桶里的 state:查询抛了就是 `failed`,
 * 这台机器没这个源就是 `absent`,否则 `ok`(哪怕这个窗口一行都没有)。
 */
export function mergeAndZeroFill(
  bucketKeys: { key: string; start: Date; end: Date }[],
  bySource: BucketRowsBySource,
  states: Record<TokenSourceKey, SourceUsage["state"]>
): WorkTokensTrendBucket[] {
  return bucketKeys.map((b) => {
    const sources = {} as Record<TokenSourceKey, SourceUsage>;
    for (const key of TOKEN_SOURCES) {
      sources[key] = rowToUsage(bySource[key].get(b.key), states[key]);
    }
    return {
      bucketStart: b.start.toISOString(),
      bucketEnd: b.end.toISOString(),
      sources,
    };
  });
}

/** 逐源把桶里的分量加起来。 */
function sumUsage(a: SourceUsage, b: SourceUsage): SourceUsage {
  return {
    // state 取「更坏」的那个:failed > absent > ok。桶之间理论上同 state,
    // 这里的合并只是防御。
    state: a.state === "failed" || b.state === "failed" ? "failed"
      : a.state === "absent" || b.state === "absent" ? "absent"
      : "ok",
    freshInput: a.freshInput + b.freshInput,
    cacheReadInput: a.cacheReadInput + b.cacheReadInput,
    cacheCreationInput: a.cacheCreationInput + b.cacheCreationInput,
    output: a.output + b.output,
    reasoningOutput: a.reasoningOutput + b.reasoningOutput,
    costUsd: a.costUsd + b.costUsd,
    pricedTokens: a.pricedTokens + b.pricedTokens,
    unpricedTokens: a.unpricedTokens + b.unpricedTokens,
    sessionCount: a.sessionCount + b.sessionCount,
    coveredSessionCount: a.coveredSessionCount + b.coveredSessionCount,
    unknownSessionCount: a.unknownSessionCount + b.unknownSessionCount,
    errorSessionCount: a.errorSessionCount + b.errorSessionCount,
  };
}

/** 成本可信度:全定价 / 部分 / 一条都没有。布尔说不清中间那档。 */
function costStateOf(u: SourceUsage): SourceCostState {
  if (u.pricedTokens === 0) return "none";
  return u.unpricedTokens === 0 ? "full" : "partial";
}

export function computeTotals(buckets: WorkTokensTrendBucket[]): WorkTokensTrendTotals {
  const acc = {} as Record<TokenSourceKey, SourceUsage>;
  for (const key of TOKEN_SOURCES) {
    acc[key] = buckets.reduce(
      (sum, b) => sumUsage(sum, b.sources[key]),
      emptyUsage(buckets[0]?.sources[key].state ?? "ok")
    );
  }

  const grand = TOKEN_SOURCES.reduce((n, k) => n + totalTokens(acc[k]), 0);

  const sources = {} as WorkTokensTrendTotals["sources"];
  const costState = {} as Record<TokenSourceKey, SourceCostState>;
  let totalCostUsd = 0;
  let unpricedTokenCount = 0;
  let covered = 0;
  let unknown = 0;
  let errored = 0;
  const unitsPresent = new Set<Exclude<CoverageUnit, null>>();

  for (const key of TOKEN_SOURCES) {
    const u = acc[key];
    sources[key] = { ...u, share: grand === 0 ? 0 : totalTokens(u) / grand };
    costState[key] = costStateOf(u);
    totalCostUsd += u.costUsd;
    unpricedTokenCount += u.unpricedTokens;
    // ⚠️ 只累加有覆盖概念的源,且**记下它们的单位** —— 单位不同不能相加。
    const unit = ADAPTERS[key].capabilities.coverageUnit;
    if (unit !== null) {
      unitsPresent.add(unit);
      covered += u.coveredSessionCount;
      unknown += u.unknownSessionCount;
      errored += u.errorSessionCount;
    }
  }
  // 总数由三态相加得出,不用 COUNT(*) —— 与归一之前一致。
  const sessionTotal = covered + unknown + errored;

  // 单位不一致时汇总没有统计意义 —— 明说 mixed,让前端改成逐源展示,
  // 而不是给出一个把 session 数和 agent 数加在一起的百分比。
  const coverageUnit: WorkTokensTrendTotals["coverageUnit"] =
    unitsPresent.size === 0 ? null : unitsPresent.size === 1 ? [...unitsPresent][0]! : "mixed";

  // 四个分支,与归一之前逐字一致。特别是「零 session → full」:
  // 没有会话就是「该记的都记了」,不是「不知道」。
  let coverage: WorkTokensTrendCoverage;
  if (sessionTotal === 0) coverage = "full";
  else if (covered === sessionTotal) coverage = "full";
  else if (covered === 0) coverage = "unknown";
  else coverage = "partial";

  return {
    totalTokens: grand,
    sources,
    costState,
    totalCostUsd,
    unpricedTokenCount,
    priceSnapshotDate: PRICE_SNAPSHOT_DATE,
    coverage,
    coverageUnit,
    coveredSessionCount: covered,
    unknownSessionCount: unknown,
    errorSessionCount: errored,
    totalSessionCount: sessionTotal,
  };
}

/**
 * 定价。逐源逐 (桶, 模型) 算,没有价格条目的模型**不当成 $0**,
 * 它的 token 进 `unpricedTokens`。没有 `queryCostRows` 的源(MiniMax)全部 unpriced。
 */
export function priceCostByBucket(
  db: Database.Database,
  from: Date,
  to: Date,
  granularity: BucketGranularity
): {
  /** bucket_key → 源 → {costUsd, priced, unpriced} */
  byBucket: Map<string, Record<TokenSourceKey, { costUsd: number; priced: number; unpriced: number }>>;
  priceSnapshotDate: string;
} {
  const byBucket = new Map<
    string,
    Record<TokenSourceKey, { costUsd: number; priced: number; unpriced: number }>
  >();
  const priceMap = loadPriceMap(db);

  const slot = (bucketKey: string) => {
    let cur = byBucket.get(bucketKey);
    if (!cur) {
      cur = {} as Record<TokenSourceKey, { costUsd: number; priced: number; unpriced: number }>;
      for (const k of TOKEN_SOURCES) cur[k] = { costUsd: 0, priced: 0, unpriced: 0 };
      byBucket.set(bucketKey, cur);
    }
    return cur;
  };

  for (const key of TOKEN_SOURCES) {
    const adapter = ADAPTERS[key];
    if (!adapter.queryCostRows) continue; // 无定价概念 → 由下方 unpriced 兜底
    for (const r of adapter.queryCostRows(db, from, to, granularity)) {
      const tokens = r.fresh + r.cache_hit + r.cache_creation + r.output;
      const result = computeCost(
        { fresh: r.fresh, cacheHit: r.cache_hit, cacheCreation: r.cache_creation, output: r.output },
        r.model || null,
        priceMap
      );
      const cell = slot(r.bucket_key)[key];
      if (result.priced) {
        cell.costUsd += result.usd;
        cell.priced += tokens;
      } else {
        cell.unpriced += tokens;
      }
    }
  }

  return { byBucket, priceSnapshotDate: latestSyncedAt(db) ?? PRICE_SNAPSHOT_DATE };
}

/**
 * 全部源的自然月并集范围。每个 adapter 出自己的 min/max,JS 折叠 ——
 * 上一版是一条写死三张表的 UNION,加源必须改 SQL(实测还慢 40ms)。
 */
export function computeMonthRange(
  db: Database.Database,
  now: Date = new Date()
): MonthRange {
  let earliest: string | null = null;
  let latest: string | null = null;
  for (const key of TOKEN_SOURCES) {
    const r = ADAPTERS[key].queryMonthRange(db);
    if (!r) continue;
    if (earliest === null || r.earliest < earliest) earliest = r.earliest;
    if (latest === null || r.latest > latest) latest = r.latest;
  }
  if (earliest && latest) return { earliest, latest };
  const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  return { earliest: currentMonth, latest: currentMonth };
}

/**
 * 上一个等长窗口,逐源给原子分量。
 *
 * 逐 adapter 隔离:上一版是一条跨源 UNION,任一表失败会把**所有源**的环比
 * 一起弄成 0 或 null。现在一家挂掉只影响它自己那一格。
 */
export function computePreviousWindow(
  db: Database.Database,
  from: Date,
  to: Date,
  onError?: (key: TokenSourceKey, message: string) => void
): PreviousWindow {
  const span = to.getTime() - from.getTime();
  const prevFrom = new Date(from.getTime() - span);
  const prevTo = new Date(from.getTime());

  const bySource = {} as PreviousWindow["bySource"];
  let total = 0;
  for (const key of TOKEN_SOURCES) {
    let row = { fresh_input: 0, cache_read_input: 0, cache_creation_input: 0, output: 0 };
    try {
      row = ADAPTERS[key].queryPrevWindow(db, prevFrom, prevTo);
    } catch (e) {
      onError?.(key, e instanceof Error ? e.message : String(e));
    }
    const t = row.fresh_input + row.cache_read_input + row.cache_creation_input + row.output;
    bySource[key] = {
      totalTokens: t,
      freshInput: row.fresh_input,
      cacheReadInput: row.cache_read_input,
      cacheCreationInput: row.cache_creation_input,
    };
    total += t;
  }
  return { totalTokens: total, bySource };
}
