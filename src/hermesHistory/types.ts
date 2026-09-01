/**
 * hermes 会话展示 DTO。设计:~/.gstack/projects/xunull-ai2nao/
 * quincy-main-design-20260901-hermes-history.md
 */

/** 会话的发起方。cron = 定时任务自己跑的,不是人在对话(真库 94/120 是它)。 */
export type HermesSessionOrigin = "cron" | "cli" | "feishu" | "other";

export type HermesSessionSummary = {
  id: string;
  /** 原始 source 列的值(未归一),给需要精确值的地方用。 */
  sourceRaw: string;
  origin: HermesSessionOrigin;
  /** 已兜底的标题 —— 绝不会是 null,也绝不含 <think> 原文。 */
  title: string;
  /** 标题是不是兜底来的(前端可以标灰)。 */
  titleFallback: boolean;
  model: string | null;
  startedAtIso: string | null;
  endedAtIso: string | null;
  endReason: string | null;
  messageCount: number;
  toolCallCount: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
};

export type HermesToolCall = {
  callId: string;
  name: string;
  /** 调用参数原文(JSON 字符串,可能很长)。 */
  arguments: string;
  /** 工具返回的结果正文。挂不上宿主时不会出现在这里。 */
  result: string | null;
};

/** 详情页的一条消息。tool 结果已折进它所属的 assistant 行。 */
export type HermesMessage = {
  id: number;
  role: "user" | "assistant";
  eventAtIso: string;
  /** 展示正文。assistant 行走三层回落,恒非空。 */
  text: string;
  /** 正文是哪一层来的 —— 前端据此决定要不要标注「这是推理」「这是工具调用」。 */
  textKind: "content" | "reasoning" | "tool-calls";
  /** 该 assistant 行调用的工具及其结果。user 行恒为空数组。 */
  toolCalls: HermesToolCall[];
};

export type HermesSessionDetail = {
  session: HermesSessionSummary;
  messages: HermesMessage[];
  /** 源库里 role='session_meta' 的条数 —— 不展示,只报数,免得看起来少了东西。 */
  metaSkipped: number;
};
