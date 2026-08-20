import type Database from "better-sqlite3";
import { generateTrend, type GenerateTrendArgs } from "./service.js";
import {
  computePreviousWindowTotal,
  computeTotals,
  mergeAndZeroFill,
  queryBucketsBySource,
} from "./queries.js";
import type {
  BucketGranularity,
  MonthKey,
  MonthRange,
  WindowKey,
  WorkTokensTrendCoverage,
  WorkTokensTrendDiagnostic,
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

/**
 * 把归一后的响应展开回旧形状。
 *
 * T2 现状:新旧形状相同,是恒等函数。
 * T3 之后:这里读 `bucket.sources.claude.*` 等,展开成 `claudeTokens` 等平铺字段。
 */
export function flattenResponse(res: LegacyResponse): LegacyResponse {
  return res;
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
  return flattenResponse(generateTrend(db, args) as LegacyResponse);
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

export function queryBucketsBySourceLegacy(
  ...args: Parameters<typeof queryBucketsBySource>
): LegacyRawBucketRow[] {
  return queryBucketsBySource(...args) as LegacyRawBucketRow[];
}

export function mergeAndZeroFillLegacy(
  bucketKeys: { key: string; start: Date; end: Date }[],
  claudeRows: LegacyRawBucketRow[],
  codexRows: LegacyRawBucketRow[],
  minimaxRows: LegacyRawBucketRow[] = []
): LegacyBucket[] {
  return mergeAndZeroFill(
    bucketKeys,
    claudeRows as never,
    codexRows as never,
    minimaxRows as never
  ) as LegacyBucket[];
}

export function computeTotalsLegacy(buckets: LegacyBucket[]): LegacyTotals {
  return computeTotals(buckets as never) as LegacyTotals;
}

export function computePreviousWindowTotalLegacy(
  db: Database.Database,
  from: Date,
  to: Date
): LegacyPreviousWindow {
  return computePreviousWindowTotal(db, from, to) as LegacyPreviousWindow;
}
