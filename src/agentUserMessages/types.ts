/**
 * agent 用户消息统一库 DTO。设计:docs/agent-user-messages-design.md。
 * 表结构见 migrations.ts applyV42。
 */

export type AgentUserMessageSource = "claude" | "codex" | "opencode";

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
