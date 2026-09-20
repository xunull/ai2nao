import { useState } from "react";
import { formatTokenCount, formatUsd } from "../util/formatDisplay";
import { useAiChatUsage } from "./usageContext";

/**
 * 一轮的用量合计,显示在该轮**最后一条** assistant 消息底部。
 *
 * **只在 `displayMessageId` 那条上渲染。** 一轮可能有多步 + 补答,每条都挂一行的话
 * 同一笔钱会被看成好几笔。哪条是「最后一条」由后端推导(`byRun[runId].displayMessageId`),
 * 前端不自己判断 —— 前端手里没有 runId 与步骤序。
 *
 * `atLeast` 为真时加 `≥`:存在 pending / unknown / unpriced / partial,合计是下限而非实数。
 */
// 间距类带 `!`:CopilotKit 对聊天区的元素级重置会把它们清零(详见 ChatContextBar)。

/** 账目的 `purpose` 是内部标识,界面上换成人话。 */
const PURPOSE_LABEL: Record<string, string> = { answer: "回答", finalize: "补答", compact: "压缩" };

export function ChatUsageRow({ messageId }: { messageId: string }) {
  const { usage } = useAiChatUsage();
  const [open, setOpen] = useState(false);
  const link = usage?.byAssistantMessage?.[messageId];
  const run = link ? usage?.byRun?.[link.runId] : undefined;
  if (!run || run.displayMessageId !== messageId) return null;

  const t = run.totals;
  const ge = t.atLeast ? "≥" : "";
  // 规格《7》:已取消但已计费是**唯一上色**的用量状态(amber)。只认真算出了钱的那种 ——
  // 取消时厂商没报用量就不知道计没计费,写「已计费」是在编。
  const abortedBilled = run.calls.some((c) => c.status === "aborted" && (c.costUsd ?? 0) > 0);
  return (
    <div className="!mt-0.5 text-[11px] leading-4 text-neutral-500 tabular-nums">
      <span>
        输入 {formatTokenCount(t.input)} · 输出 {formatTokenCount(t.output)} ·{" "}
        {abortedBilled ? (
          <span className="text-amber-800">
            已取消 · 已计费 {ge}
            {formatUsd(t.costUsd)}
          </span>
        ) : (
          <>
            {ge}
            {formatUsd(t.costUsd)}
          </>
        )}
      </span>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="!ml-2 underline hover:text-neutral-700"
      >
        {open ? "收起" : "明细"}
      </button>
      {open ? (
        <table className="!mt-1 w-full max-w-[520px] border-collapse text-[11px]">
          <thead>
            <tr className="text-neutral-400">
              <th className="!py-0.5 text-left font-normal">步骤</th>
              <th className="!py-0.5 text-left font-normal">尝试</th>
              <th className="!py-0.5 text-right font-normal">输入</th>
              <th className="!py-0.5 text-right font-normal">缓存</th>
              <th className="!py-0.5 text-right font-normal">输出</th>
              <th className="!py-0.5 text-right font-normal">费用</th>
            </tr>
          </thead>
          <tbody>
            {run.calls.map((c) => (
              <tr key={c.callId}>
                {/* 步骤与尝试在账本里从 0 数,界面从 1 数。补答每轮至多一次,不带序号。 */}
                <td className="!py-0.5">
                  {PURPOSE_LABEL[c.purpose] ?? c.purpose}
                  {c.purpose === "finalize" ? "" : ` ${c.stepIndex + 1}`}
                </td>
                <td className="!py-0.5">{c.attempt + 1}</td>
                <td className="!py-0.5 text-right">{formatTokenCount(c.usage?.input)}</td>
                <td className="!py-0.5 text-right">{formatTokenCount(c.usage?.cacheRead)}</td>
                <td className="!py-0.5 text-right">{formatTokenCount(c.usage?.output)}</td>
                {/* 未定价 / 未知与「$0.00」是两回事,靠 costState 分开,不用金额本身判断。 */}
                <td className="!py-0.5 text-right">
                  {c.costState === "unpriced"
                    ? "未定价"
                    : c.costState === "unknown" || c.costState === "pending"
                      ? "—"
                      : formatUsd(c.costUsd)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </div>
  );
}
