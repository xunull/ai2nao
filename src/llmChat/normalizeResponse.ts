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

const OPEN_TOKEN = "<think";
const CLOSE_TOKEN = "</think";
const CLOSE_TAG = /<\/think\s*>/;

/**
 * 尾部有多少字符可能是 `token` 的前半截。分片可能把 `<think>` 切成
 * `"<thi"` + `"nk>"` —— 先把这几个字符扣住,等下一片到了再判。
 * 同一个问题 DsmlToolCallBuffer 也有,解法一致。
 */
function heldSuffixLength(s: string, token: string): number {
  const max = Math.min(token.length - 1, s.length);
  for (let len = max; len > 0; len -= 1) {
    if (token.startsWith(s.slice(-len))) return len;
  }
  return 0;
}

/**
 * 流式剥离 `<think>` 块。
 *
 * **必须是状态机,不能「累积全文后整体重算再取增量」** —— 后者在 trim 和
 * 「已吐出的内容需要回退」这两处会咬人:文本一旦发给前端就收不回来了。
 *
 * 未闭合就结束(模型被中断/超时)时**不补吐**思考内容:宁可少显示,
 * 也不能把思考过程当成答案。
 */
export class ThinkStreamFilter {
  private inside = false;
  private buf = "";
  /**
   * 开头以及每个 think 块刚闭合后,把紧跟的空白吞掉。
   *
   * 这不是为了好看,是为了**与非流式口径一致**:`normalizeAssistantText`
   * 会 trim,若流式不吞,实时气泡就会比落库后的文本多两行空白 ——
   * 同一条消息刷新前后长得不一样。
   */
  private suppressLeadingWs = true;

  private emit(text: string): string {
    if (!this.suppressLeadingWs) return text;
    const trimmed = text.replace(/^\s+/, "");
    if (trimmed) this.suppressLeadingWs = false;
    return trimmed;
  }

  push(delta: string): string {
    this.buf += delta;
    let out = "";
    for (;;) {
      if (this.inside) {
        const close = CLOSE_TAG.exec(this.buf);
        if (!close) {
          // think 块内的内容一律丢弃,只留可能是闭标签前半截的尾巴。
          const keep = heldSuffixLength(this.buf, CLOSE_TOKEN);
          this.buf = this.buf.slice(this.buf.length - keep);
          return out;
        }
        this.buf = this.buf.slice(close.index + close[0].length);
        this.inside = false;
        this.suppressLeadingWs = true;
        continue;
      }
      const open = /<think\b[^>]*>/.exec(this.buf);
      if (!open) {
        const keep = heldSuffixLength(this.buf, OPEN_TOKEN);
        out += this.emit(this.buf.slice(0, this.buf.length - keep));
        this.buf = this.buf.slice(this.buf.length - keep);
        return out;
      }
      out += this.emit(this.buf.slice(0, open.index));
      this.buf = this.buf.slice(open.index + open[0].length);
      this.inside = true;
    }
  }

  /** 流结束。扣住的尾巴若不在 think 块里就补吐出来(它其实是普通文本)。 */
  finish(): string {
    if (this.inside) {
      this.buf = "";
      return "";
    }
    const rest = this.emit(this.buf);
    this.buf = "";
    return rest;
  }
}
