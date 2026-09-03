/** 一个模型条目在界面上的样子。**绝不含密钥**,只有来源分类。 */
export type LlmChatModelView = {
  id: string;
  label: string;
  provider: string;
  model: string;
  available: boolean;
  credentialSource: "config" | "env" | "none-needed" | "none";
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
