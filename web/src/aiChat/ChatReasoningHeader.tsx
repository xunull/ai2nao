import type { MouseEventHandler } from "react";
import { formatTokenCount } from "../util/formatDisplay";
import { useAiChatUsage } from "./usageContext";

/**
 * 思考块标题。
 *
 * **必须由外层把 `messageId` 绑进来。** 库把 header 插槽渲染成
 * `renderSlot(header, Header, { isOpen, label, hasContent, isStreaming, onClick })` ——
 * 五个 prop 里**没有 message**,所以单靠覆写 header 拿不到 id,也就查不到
 * `byReasoningMessage[id]`。覆写 `reasoningMessage` 本体(它收 message)再绑下来。
 *
 * 流式时用库自己的计时(它按秒自增);落库后改用账目里的真实时长与 token ——
 * `reasoningTokens` 取不到就是「token 未知」,**不按请求分摊**(规格明写)。
 */
export function ChatReasoningHeader({
  messageId,
  isOpen,
  hasContent,
  isStreaming,
  onClick,
}: {
  messageId: string;
  isOpen?: boolean;
  hasContent?: boolean;
  isStreaming?: boolean;
  /** 直接转给 <button> —— 必须能接事件,写成 () => void 在参数位置不兼容。 */
  onClick?: MouseEventHandler<HTMLButtonElement>;
}) {
  const { usage } = useAiChatUsage();
  const meta = usage?.byReasoningMessage?.[messageId];

  let label: string;
  if (isStreaming) {
    label = "思考中…";
  } else if (meta?.durationMs != null) {
    const sec = meta.durationMs / 1000;
    const tokens = meta.reasoningTokens != null ? formatTokenCount(meta.reasoningTokens) : "token 未知";
    label = `思考了 ${sec < 10 ? sec.toFixed(1) : Math.round(sec)} 秒 · ${tokens}`;
  } else {
    label = "思考过程";
  }

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!hasContent}
      className="text-[11px] leading-4 text-neutral-500 hover:text-neutral-700 disabled:cursor-default"
    >
      {hasContent ? (isOpen ? "▾ " : "▸ ") : ""}
      {label}
    </button>
  );
}
