/**
 * agent 用户消息统一库 DTO。设计:docs/agent-user-messages-design.md。
 * 表结构见 migrations.ts applyV42。
 */

export type AgentUserMessageSource = "claude" | "codex" | "opencode";

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
};
