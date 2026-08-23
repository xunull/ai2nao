/**
 * agent 用户消息统一库 DTO。设计:docs/agent-user-messages-design.md。
 * 表结构见 migrations.ts applyV54(原建于 applyV42)。
 */

/**
 * V54 起 source 列不再有 CHECK 约束 —— 合法性就靠这个联合类型。加新源改这一行,
 * 零迁移(改 CHECK 要重建 232 MB 的表,见 migrations.ts applyV54)。
 */
export type AgentUserMessageSource = "claude" | "codex" | "opencode" | "kimi";

/** 消息角色。V53 起这张表也装 assistant 行(AI 正文入库)。 */
export type AgentMessageRole = "user" | "assistant";

/** 写入一行的输入(ingest / 回填共用)。 */
export type UpsertUserMessageInput = {
  source: AgentUserMessageSource;
  sourceSessionId: string;
  sourceMessageKey: string;
  project: string | null;
  eventAtUtc: string;
  rawText: string;
  rawPayloadJson: string;
  cleanedText: string;
  isHuman: boolean;
  cleanerVersion: number;
  parserVersion: number;
  sourcePath: string | null;
  /**
   * 缺省 'user' —— 让 V53 之前就写好的调用方(codex/opencode ingest、回填)不用改
   * 一行代码就继续正确工作,它们本来就只写 user 消息。
   */
  role?: AgentMessageRole;
  /**
   * assistant 行:它在回答的那条 user 消息的 source_message_key。user 行恒为空。
   * 搜索命中一句 AI 的话时靠它带出一行提问上下文(AI 单条中位只有 87 字,孤立看
   * 不知道在回答什么)。
   */
  answeringUserKey?: string | null;
};

/** 搜索命中(返回给前端;不含 raw,raw 走 /:id/raw 审计端点)。 */
export type AgentUserMessageSearchHit = {
  id: number;
  source: AgentUserMessageSource;
  sourceSessionId: string;
  eventAtUtc: string;
  snippet: string;
  /** V53:命中的是谁说的。老调用方不看这个字段也不会坏。 */
  role?: AgentMessageRole;
  /**
   * 命中 assistant 行时,它在回答的那条提问的正文(已清洗)。
   * AI 单条中位只有 87 字,孤立看不知道在回答什么 —— 这一行是上下文。
   * user 行、或锚点行已被删时为 null。
   */
  answering?: string | null;
};

/** 原文审计。 */
export type AgentUserMessageRaw = {
  id: number;
  source: AgentUserMessageSource;
  sourceSessionId: string;
  eventAtUtc: string;
  rawText: string;
  rawPayloadJson: string;
  cleanedText: string;
  isHuman: boolean;
  cleanerVersion: number;
};

export type AgentUserMessageSyncState = {
  watermarkMs: number;
  lastRunAt: string | null;
  lastStatus: string | null;
  lastError: string | null;
  /**
   * 该源 ingest 口径的版本号（V56）。与代码里的常量比对,不符则本轮强制全量重扫 ——
   * 与五个 token refresh 的 `rule_version` 同一套家法
   * (`claudeTokenUsage/refresh.ts:216-220`)。
   *
   * 可选:目前只有 opencode 启用了版本方案,另外三个 ingest 写 0,
   * 含义是「未启用」而不是「版本 0 已生效」。
   */
  ingestVersion?: number;
};
