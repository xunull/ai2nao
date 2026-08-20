import type Database from "better-sqlite3";
import { generateTrend, type GenerateTrendArgs } from "./service.js";
import { ADAPTERS, type SourceBucketRow } from "./adapters.js";
import {
  computePreviousWindow,
  computeTotals,
  mergeAndZeroFill,
} from "./queries.js";
import { emptyUsage, inputTokens, totalTokens } from "./types.js";
import type {
  BucketGranularity,
  MonthKey,
  MonthRange,
  TokenSourceKey,
  WindowKey,
  WorkTokensTrendBucket,
  WorkTokensTrendCoverage,
  WorkTokensTrendDiagnostic,
  WorkTokensTrendResponse,
  WorkTokensTrendTotals,
} from "./types.js";

/**
 * **临时兼容层 —— 归一重构期间用,T13 整个删掉。**
 *
 * 为什么存在:87 个现有测试全部写在旧的平铺 DTO 上。归一改的是形状,
 * 改形状就得改测试,而跟着你一起改的测试抓不住你。这一层让旧测试在
 * 整个重构过程中保持绿,当作黄金快照之外的第二层网 —— 单一 PR 里
 * `git bisect` 帮不上忙,这一层就更值。
 *
 * 关键设计:下面的 `Legacy*` 类型是**独立副本**,不是 `types.ts` 的别名。
 * T3 改动真类型之后,这些副本仍钉在旧形状上,于是 TypeScript 会强制
 * `flatten*` 函数真的做转换 —— shim 自己就是编译期自检。
 * 如果写成别名,T3 改完之后这一层会静默地变成恒等函数,一点保护都没有。
 *
 * 现状(T2,新 DTO 还没接上):`flatten*` 是恒等函数,`Legacy*` 与真类型逐字段相同。
 * T3 之后:真类型变成 `Record<TokenSourceKey, SourceUsage>`,这里做平铺展开。
 *
 * ⚠️ 生产代码不许 import 这个文件。只有 `test/` 用。T13 会 grep 确认零残留。
 */

/** 旧的逐源平铺 bucket。**钉死在归一之前的形状,不要跟着新类型改。** */
export type LegacyBucket = {
  bucketStart: string;
  bucketEnd: string;
  claudeTokens: number;
  codexTokens: number;
  minimaxTokens: number;
  claudeInputTokens: number;
  claudeOutputTokens: number;
  codexInputTokens: number;
  codexOutputTokens: number;
  minimaxInputTokens: number;
  minimaxOutputTokens: number;
  claudeCacheReadInputTokens: number;
  claudeCacheCreationInputTokens: number;
  minimaxCacheReadInputTokens: number;
  minimaxCacheCreationInputTokens: number;
  codexReasoningOutputTokens: number;
  codexCachedInputTokens: number;
  claudeCostUsd: number;
  codexCostUsd: number;
  claudeSessionCount: number;
  codexSessionCount: number;
  claudeCoveredSessionCount: number;
  codexCoveredSessionCount: number;
  claudeUnknownSessionCount: number;
  codexUnknownSessionCount: number;
  claudeErrorSessionCount: number;
  codexErrorSessionCount: number;
};

/** 旧的逐源平铺 totals。**钉死在归一之前的形状。** */
export type LegacyTotals = {
  totalTokens: number;
  claudeTokens: number;
  codexTokens: number;
  minimaxTokens: number;
  claudeInputTokens: number;
  claudeOutputTokens: number;
  codexInputTokens: number;
  codexOutputTokens: number;
  minimaxInputTokens: number;
  minimaxOutputTokens: number;
  claudeCacheReadInputTokens: number;
  claudeCacheCreationInputTokens: number;
  codexReasoningOutputTokens: number;
  codexCachedInputTokens: number;
  minimaxCacheReadInputTokens: number;
  minimaxCacheCreationInputTokens: number;
  totalCostUsd: number;
  claudeCostUsd: number;
  codexCostUsd: number;
  unpricedTokenCount: number;
  priceSnapshotDate: string;
  claudeShare: number;
  codexShare: number;
  minimaxShare: number;
  coverage: WorkTokensTrendCoverage;
  coveredSessionCount: number;
  unknownSessionCount: number;
  errorSessionCount: number;
  totalSessionCount: number;
};

/** 旧的响应。**钉死在归一之前的形状。** */
export type LegacyResponse =
  | {
      ok: true;
      generatedAt: string;
      mode: "window";
      windowKey: WindowKey;
      range: { from: string; to: string };
      bucketGranularity: BucketGranularity;
      buckets: LegacyBucket[];
      totals: LegacyTotals;
      previousWindowTotal: number;
      previousWindowClaudeCacheReadInputTokens: number;
      previousWindowCodexCachedInputTokens: number;
      previousWindowMinimaxCacheTokens: number;
      deltaRatio: number | null;
      monthRange: MonthRange;
      diagnostics: WorkTokensTrendDiagnostic[];
    }
  | {
      ok: true;
      generatedAt: string;
      mode: "month";
      monthKey: MonthKey;
      range: { from: string; to: string };
      bucketGranularity: "day";
      buckets: LegacyBucket[];
      totals: LegacyTotals;
      monthRange: MonthRange;
      diagnostics: WorkTokensTrendDiagnostic[];
    };

/** 归一后的一个源 → 旧的平铺字段。派生量用 types.ts 的函数,不在这里手写加减。 */
function flattenBucket(b: WorkTokensTrendBucket): LegacyBucket {
  const c = b.sources.claude;
  const x = b.sources.codex;
  const m = b.sources.minimax;
  return {
    bucketStart: b.bucketStart,
    bucketEnd: b.bucketEnd,
    claudeTokens: totalTokens(c),
    codexTokens: totalTokens(x),
    minimaxTokens: totalTokens(m),
    claudeInputTokens: inputTokens(c),
    claudeOutputTokens: c.output,
    codexInputTokens: inputTokens(x),
    codexOutputTokens: x.output,
    minimaxInputTokens: inputTokens(m),
    minimaxOutputTokens: m.output,
    claudeCacheReadInputTokens: c.cacheReadInput,
    claudeCacheCreationInputTokens: c.cacheCreationInput,
    minimaxCacheReadInputTokens: m.cacheReadInput,
    minimaxCacheCreationInputTokens: m.cacheCreationInput,
    codexReasoningOutputTokens: x.reasoningOutput,
    // 旧名字叫 "cached",归一后它就是 codex 的 cache-read。
    codexCachedInputTokens: x.cacheReadInput,
    claudeCostUsd: c.costUsd,
    codexCostUsd: x.costUsd,
    claudeSessionCount: c.sessionCount,
    codexSessionCount: x.sessionCount,
    claudeCoveredSessionCount: c.coveredSessionCount,
    codexCoveredSessionCount: x.coveredSessionCount,
    claudeUnknownSessionCount: c.unknownSessionCount,
    codexUnknownSessionCount: x.unknownSessionCount,
    claudeErrorSessionCount: c.errorSessionCount,
    codexErrorSessionCount: x.errorSessionCount,
  };
}

function flattenTotals(t: WorkTokensTrendTotals): LegacyTotals {
  const c = t.sources.claude;
  const x = t.sources.codex;
  const m = t.sources.minimax;
  return {
    totalTokens: t.totalTokens,
    claudeTokens: totalTokens(c),
    codexTokens: totalTokens(x),
    minimaxTokens: totalTokens(m),
    claudeInputTokens: inputTokens(c),
    claudeOutputTokens: c.output,
    codexInputTokens: inputTokens(x),
    codexOutputTokens: x.output,
    minimaxInputTokens: inputTokens(m),
    minimaxOutputTokens: m.output,
    claudeCacheReadInputTokens: c.cacheReadInput,
    claudeCacheCreationInputTokens: c.cacheCreationInput,
    codexReasoningOutputTokens: x.reasoningOutput,
    codexCachedInputTokens: x.cacheReadInput,
    minimaxCacheReadInputTokens: m.cacheReadInput,
    minimaxCacheCreationInputTokens: m.cacheCreationInput,
    totalCostUsd: t.totalCostUsd,
    claudeCostUsd: c.costUsd,
    codexCostUsd: x.costUsd,
    unpricedTokenCount: t.unpricedTokenCount,
    priceSnapshotDate: t.priceSnapshotDate,
    claudeShare: c.share,
    codexShare: x.share,
    minimaxShare: m.share,
    coverage: t.coverage,
    coveredSessionCount: t.coveredSessionCount,
    unknownSessionCount: t.unknownSessionCount,
    errorSessionCount: t.errorSessionCount,
    totalSessionCount: t.totalSessionCount,
  };
}

/** 把归一后的响应展开回旧形状。 */
export function flattenResponse(res: WorkTokensTrendResponse): LegacyResponse {
  const common = {
    ok: true as const,
    generatedAt: res.generatedAt,
    range: res.range,
    buckets: res.buckets.map(flattenBucket),
    totals: flattenTotals(res.totals),
    monthRange: res.monthRange,
    diagnostics: res.diagnostics,
  };
  if (res.mode === "month") {
    return { ...common, mode: "month", monthKey: res.monthKey, bucketGranularity: "day" };
  }
  const p = res.previousWindow.bySource;
  return {
    ...common,
    mode: "window",
    windowKey: res.windowKey,
    bucketGranularity: res.bucketGranularity,
    previousWindowTotal: res.previousWindow.totalTokens,
    previousWindowClaudeCacheReadInputTokens: p.claude.cacheReadInput,
    previousWindowCodexCachedInputTokens: p.codex.cacheReadInput,
    // 旧口径:MiniMax 的「cache」是 read + create 两种都算。
    previousWindowMinimaxCacheTokens: p.minimax.cacheReadInput + p.minimax.cacheCreationInput,
    deltaRatio: res.deltaRatio,
  };
}

/**
 * 旧测试的入口。测试文件只改一行 import 就能接上:
 *
 *   - import { generateTrend } from "../src/workTokensTrend/service.js";
 *   + import { generateTrendLegacy as generateTrend } from "../src/workTokensTrend/legacyShape.js";
 *
 * T13 把这几行 import 改回去,然后删掉本文件。
 */
export function generateTrendLegacy(
  db: Database.Database,
  args: GenerateTrendArgs
): LegacyResponse {
  return flattenResponse(generateTrend(db, args));
}

// ── queries.ts 的内部出口 ────────────────────────────────────────────────────
// `workTokensTrend.queries.test.ts` 的 22 个用例直接打这四个函数。X1(只存原子分量)
// 会改掉 RawBucketRow 与 totals 的形状,所以它们也要有钉死的旧副本。

/** 旧的原始行。**钉死在归一之前的形状。** */
export type LegacyRawBucketRow = {
  bucket_key: string;
  total_tokens: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
  reasoning_output_tokens: number;
  codex_cached_input_tokens: number;
  session_count: number;
  full_count: number;
  unknown_count: number;
  error_count: number;
};

/** 旧的环比返回。**钉死在归一之前的形状。** */
export type LegacyPreviousWindow = {
  total: number;
  claudeCacheReadInputTokens: number;
  codexCachedInputTokens: number;
  minimaxCacheTokens: number;
};

/** 原子分量 → 旧的融合行。`codex_cached_input_tokens` 就是 codex 的 cache-read。 */
function toLegacyRow(r: SourceBucketRow, key: TokenSourceKey): LegacyRawBucketRow {
  const input = r.fresh_input + r.cache_read_input + r.cache_creation_input;
  return {
    bucket_key: r.bucket_key,
    total_tokens: input + r.output,
    input_tokens: input,
    output_tokens: r.output,
    cache_read_input_tokens: key === "codex" ? 0 : r.cache_read_input,
    cache_creation_input_tokens: r.cache_creation_input,
    reasoning_output_tokens: r.reasoning_output,
    codex_cached_input_tokens: key === "codex" ? r.cache_read_input : 0,
    session_count: r.session_count,
    full_count: r.full_count,
    unknown_count: r.unknown_count,
    error_count: r.error_count,
  };
}

/**
 * 旧的融合行 → 原子分量。`mergeAndZeroFillLegacy` 要把测试传进来的行喂回新实现。
 *
 * ⚠️ 旧测试普遍只写它关心的那几个字段(`RawBucketRow` 的其余项靠 `as` 蒙混),
 * 所以这里每一项都要 `?? 0` —— 否则 `undefined - undefined` 得 NaN,
 * 而 NaN 会一路流到断言里变成「expected NaN to be 1000」。
 */
function fromLegacyRow(r: Partial<LegacyRawBucketRow> & { bucket_key: string }): SourceBucketRow {
  const n = (v: number | undefined) => v ?? 0;
  const cacheRead = n(r.cache_read_input_tokens) + n(r.codex_cached_input_tokens);
  return {
    bucket_key: r.bucket_key,
    fresh_input: n(r.input_tokens) - cacheRead - n(r.cache_creation_input_tokens),
    cache_read_input: cacheRead,
    cache_creation_input: n(r.cache_creation_input_tokens),
    output: n(r.output_tokens),
    reasoning_output: n(r.reasoning_output_tokens),
    session_count: n(r.session_count),
    full_count: n(r.full_count),
    unknown_count: n(r.unknown_count),
    error_count: n(r.error_count),
  };
}

export function queryBucketsBySourceLegacy(
  db: Database.Database,
  source: TokenSourceKey,
  from: Date,
  to: Date,
  granularity: BucketGranularity
): LegacyRawBucketRow[] {
  return ADAPTERS[source]
    .queryBuckets(db, from, to, granularity)
    .map((r) => toLegacyRow(r, source));
}

export function mergeAndZeroFillLegacy(
  bucketKeys: { key: string; start: Date; end: Date }[],
  claudeRows: LegacyRawBucketRow[],
  codexRows: LegacyRawBucketRow[],
  minimaxRows: LegacyRawBucketRow[] = []
): LegacyBucket[] {
  const bySource = {
    claude: new Map(claudeRows.map((r) => [r.bucket_key, fromLegacyRow(r)])),
    codex: new Map(codexRows.map((r) => [r.bucket_key, fromLegacyRow(r)])),
    minimax: new Map(minimaxRows.map((r) => [r.bucket_key, fromLegacyRow(r)])),
  };
  const states = { claude: "ok", codex: "ok", minimax: "ok" } as const;
  return mergeAndZeroFill(bucketKeys, bySource, states).map(flattenBucket);
}

export function computeTotalsLegacy(
  buckets: (Partial<LegacyBucket> & { bucketStart: string; bucketEnd: string })[]
): LegacyTotals {
  // 旧测试直接构造 LegacyBucket 喂进来,而且普遍只写关心的字段 → 每项 ?? 0。
  const n = (v: number | undefined) => v ?? 0;
  const restored: WorkTokensTrendBucket[] = buckets.map((b) => ({
    bucketStart: b.bucketStart,
    bucketEnd: b.bucketEnd,
    sources: {
      claude: {
        ...emptyUsage("ok"),
        freshInput:
          n(b.claudeInputTokens) -
          n(b.claudeCacheReadInputTokens) -
          n(b.claudeCacheCreationInputTokens),
        cacheReadInput: n(b.claudeCacheReadInputTokens),
        cacheCreationInput: n(b.claudeCacheCreationInputTokens),
        output: n(b.claudeOutputTokens),
        costUsd: n(b.claudeCostUsd),
        sessionCount: n(b.claudeSessionCount),
        coveredSessionCount: n(b.claudeCoveredSessionCount),
        unknownSessionCount: n(b.claudeUnknownSessionCount),
        errorSessionCount: n(b.claudeErrorSessionCount),
      },
      codex: {
        ...emptyUsage("ok"),
        freshInput: n(b.codexInputTokens) - n(b.codexCachedInputTokens),
        cacheReadInput: n(b.codexCachedInputTokens),
        output: n(b.codexOutputTokens),
        reasoningOutput: n(b.codexReasoningOutputTokens),
        costUsd: n(b.codexCostUsd),
        sessionCount: n(b.codexSessionCount),
        coveredSessionCount: n(b.codexCoveredSessionCount),
        unknownSessionCount: n(b.codexUnknownSessionCount),
        errorSessionCount: n(b.codexErrorSessionCount),
      },
      minimax: {
        ...emptyUsage("ok"),
        freshInput:
          n(b.minimaxInputTokens) -
          n(b.minimaxCacheReadInputTokens) -
          n(b.minimaxCacheCreationInputTokens),
        cacheReadInput: n(b.minimaxCacheReadInputTokens),
        cacheCreationInput: n(b.minimaxCacheCreationInputTokens),
        output: n(b.minimaxOutputTokens),
      },
    },
  }));
  return flattenTotals(computeTotals(restored));
}

export function computePreviousWindowTotalLegacy(
  db: Database.Database,
  from: Date,
  to: Date
): LegacyPreviousWindow {
  const p = computePreviousWindow(db, from, to);
  return {
    total: p.totalTokens,
    claudeCacheReadInputTokens: p.bySource.claude.cacheReadInput,
    codexCachedInputTokens: p.bySource.codex.cacheReadInput,
    minimaxCacheTokens:
      p.bySource.minimax.cacheReadInput + p.bySource.minimax.cacheCreationInput,
  };
}
