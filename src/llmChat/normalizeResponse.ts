/**
 * 厂商响应归一。**存在的理由是一次真 API 实测**(2026-09-02):
 *
 * ```
 * DeepSeek v4-flash  content = ""                      reasoning_content = 159 字符
 * MiniMax-M2         content = "<think>…</think>…"     reasoning_content = 0
 * ```
 *
 * `content` 是直接渲染进聊天气泡的。不剥离,切到 MiniMax 后用户看到的第一句话
 * 就是模型的思考过程。这不是推测:同一个根因仓里已有记录 ——
 * `hermesHistory/normalize.ts:46` 的 `isBadTitle()` 专门检查 `includes("<think")`,
 * 注释写着「5 场存了模型的 <think> 原文」,而 hermes 的 billing_provider 正是 minimax-cn。
 *
 * 归一到同一形状之后,「要不要展示推理」只需要改一处,而不是每加一家改一处。
 */

/** 完整的 `<think …>…</think>` 块。惰性匹配,允许开标签带属性。 */
const THINK_BLOCK = /<think\b[^>]*>([\s\S]*?)<\/think\s*>/g;
/** 只开未闭的开标签 —— 流式分片到达时 `</think>` 往往还没来。 */
const THINK_OPEN = /<think\b[^>]*>/;

export type ThinkSplit = { visible: string; thinking: string };

/**
 * 把 `<think>` 块从正文里剥出来。
 *
 * **对流式是安全的**:遇到只开未闭的标签,开标签之后的全部内容都算 thinking,
 * 绝不漏进 visible —— 否则用户会先看到半句思考,等 `</think>` 到了再消失。
 */
export function splitThinkBlocks(raw: string): ThinkSplit {
  const thinking: string[] = [];
  let rest = raw.replace(THINK_BLOCK, (_m, inner: string) => {
    const t = inner.trim();
    if (t) thinking.push(t);
    return "";
  });

  const open = rest.match(THINK_OPEN);
  if (open && open.index !== undefined) {
    const tail = rest.slice(open.index + open[0].length).trim();
    if (tail) thinking.push(tail);
    rest = rest.slice(0, open.index);
  }

  return { visible: rest.trim(), thinking: thinking.join("\n") };
}

export type NormalizedAssistantText = { text: string; reasoning: string };

/**
 * 把一条 assistant 响应归到 `{ text, reasoning }`。
 *
 * `reasoning_content`(DeepSeek 走这条)排在 `<think>`(MiniMax 走这条)之前 ——
 * 两者同时出现时不丢任何一边,顺序固定以便断言。
 */
export function normalizeAssistantText(input: {
  content: string | null | undefined;
  reasoningContent: string | null | undefined;
}): NormalizedAssistantText {
  const split = splitThinkBlocks(input.content ?? "");
  const fromField = (input.reasoningContent ?? "").trim();
  const reasoning = [fromField, split.thinking].filter(Boolean).join("\n");
  return { text: split.visible, reasoning };
}
