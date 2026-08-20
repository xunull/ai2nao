/**
 * Token 趋势页面 `/dashboard/tokens-trend` 的 DTO。
 *
 * 设计文档:~/.gstack/projects/xunull-ai2nao/quincy-main-design-20260820-092053.md
 * (归一成 source 维度;前身 you-main-design-20260610-191913-tokens-trend.md)
 *
 * 哲学(继承 daily-summary / workDashboard / work-recap):
 * - 事实优先:数字直接从各源的 token 表 SUM 出来
 * - 不估算成本:token → USD 只用真实价格表,没有价格就说「不知道」,不写 0
 * - coverage 三态显式:full / unknown / error 全提供,前端不反推
 * - source-level diagnostics:一方失败不拖死另一方
 *
 * ## 为什么是 `Record<TokenSourceKey, SourceUsage>` 而不是平铺字段
 *
 * 上一版是逐源平铺(`claudeTokens` / `codexInputTokens` / `minimaxCacheReadInputTokens`…)。
 * 那个形状**没有地方表达「这个源没有这个维度」**,于是每加一个源都要给它不具备的
 * 维度填一个假值。后果不是难看而是错:前端曾把 `minimaxCostUsd` 硬编码成 0
 * (MiniMax 没有价格表条目)然后照样堆进成本柱 —— 页面在说「MiniMax 不花钱」,
 * 真相是「不知道」。归一 + 显式 `SourceCapabilities` 就是为了让这类谎说不出口。
 *
 * ## 为什么只存原子分量
 *
 * `SourceUsage` 只存**不可再分**的四个量(+ 可选的 reasoning),
 * `inputTokens` / `totalTokens` / 不含缓存值**全部派生**。
 * 这样不会出现多套可互相矛盾的事实,也不需要 capability 去声明某个数值字段可不可信。
 *
 * 具体挡掉的坑:上一版存的是**融合后**的 `input_tokens`(含 cache),于是
 * 「真实新增」要靠 `input - cacheRead - cacheCreation` 减出来。接一个存
 * 「不含缓存的输入」的新源(kimi 的 `inputOther`)时照字面映射就会算出大负数。
 * 存原子分量之后,kimi 的 `inputOther` 直接就是 `freshInput`,零转换、无从写反。
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

/**
 * 趋势页认的源。**加一个源 = 这里加一项 + 注册一个 adapter + 前端 SOURCE_META 加一项。**
 * 顺序即前端柱子的堆叠顺序。
 */
export const TOKEN_SOURCES = ["claude", "codex", "minimax"] as const;
export type TokenSourceKey = (typeof TOKEN_SOURCES)[number];

/** 展示用名字。前端的 SOURCE_META 另有配色,名字以这里为准。 */
export const SOURCE_LABELS: Record<TokenSourceKey, string> = {
  claude: "Claude",
  codex: "Codex",
  minimax: "MiniMax",
};

/**
 * 「这个源有没有这个维度」—— 把**不适用**从**零**里分出来。
 *
 * 前端据此决定「画一段 0」还是「根本不画」。没有它的话,
 * `codex.cacheCreationInput === 0` 读起来像「codex 这段时间没写 cache」,
 * 而真相是 codex 根本没有 cache 写入这个概念。
 */
export type SourceCapabilities = {
  cacheRead: boolean;
  cacheCreation: boolean;
  reasoningOutput: boolean;
  /** 有没有 session 级三态表。MiniMax 是逐小时账单事件,没有 session 概念。 */
  sessionCounts: boolean;
};

/**
 * 这个源在本次响应里的状态。
 *
 * - `ok`      查到了(哪怕是 0 行 —— 这个窗口就是没用)
 * - `failed`  查询抛了(表损坏/schema 漂移)。**不是 0,前端要画斜纹并标注**
 * - `absent`  这台机器上没有这个源(没装、从没同步过)
 *
 * `failed` 与 `absent` 都不能靠「查询返回空数组」推断 —— 空数组有四种含义:
 * 没装 / 装了但没会话 / 同步还没跑 / 扫描失败留下空表。
 * 所以 `absent` 由 adapter 的 `probePresence()` 判定,不看查询结果。
 */
export type SourceState = "ok" | "failed" | "absent";

/**
 * 一个源在一个桶(或整窗)里的用量。**只存原子分量,不存任何可派生的量。**
 *
 * 派生请用同文件下方的 `inputTokens()` / `totalTokens()` / `tokensExcludingCache()`,
 * 不要在调用方自己写加减 —— 那正是上一版三个源三种「不含缓存」含义的来源。
 */
export type SourceUsage = {
  state: SourceState;
  /** 真实新增的输入:没命中也没写 cache 的那部分。kimi 的 `inputOther` 直接是它。 */
  freshInput: number;
  /** 命中 cache 被重放的输入。`capabilities.cacheRead === false` 时恒 0 且无意义。 */
  cacheReadInput: number;
  /** 首次写入 cache 的输入。`capabilities.cacheCreation === false` 时恒 0 且无意义。 */
  cacheCreationInput: number;
  output: number;
  /** 推理(thinking)输出,是 `output` 的**子集**。仅 codex 有。 */
  reasoningOutput: number;
  /** 已定价部分的 USD。未定价的 token 不在这里,在 `unpricedTokens`。 */
  costUsd: number;
  /** 被成功定价的 token 数(input + output)。 */
  pricedTokens: number;
  /** 没有价格条目、因此没算进 `costUsd` 的 token 数。 */
  unpricedTokens: number;
  /** `capabilities.sessionCounts === false` 时四个计数恒 0 且无意义。 */
  sessionCount: number;
  coveredSessionCount: number;
  unknownSessionCount: number;
  errorSessionCount: number;
};

/** 输入合计 = 真实新增 + 命中 cache + 写入 cache。 */
export function inputTokens(u: SourceUsage): number {
  return u.freshInput + u.cacheReadInput + u.cacheCreationInput;
}

/** 总量 = 输入合计 + 输出。 */
export function totalTokens(u: SourceUsage): number {
  return inputTokens(u) + u.output;
}

/**
 * 「不含缓存」的量 = 真实新增 + 输出。
 *
 * 两种 cache 都不算作「真实新增」,四个源统一。
 * 注意它是**加法**不是减法 —— 上一版用 `total - cacheX` 减出来,于是
 * 「减哪些」在三个源上有三种答案,而且映射写反时会得到负数。
 */
export function tokensExcludingCache(u: SourceUsage): number {
  return u.freshInput + u.output;
}

/** 空用量。`state` 由调用方给,因为「没数据」与「查询失败」要分开。 */
export function emptyUsage(state: SourceState): SourceUsage {
  return {
    state,
    freshInput: 0,
    cacheReadInput: 0,
    cacheCreationInput: 0,
    output: 0,
    reasoningOutput: 0,
    costUsd: 0,
    pricedTokens: 0,
    unpricedTokens: 0,
    sessionCount: 0,
    coveredSessionCount: 0,
    unknownSessionCount: 0,
    errorSessionCount: 0,
  };
}

/** 一个桶。半开区间 `[bucketStart, bucketEnd)`。 */
export type WorkTokensTrendBucket = {
  bucketStart: string; // ISO, inclusive lower bound
  bucketEnd: string; // ISO, exclusive upper bound
  sources: Record<TokenSourceKey, SourceUsage>;
};

export type WorkTokensTrendCoverage = "full" | "partial" | "unknown";

/**
 * 一个源的成本可信度。
 *
 * - `full`     该源本窗口的 token 全部被定价了
 * - `partial`  有一部分没价格 —— **成本数字是下界,不是真值**
 * - `none`     一条都没定价(订阅套餐、或价格表没这个模型)
 *
 * 布尔说不清 `partial`:claude 与 codex 现在就都是 partial
 * (claude 有一批 model 为 null 的 session、codex 有 `codex-auto-review`)。
 * 布尔会是 true,而图表展示的是成本下界并被叫做「成本」。
 */
export type SourceCostState = "full" | "partial" | "none";

export type WorkTokensTrendTotals = {
  totalTokens: number;
  /** 逐源合计 + 占比。`share` 是该源 total 占 `totalTokens` 的比例(0..1)。 */
  sources: Record<TokenSourceKey, SourceUsage & { share: number }>;
  /** 逐源的成本可信度。 */
  costState: Record<TokenSourceKey, SourceCostState>;
  /** 只累加真被定价的部分。 */
  totalCostUsd: number;
  /** 没有价格条目的 token 数(全源合计)。露出来,不当成 $0。 */
  unpricedTokenCount: number;
  /** 价格快照日期(UI 上标出来,诚实起见)。 */
  priceSnapshotDate: string;
  coverage: WorkTokensTrendCoverage;
  /**
   * 三态 session 计数,只累加 `capabilities.sessionCounts === true` 的源。
   * ⚠️ 单位是 **session**。将来接入以 agent 为单位统计的源时不能直接汇总进来。
   */
  coveredSessionCount: number;
  unknownSessionCount: number;
  errorSessionCount: number;
  totalSessionCount: number;
};

export type WorkTokensTrendDiagnostic = {
  severity: "info" | "warning" | "error";
  kind: string;
  message: string;
};

/** 全部源里最早/最晚的自然月。 */
export type MonthRange = {
  earliest: MonthKey;
  latest: MonthKey;
};

/**
 * 上一个等长窗口。逐源给原子分量,让前端在任何「含/不含缓存」口径下
 * 都能自己算出可比的环比基数,而不是后端替它锁死一种。
 */
export type PreviousWindow = {
  totalTokens: number;
  bySource: Record<
    TokenSourceKey,
    { totalTokens: number; freshInput: number; cacheReadInput: number; cacheCreationInput: number }
  >;
};

/**
 * 判别联合 —— 让前端 narrow 一步到位,window 模式下没有 null 分支。
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
      /** 各源具备哪些维度。前端据此决定画不画,而不是看值是不是 0。 */
      capabilities: Record<TokenSourceKey, SourceCapabilities>;
      previousWindow: PreviousWindow;
      /** (current - prev) / prev;prev === 0 时为 null。 */
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
      capabilities: Record<TokenSourceKey, SourceCapabilities>;
      monthRange: MonthRange;
      diagnostics: WorkTokensTrendDiagnostic[];
    };
