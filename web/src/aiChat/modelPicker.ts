/**
 * picker / 状态药丸 / 气泡归属的取值规则。
 *
 * 抽成纯函数是因为整页挂载会拖进整个 CopilotKit —— 那样测出来的是它的渲染,
 * 不是这里的规则。规则本身有三条容易写错的分支,值得单独钉住。
 */
import type { LlmChatModelView, LlmChatStatus } from "./types";

export type ChatModelSelection = {
  models: LlmChatModelView[];
  /** 这一轮实际会用的 id。null = 后端也没有默认项(通常是一个模型都没配)。 */
  effectiveModelId: string | null;
  selected: LlmChatModelView | null;
  /** 给还没落库的气泡兜底用的标签。 */
  fallbackLabel: string | null;
};

/**
 * `modelId` 为 null 时用后端算出来的 `defaultModelId` ——
 * **不是**自己挑 models[0]。后端那个值已经处理过「默认项被删」的回落,
 * 前端再挑一次就会出现两处口径不一致。
 */
export function resolveChatModel(
  status: LlmChatStatus | null,
  modelId: string | null
): ChatModelSelection {
  const models = status?.models ?? [];
  const effectiveModelId = modelId ?? status?.defaultModelId ?? null;
  const selected = models.find((m) => m.id === effectiveModelId) ?? null;
  return { models, effectiveModelId, selected, fallbackLabel: selected?.label ?? null };
}

/** 消息上可能带的不可变模型快照。后端在落库时盖,流式事件里没有。 */
export type MessageModelSnapshot = { modelId?: string; label?: string; model?: string };

/**
 * 一条 assistant 消息该显示谁答的。
 *
 * 优先用消息自带的快照 —— 条目改名、删除、id 被复用都不影响历史。
 * 快照缺失只发生在**这一轮刚生成、还没落库**的那条上(AG-UI 流式事件不带它),
 * 此时用 picker 的当前值兜底。已知边界:流式过程中改 picker,那条的标签会跟着变;
 * 刷新后以快照为准。
 */
export function assistantModelLabel(message: unknown, fallback: string | null): string | null {
  const snapshot =
    message && typeof message === "object"
      ? ((message as { ai2naoModel?: MessageModelSnapshot }).ai2naoModel ?? null)
      : null;
  const fromSnapshot = snapshot?.label?.trim() || snapshot?.model?.trim();
  return fromSnapshot || fallback || null;
}
