/**
 * 给 assistant 消息盖模型快照。
 *
 * 落库不需要 migration:`sessions.ts` 存的是 `JSON.stringify(msg)` 整条消息、
 * 取回时 `JSON.parse(row.raw_json)` 原样还原,所以多一个字段自然就持久化了,
 * `llm_chat_messages` 一列都不用加(SCHEMA_VERSION 不动 = 打包版桌面应用照常能开库)。
 */
import type { Message } from "@ag-ui/client";
import type { LlmChatModelSnapshot } from "./config.js";

/** 带快照的消息。AG-UI 的 Message 是开放形状,多带字段不影响它自己的解析。 */
export type MessageWithModel = Message & { ai2naoModel?: LlmChatModelSnapshot };

/**
 * 只盖 assistant —— user 是你写的,tool 是工具返回的,都不是模型产出。
 *
 * **已经盖过的不覆盖。** 同一场会话里可以混多家,重跑一轮时不能把上一家答的
 * 老消息重标成这一轮的模型,那正是「可变外键篡改历史」要躲的事。
 */
export function stampModelSnapshot(
  messages: readonly Message[],
  snapshot: LlmChatModelSnapshot
): Message[] {
  return messages.map((m) => {
    if (m.role !== "assistant") return m;
    const existing = (m as MessageWithModel).ai2naoModel;
    if (existing) return m;
    return { ...m, ai2naoModel: snapshot } as Message;
  });
}
