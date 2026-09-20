/** 一个模型条目在界面上的样子。**绝不含密钥**,只有来源分类。 */
export type LlmChatModelView = {
  id: string;
  label: string;
  provider: string;
  model: string;
  available: boolean;
  credentialSource: "config" | "env" | "none-needed" | "none";
  /**
   * 能不能贴图。**四态**,因为「不能」有两种、处置方式相反:
   * - `yes`        贴图入口可用
   * - `unknown`    目录没拉到/旧缓存/手填的模型 → **可用 + 提示**,不置灰
   * - `catalog-no` 目录说不收图 → 置灰,留「仍要发送」后门(目录会过期)
   * - `adapter-no` 我们的适配器结构性发不出去 → 置灰,**没有后门**
   *                (如 @ai-sdk/deepseek 2.0.35:发出去图会被丢,而费用照扣)
   *
   * 后端可能是旧版本(打包桌面版),没有这个字段 —— 缺失按 `unknown` 处理。
   */
  vision?: "yes" | "unknown" | "catalog-no" | "adapter-no";
};

export type LlmChatStatus = {
  configured: boolean;
  /** 单数字段的含义是**默认那个**。 */
  provider: string | null;
  model: string | null;
  /** 实际生效的默认模型 id(默认项悬空时是真正会被用的那个)。 */
  defaultModelId: string | null;
  /** picker 与设置页列表的数据源。 */
  models: LlmChatModelView[];
  /**
   * 服务商清单**由后端给**,前端只维护 id → 中文标签。
   * 以前前端自己硬编码一份,后端加一家而这里忘了加,那家在下拉里压根不存在。
   */
  availableProviders: { id: string; defaultBaseURL: string }[];
  /**
   * **厂商列的数据源。与 `models` 是两件事。**
   * `models` 按模型逐条展开,一个刚添加、刚粘上 key、还没选模型的实例在它里面是
   * 0 行,于是在左栏里根本不存在 —— 而那正是配置一家新厂商必然经过的那一秒。
   * 这里含 0 模型的和已关闭的实例。
   */
  providers: {
    id: string;
    label: string;
    provider: string;
    baseURL: string;
    enabled: boolean;
    credentialSource: string;
    modelCount: number;
  }[];
  /** 默认模型所在的实例被关掉了 —— 后台四个功能会停,页面必须显式说出来。 */
  defaultDisabled: boolean;
  baseHost: string | null;
  configPath: string;
  /** "db" once the config lives in config.db; "file" while still on the legacy JSON. */
  source: "db" | "file" | null;
};

export type RagStatus = {
  ok: true;
  dbPath: string;
  configPath: string;
  defaultDbPath: string;
  configPresent: boolean;
  corpusRoots: string[];
  embeddingEnabled: boolean;
  chunkCount: number;
  manifest: {
    total: number;
    indexed: number;
    skipped: number;
    partial: number;
    error: number;
    deleted: number;
    ftsError: number;
    vectorError: number;
  };
  vectorStore: {
    provider: "none" | "lancedb";
    path: string | null;
    ok: boolean;
    indexedCount: number;
    syncStatus: string;
    embeddingModel: string | null;
    embeddingDim: number | null;
    error: string | null;
  };
};

export type WebSearchStatus = {
  provider: "brave";
  configured: boolean;
  ok: boolean;
  configPath: string;
  capabilities: {
    freshness: boolean;
    safeSearch: boolean;
    resultLanguage: boolean;
    pageFetch: boolean;
  };
  cacheTtlMs: number;
  error: string | null;
};

export type CodeRunnerStatus = {
  pyodide: { available: true };
  docker: {
    available: boolean;
    dockerVersion: string | null;
    image: string;
    imagePresent: boolean;
    error: string | null;
  };
};

export type RagEvidenceHit = {
  id?: number;
  chunkId: number;
  sourceRoot: string;
  filePath: string;
  content: string;
  contentPreview: string;
  truncated: boolean;
  scores: {
    ftsRank?: number;
    vectorScore?: number;
    rrfScore: number;
  };
  ranks: {
    fts?: number;
    vector?: number;
    hybrid: number;
  };
  matchedBy: ("fts" | "vector")[];
};

export type AiChatSessionSummary = {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  last_message_at: string | null;
  message_count: number;
  /**
   * 会话累计花费。**后端已经在发**(`listLlmChatSessions` 走 `withParsedUsage`),
   * 此前前端只是没有声明这个字段。旧会话没有这个键 → undefined,按「还没算过」
   * 处理,不是「花了 0 元」。
   */
  usage?: AiChatUsageTotals;
};

export type AiChatStoredMessage = {
  id: string;
  session_id: string;
  message_id: string;
  message_index: number;
  role: "developer" | "system" | "user" | "assistant" | "tool" | "activity" | "reasoning";
  raw_json: string;
  plain_text: string;
  preview: string;
  status: string | null;
  created_at: string;
  updated_at: string;
};

export type AiChatSessionDetail = AiChatSessionSummary & {
  messages: AiChatStoredMessage[];
};

/** 与后端 `UsageTotals` 同形。`atLeast` 为真时界面加 `≥`。 */
export type AiChatUsageTotals = {
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
  costUsd: number;
  atLeast: boolean;
};

export type AiChatCostState = "pending" | "unknown" | "unpriced" | "partial" | "priced";

/** 一笔模型请求。明细表一行一条。 */
export type AiChatCallView = {
  callId: string;
  purpose: string;
  stepIndex: number;
  attempt: number;
  status: string;
  model: { modelId: string; provider: string; model: string; label: string } | null;
  usage: {
    input: number | null;
    noCache: number | null;
    cacheRead: number | null;
    cacheWrite: number | null;
    output: number | null;
    reasoning: number | null;
  } | null;
  costUsd: number | null;
  costState: AiChatCostState;
  startedAt: string;
  endedAt: string | null;
};

/**
 * 下一轮的上下文占用。**`contextWindow` 为 null 表示「窗口未知」,不是 0** ——
 * 当成 0 的话占用条会显示「已用 100%」。
 */
export type AiChatContextView = {
  model: { provider: string; model: string; label: string } | null;
  contextWindow: number | null;
  outputReserve: number;
  estimatedInput: number;
  /** true = 全量估算,数字前加 `≈`;false = 基于真实账目。 */
  estimateOnly: boolean;
  breakdown: {
    system: number;
    summary: number;
    recent: number;
    toolResults: number;
    images: number;
  };
  /**
   * 分项之和。**与 `estimatedInput` 是两个口径**:`estimateOnly` 为真时两者相等,
   * 为假时按定义不等(头条数字来自基准账目,分项是全量分解)。所以分项要呈现为
   * 「构成」,不要在界面上把它们加起来跟头条数字比。
   */
  breakdownTotal: number;
  toolResultsOmitted: boolean;
  autoCompaction: boolean;
  /**
   * 建议的折叠上界(`message_index`);不足以压缩时为 null,按钮置灰。
   * **由后端给** —— 前端手里只有 AG-UI 消息,没有 `message_index`。
   */
  suggestedCompactUpTo: number | null;
  /** 按建议折叠点压缩的预估花费;没有折叠点或缺价格时为 null,按钮就不写「约 $X」。 */
  compactCostEstimateUsd: number | null;
};

export type AiChatCompactionSummary = {
  decisions: string[];
  constraints: string[];
  state: string[];
  nextSteps: string[];
};

export type AiChatCompaction = {
  v: 1;
  kind: "compaction";
  id: string;
  baseId: string | null;
  trigger: "manual" | "auto";
  excludedMessageIds: string[];
  summary: AiChatCompactionSummary;
  summaryCallIds: string[];
  /** 压缩让下一轮少发的 token(估算)。字段是后加的,老事件没有 —— 那就不显示。 */
  freedTokens?: number;
  createdAt: string;
};

export type AiChatCompactionEvent =
  | AiChatCompaction
  | { v: 1; kind: "revert"; targetId: string; createdAt: string };

export type AiChatSessionUsage = {
  byRun: Record<
    string,
    { displayMessageId: string | null; calls: AiChatCallView[]; totals: AiChatUsageTotals }
  >;
  byAssistantMessage: Record<string, { runId: string; callIds: string[] }>;
  byReasoningMessage: Record<
    string,
    { durationMs: number | null; reasoningTokens: number | null; callId: string | null }
  >;
  session: AiChatUsageTotals & { costStates: Record<AiChatCostState, number> };
  /** 未注入或算不出时为 null —— 界面按「窗口未知」处理。 */
  context: AiChatContextView | null;
  /** 当前生效的栈(栈顶即生效压缩)与完整事件列表。 */
  compactions: { stack: AiChatCompaction[]; events: AiChatCompactionEvent[] };
};

/** 分页原文的一行。**不含 `raw_json`** —— 协议原文不进这条面向界面的接口。 */
export type AiChatOriginalMessage = {
  messageId: string;
  messageIndex: number;
  role: AiChatStoredMessage["role"];
  text: string;
  preview: string;
  createdAt: string;
};

export type AiChatOriginalPage = {
  messages: AiChatOriginalMessage[];
  /** 下一页游标;为 null 表示没有更多,前端据此停下。 */
  nextBefore: number | null;
};
