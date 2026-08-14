import { MessagePlainText } from "./MessagePlainText";
import { RenderedMarkdown } from "./RenderedMarkdown";

type Props = {
  /** 消息角色。非 "assistant" 的一律走不解析路径。 */
  role: string;
  text: string;
};

/**
 * 按角色分派消息正文的渲染方式（D3）。
 *
 * **白名单在 assistant 上，不是黑名单在 user 上。** 两个理由：
 *
 * 1. 安全姿态一致 —— P2 把「不可信输入」的边界画在 user 内容上，未知角色应当保守处理。
 * 2. 第三种 role 确实存在 —— `CherryStudioHistory.tsx` 的 `roleLabel` 有
 *    `return role` 兜底，说明类型契约里不止 user/assistant 两种。
 *
 * 名字用 `MessageText` 而非 `MessageBodyText`：`ClaudeCodeHistorySession.tsx` 里
 * 已经有一个组件叫 `MessageBody`，同文件近名会读错。
 *
 * thinking 不走这里 —— 它天然只属于 assistant，调用点直接用 `RenderedMarkdown`。
 */
export function MessageText({ role, text }: Props) {
  return role === "assistant" ? (
    <RenderedMarkdown text={text} />
  ) : (
    <MessagePlainText text={text} />
  );
}
