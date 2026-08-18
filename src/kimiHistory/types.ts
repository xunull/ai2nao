/**
 * kimi 会话解析的 DTO。两个根(CLI / 桌面沙箱)共用,因为格式相同。
 */

/** 一个 agent 的事件流文件(main 或某个子代理)。 */
export type KimiWireFile = {
  /** kimi 自己的稳定会话 id:CLI 是 `session_<uuid>`,桌面是 `conv-<id>`。不含路径。 */
  sessionId: string;
  /** `main` 或 `agent-N`。进 messageKey 前缀,不进 sessionId。 */
  agent: string;
  filePath: string;
  mtimeMs: number;
  /** 只用于诊断与统计,不进任何唯一键。 */
  rootKind: "cli" | "desktop";
};

/** 会话级元数据(来自同目录的 state.json)。 */
export type KimiSessionMeta = {
  workDir: string | null;
  title: string | null;
  createdAt: string | null;
  updatedAt: string | null;
};

/** 归一化后的一条消息。人和 AI 走同一个形状。 */
export type KimiMessage = {
  /**
   * 会话内稳定唯一。人:`message.id`(只有带 origin.kind="user" 的才有),
   * 没有就退回 `<agent>:t<time>:<sha1(text)[0..12]>`;AI:`content.part` 事件的 uuid。
   * 实测 119 条真人消息 → 119 个不同键,0 撞车。
   */
  messageKey: string;
  role: "user" | "assistant";
  eventAtMs: number;
  /** 原文(留底)。桌面侧带 `<meta/>` / `<attachment>` 控制标签。 */
  text: string;
  /** 剥掉控制标签后的可搜索正文。AI 侧与 text 相同(它没有标签)。 */
  cleanedText: string;
  /**
   * `message.origin.kind`。**null 是有意义的取值**:实测这批全是真人打的字,
   * 且只出现在 2026-08-11 之后的会话里,与带 origin 的混杂在同一会话。
   * 只认 `origin.kind === "user"` 会漏掉最近一周约一半的提问。成因未查清。
   */
  originKind: string | null;
  isHuman: boolean;
  /** assistant 行:它在回答的那条真人消息的 messageKey(位置法:同文件里最近的一条)。 */
  answeringUserKey: string | null;
  /** 原始事件(留底,供 raw 审计与以后改清洗口径时回填)。 */
  rawPayloadJson: string;
};
