/**
 * Token 趋势页面 `/dashboard/tokens-trend` 的 DTO。
 *
 * 跟 `/dashboard/tokens` (project 轴) 共享数据源（`claude_session_token_usage`
 * + `codex_session_token_usage`），但这里按**时间轴**切，给出 24-30 个堆叠
 * 桶 + 4 个标量。设计文档：
 *   ~/.gstack/projects/xunull-ai2nao/you-main-design-20260610-191913-tokens-trend.md
 *
 * 哲学（继承 daily-summary / workDashboard / work-recap）：
 * - 事实优先：数字直接从两张 token usage 表 SUM 出来
 * - 不估算成本：不引入 token → USD 表
 * - coverage 三态显式：full / unknown / error 三个 session count 字段全
 *   提供，前端不反推
 * - source-level diagnostics：一方失败不拖死另一方
 */

export const WINDOW_KEYS = ["1d", "3d", "1w", "2w", "1m", "3m", "6m"] as const;
export type WindowKey = (typeof WINDOW_KEYS)[number];

export type BucketGranularity = "hour" | "3hour" | "day" | "week";

/**
 * Window → bucket granularity mapping (唯一真相). 设计文档 P4。
 *   1d  → hour    (24 桶)
 *   3d  → 3hour   (24 桶)
 *   1w  → day     ( 7 桶)
 *   2w  → day     (14 桶)
 *   1m  → day     (28-31 桶)
 *   3m  → week    (~13 桶)
 *   6m  → week    (~26 桶)
 *   month → day   (28-31 桶)
 */
export function windowToGranularity(window: WindowKey): BucketGranularity {
  switch (window) {
    case "1d":
      return "hour";
    case "3d":
      return "3hour";
    case "1w":
    case "2w":
    case "1m":
      return "day";
    case "3m":
    case "6m":
      return "week";
  }
}

export function windowToDays(window: WindowKey): number {
  switch (window) {
    case "1d":
      return 1;
    case "3d":
      return 3;
    case "1w":
      return 7;
    case "2w":
      return 14;
    case "1m":
      return 30;
    case "3m":
      return 90;
    case "6m":
      return 180;
  }
}

export function isWindowKey(raw: unknown): raw is WindowKey {
  return (
    typeof raw === "string" &&
    (WINDOW_KEYS as readonly string[]).includes(raw)
  );
}

/** YYYY-MM (e.g. "2026-06"). */
export type MonthKey = string;

export function isMonthKey(raw: unknown): raw is MonthKey {
  return typeof raw === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(raw);
}

/** Per-bucket DTO. Each bucket is half-open `[bucketStart, bucketEnd)`. */
export type WorkTokensTrendBucket = {
  bucketStart: string; // ISO, inclusive lower bound
  bucketEnd: string; // ISO, exclusive upper bound
  claudeTokens: number;
  codexTokens: number;
  /**
   * Input / output split per source (token_status='full' only). For Claude,
   * `*InputTokens` is the FUSED value (input + cache_creation + cache_read) —
   * cache breakdown is a separate future change. Invariant per bucket:
   *   claudeInputTokens + claudeOutputTokens == claudeTokens
   *   codexInputTokens  + codexOutputTokens  == codexTokens
   */
  claudeInputTokens: number;
  claudeOutputTokens: number;
  codexInputTokens: number;
  codexOutputTokens: number;
  /**
   * Claude-only prompt-cache split (subset of claudeInputTokens). Cache 命中
   * (read) is what gets replayed; cache 写入 (creation) is first-time cache
   * fill. 真实新增 = claudeInputTokens - read - creation. Codex has no cache
   * concept so there are no codex equivalents.
   */
  claudeCacheReadInputTokens: number;
  claudeCacheCreationInputTokens: number;
  /** Codex-only reasoning (thinking) output (subset of codexOutputTokens).
   *  正常输出 = codexOutputTokens - this. Claude has no reasoning concept. */
  codexReasoningOutputTokens: number;
  claudeSessionCount: number;
  codexSessionCount: number;
  /** token_status='full' — covered. */
  claudeCoveredSessionCount: number;
  codexCoveredSessionCount: number;
  /** token_status='unknown' — F2 explicit, no reconstruction. */
  claudeUnknownSessionCount: number;
  codexUnknownSessionCount: number;
  /** token_status='error' — 3-state honesty. */
  claudeErrorSessionCount: number;
  codexErrorSessionCount: number;
};

export type WorkTokensTrendCoverage = "full" | "partial" | "unknown";

export type WorkTokensTrendTotals = {
  totalTokens: number;
  claudeTokens: number;
  codexTokens: number;
  /**
   * Input / output split (token_status='full' only). Powers the 2×3 breakdown
   * matrix. Invariant: claudeInput + claudeOutput + codexInput + codexOutput
   * === totalTokens (exact — total_tokens is stored as input+output at parse
   * time, same 'full' predicate). Claude input is cache-inflated (fused with
   * cache_creation + cache_read); cache breakdown is a separate future change.
   */
  claudeInputTokens: number;
  claudeOutputTokens: number;
  codexInputTokens: number;
  codexOutputTokens: number;
  /**
   * Claude-only prompt-cache split (subset of claudeInputTokens). Powers the
   * "Claude 输入构成" breakdown:
   *   命中 cache (read)  = claudeCacheReadInputTokens
   *   写入 cache (write) = claudeCacheCreationInputTokens
   *   真实新增 (fresh)   = claudeInputTokens - read - creation
   */
  claudeCacheReadInputTokens: number;
  claudeCacheCreationInputTokens: number;
  /**
   * Codex-only reasoning (thinking) output tokens (subset of codexOutputTokens).
   * Powers the "Codex 输出构成" breakdown: 推理 vs 正常输出
   * (正常输出 = codexOutputTokens - codexReasoningOutputTokens).
   */
  codexReasoningOutputTokens: number;
  claudeShare: number; // 0..1
  codexShare: number; // 0..1
  coverage: WorkTokensTrendCoverage;
  coveredSessionCount: number; // token_status='full'
  unknownSessionCount: number; // token_status='unknown' (F2)
  errorSessionCount: number; // token_status='error'
  totalSessionCount: number; // sum invariant: covered + unknown + error
};

export type WorkTokensTrendDiagnostic = {
  severity: "info" | "warning" | "error";
  kind: string;
  message: string;
};

/** Earliest/latest month present in the union of both token tables. */
export type MonthRange = {
  earliest: MonthKey;
  latest: MonthKey;
};

/**
 * Discriminated union — replaces optional-fields shape so client narrowing
 * is trivial and there are no null-branches in window mode.
 */
export type WorkTokensTrendResponse =
  | {
      ok: true;
      generatedAt: string;
      mode: "window";
      windowKey: WindowKey;
      range: { from: string; to: string };
      bucketGranularity: BucketGranularity;
      buckets: WorkTokensTrendBucket[];
      totals: WorkTokensTrendTotals;
      /**
       * Strictly preceding equal-length window:
       *   `[range.from - (range.to - range.from), range.from)`
       * Always a number; 0 when no prior sessions; never null in window mode.
       */
      previousWindowTotal: number;
      /** (current - prev) / prev; null only when prev === 0. */
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
      buckets: WorkTokensTrendBucket[];
      totals: WorkTokensTrendTotals;
      monthRange: MonthRange;
      diagnostics: WorkTokensTrendDiagnostic[];
    };

/** Maximum month-picker depth (24 months back). */
export const MONTH_PICKER_MAX_DEPTH = 24;
