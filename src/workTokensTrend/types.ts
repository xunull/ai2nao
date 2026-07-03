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

// 窗口/月原语已抽到中立模块 src/timeWindow/(2026-07-03);import 供本文件 DTO 使用 + re-export。
import {
  WINDOW_KEYS,
  windowToGranularity,
  windowToDays,
  isWindowKey,
  isMonthKey,
  MONTH_PICKER_MAX_DEPTH,
  type WindowKey,
  type BucketGranularity,
  type MonthKey,
} from "../timeWindow/types.js";
export {
  WINDOW_KEYS,
  windowToGranularity,
  windowToDays,
  isWindowKey,
  isMonthKey,
  MONTH_PICKER_MAX_DEPTH,
};
export type { WindowKey, BucketGranularity, MonthKey };

/** Per-bucket DTO. Each bucket is half-open `[bucketStart, bucketEnd)`. */
export type WorkTokensTrendBucket = {
  bucketStart: string; // ISO, inclusive lower bound
  bucketEnd: string; // ISO, exclusive upper bound
  claudeTokens: number;
  codexTokens: number;
  /**
   * MiniMax total (input+output) for this bucket, from the remote per-hour
   * billing-history event table. No session table → no minimax session counts.
   * `minimaxInputTokens` is FUSED (fresh + cache-read + cache-create), mirroring
   * claude. T+1~T+2 lag: the trailing 1-2 buckets are typically still settling.
   */
  minimaxTokens: number;
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
  /** MiniMax input (FUSED) / output split. minimaxInput + minimaxOutput == minimaxTokens. */
  minimaxInputTokens: number;
  minimaxOutputTokens: number;
  /**
   * Claude-only prompt-cache split (subset of claudeInputTokens). Cache 命中
   * (read) is what gets replayed; cache 写入 (creation) is first-time cache
   * fill. 真实新增 = claudeInputTokens - read - creation. Codex has no cache
   * concept so there are no codex equivalents.
   */
  claudeCacheReadInputTokens: number;
  claudeCacheCreationInputTokens: number;
  /**
   * MiniMax prompt-cache split (subset of minimaxInputTokens), classified by
   * billing `method`: cache-read (命中) + cache-create (写入). "exclude cache"
   * subtracts BOTH. 真实新增 = minimaxInputTokens - read - creation.
   */
  minimaxCacheReadInputTokens: number;
  minimaxCacheCreationInputTokens: number;
  /** Codex-only reasoning (thinking) output (subset of codexOutputTokens).
   *  正常输出 = codexOutputTokens - this. Claude has no reasoning concept. */
  codexReasoningOutputTokens: number;
  /** Codex-only cached input (cache-hit replay, subset of codexInputTokens).
   *  Codex's mirror of claudeCacheReadInputTokens. */
  codexCachedInputTokens: number;
  /** Estimated USD cost of this bucket's PRICED tokens (unknown models excluded).
   *  Independent of the cache toggle — priced from raw components per model. */
  claudeCostUsd: number;
  codexCostUsd: number;
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
  /** MiniMax total (input+output) from the remote billing-history event table. */
  minimaxTokens: number;
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
  /** MiniMax input (FUSED) / output totals. */
  minimaxInputTokens: number;
  minimaxOutputTokens: number;
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
  /**
   * Codex-only cached input (cache-hit replay, subset of codexInputTokens).
   * Powers the "Codex 输入构成" breakdown (命中 cache vs 真实新增) and the
   * tokens-trend cache toggle. Codex's mirror of claudeCacheReadInputTokens.
   */
  codexCachedInputTokens: number;
  /**
   * MiniMax prompt-cache split (subset of minimaxInputTokens), classified by
   * method: cache-read + cache-create. Powers the "exclude cache" toggle (which
   * subtracts BOTH). 真实新增 = minimaxInputTokens - read - creation.
   */
  minimaxCacheReadInputTokens: number;
  minimaxCacheCreationInputTokens: number;
  /**
   * Estimated USD cost — "equivalent API cost", NOT a subscription bill. Priced
   * per session by its model from a static snapshot (PRICE_SNAPSHOT_DATE).
   * Tokens whose model has no price entry are EXCLUDED from cost and counted in
   * unpricedTokenCount (honesty: never guessed, never $0). Independent of the
   * cache toggle. claudeCostUsd + codexCostUsd === totalCostUsd.
   */
  totalCostUsd: number;
  claudeCostUsd: number;
  codexCostUsd: number;
  /** Tokens (input+output) whose model had no price entry — surfaced, not priced. */
  unpricedTokenCount: number;
  /** Static price snapshot date (shown on the UI for honesty). */
  priceSnapshotDate: string;
  claudeShare: number; // 0..1
  codexShare: number; // 0..1
  minimaxShare: number; // 0..1
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
      /**
       * Claude `cache_read_input_tokens` summed over the SAME previous window.
       * Lets the frontend "exclude cache hits" toggle recompute the prior-window
       * total consistently (prev − this) instead of leaving 环比 cache-inclusive
       * while the rest of the page switches. Always a number (0 when none).
       */
      previousWindowClaudeCacheReadInputTokens: number;
      /**
       * Codex `cached_input_tokens` summed over the SAME previous window — the
       * Codex mirror of the field above, so the cache toggle recomputes 环比
       * consistently for Codex too. Always a number (0 when none).
       */
      previousWindowCodexCachedInputTokens: number;
      /**
       * MiniMax cache (cache-read + cache-create) summed over the SAME previous
       * window, so the "exclude cache" toggle recomputes 环比 consistently for
       * MiniMax too (which subtracts both cache kinds). Always a number.
       */
      previousWindowMinimaxCacheTokens: number;
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
