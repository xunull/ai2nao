import { useState } from "react";
import { formatTokenCount, formatUsd } from "../util/formatDisplay";
import { compactSession, setCompactionAuto } from "./compactionApi";
import { useAiChatUsage } from "./usageContext";

/**
 * 输入区上方的上下文占用条(挂 `CopilotChatInput` 的 `disclaimer` 插槽)。
 *
 * **窗口未知时不显示百分比。** `contextWindow` 为 null 表示「认不出这个模型」,
 * 把它当 0 会显示「已用 100%」,当无穷会显示「0%」—— 两个都是编出来的。
 *
 * **「约 $X」由后端估**(`compactCostEstimateUsd`,与账本同一个计价函数)。前端另造一套
 * 计价会与账本各算各的。估不出(缺价格)就只写「立即压缩」,不编一个数。
 */
/**
 * **可点的元素都要单独加 `pointer-events-auto`。** CopilotKit 把 disclaimer 插槽包在
 * `cpk:pointer-events-none` 的容器里(它本意是一行不可交互的说明文字),这个属性一路
 * 继承下来 —— 2026-09-18 真实浏览器走查实测:按钮 `pointer-events: none`,点击穿透到
 * 下面的消息滚动区,「现在压缩」「恢复」「分项」全部点不动。单测里 CopilotKit 是 mock 的,
 * 照不出来。整条仍保持穿透,只给按钮开口 —— 否则这一条会挡住它身后消息区的点击与滚动。
 */
const CLICKABLE = "pointer-events-auto";

/*
 * **间距、边框类都带 `!`(important)。** 同一个容器的另一处坑:CopilotKit 样式表里有
 * `[data-copilotkit] * { margin:0; padding:0; border:0 solid }`,优先级与 `.px-4` 相同、
 * 又比本项目的样式后加载,于是聊天区里一切 margin / padding / border 类全被清零;
 * `[data-copilotkit] button` 还把按钮背景设成透明、圆角设成 0。2026-09-19 走查实测:
 * 占用条贴着卡片边框、按钮没有边框。只加在会被重置的那几类上,其余类照常写。
 */

export function ChatContextBar({ sessionId }: { sessionId: string }) {
  const { usage, refresh, notifyCompactionChanged } = useAiChatUsage();
  // 记下是哪个动作在跑:规格要「压缩中按钮原位显示进度」,开关动作不该让压缩按钮说「压缩中」。
  const [busy, setBusy] = useState<null | "compact" | "toggle">(null);
  const [err, setErr] = useState<string | null>(null);
  const [showParts, setShowParts] = useState(false);
  const ctx = usage?.context ?? null;
  if (!ctx) return null;

  const { contextWindow, estimatedInput, estimateOnly, autoCompaction, suggestedCompactUpTo } = ctx;
  const ratio = contextWindow ? estimatedInput / contextWindow : null;
  // 接近上限才变色。amber 是本页唯一的警示色,不引入新配色。
  const warn = ratio !== null && ratio >= 0.9;
  const prefix = estimateOnly ? "≈" : "";

  async function run(kind: "compact" | "toggle", action: () => Promise<unknown>, after: () => void) {
    setBusy(kind);
    setErr(null);
    try {
      await action();
      after();
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  const parts: [string, number][] = [
    ["系统提示", ctx.breakdown.system],
    ["压缩摘要", ctx.breakdown.summary],
    ["近期对话", ctx.breakdown.recent],
    ["工具结果", ctx.breakdown.toolResults],
    ["图片", ctx.breakdown.images],
  ];

  return (
    <div
      className={`relative flex items-center gap-3 !px-4 !py-1.5 text-[11px] leading-4 tabular-nums ${
        warn ? "text-amber-800" : "text-neutral-500"
      }`}
    >
      {/* 点数字看分项(规格:分项数字进点击弹出层)。 */}
      <button
        type="button"
        aria-expanded={showParts}
        onClick={() => setShowParts((v) => !v)}
        className={`${CLICKABLE} shrink-0 hover:text-neutral-700`}
      >
        上下文 {prefix}
        {formatTokenCount(estimatedInput)}
        {contextWindow ? ` / ${formatTokenCount(contextWindow)}` : " / 窗口未知"}
        {ratio !== null ? `（${Math.round(ratio * 100)}%）` : ""}
      </button>
      {ratio !== null ? (
        <span className="h-1 w-24 shrink-0 overflow-hidden rounded bg-neutral-200">
          <span
            className={`block h-full ${warn ? "bg-amber-500" : "bg-neutral-400"}`}
            style={{ width: `${Math.min(100, Math.round(ratio * 100))}%` }}
          />
        </span>
      ) : null}
      {/* 折叠点由后端给 —— 前端手里没有 message_index,给不出这个参数。 */}
      <button
        type="button"
        disabled={busy !== null || suggestedCompactUpTo == null}
        onClick={() =>
          suggestedCompactUpTo != null &&
          void run(
            "compact",
            () => compactSession(sessionId, suggestedCompactUpTo),
            notifyCompactionChanged
          )
        }
        className={`${CLICKABLE} shrink-0 !rounded !border !border-neutral-300 !bg-white !px-2 !py-0.5 font-medium text-neutral-700 hover:!bg-neutral-50 disabled:opacity-40`}
      >
        {/* 规格:平时「立即压缩(约 $X)」—— 压缩会调外部模型、会花钱;接近上限时「现在压缩」。 */}
        {busy === "compact"
          ? "压缩中…"
          : warn
            ? "现在压缩"
            : `立即压缩${ctx.compactCostEstimateUsd != null ? `（约 ${formatUsd(ctx.compactCostEstimateUsd)}）` : ""}`}
      </button>
      {autoCompaction ? (
        // 规格:接近上限时才给「本会话不自动压缩」—— 平时它不是用户需要做的决定。
        warn ? (
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => void run("toggle", () => setCompactionAuto(sessionId, false), refresh)}
            className={`${CLICKABLE} shrink-0 underline hover:text-neutral-700 disabled:opacity-40`}
          >
            本会话不自动压缩
          </button>
        ) : null
      ) : (
        <>
          <span className="shrink-0">自动压缩已关</span>
          <span aria-hidden="true">·</span>
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => void run("toggle", () => setCompactionAuto(sessionId, true), refresh)}
            className={`${CLICKABLE} shrink-0 underline hover:text-neutral-700 disabled:opacity-40`}
          >
            恢复
          </button>
        </>
      )}
      {err ? (
        <span className="min-w-0 truncate text-amber-800" role="alert">
          {err}
        </span>
      ) : null}
      {showParts ? (
        <div className={`${CLICKABLE} absolute bottom-full left-4 z-10 !mb-1 w-72 !rounded !border !border-neutral-200 !bg-white !p-2 text-neutral-600 shadow-sm`}>
          <div className="!mb-1 font-medium">
            构成（合计 {prefix}
            {formatTokenCount(ctx.breakdownTotal)}）
          </div>
          <table className="w-full">
            <tbody>
              {parts.map(([label, n]) => (
                <tr key={label}>
                  <td className="!py-0.5">{label}</td>
                  <td className="!py-0.5 text-right">{formatTokenCount(n)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {/* 分项是全量分解;对得上基准时头条数字来自真实账目,两者口径不同。 */}
          {!estimateOnly ? (
            <p className="!mt-1 text-neutral-500">
              上面的数字来自同前缀的真实账目,这里是全量估算的构成,两者不必相加比对。
            </p>
          ) : null}
          <p className="!mt-1 text-neutral-500">
            不含本轮的工具定义(这里拿不到这一轮会开哪些工具),真实一轮会略多。
          </p>
          {ctx.toolResultsOmitted ? (
            <p className="!mt-1 text-amber-800">下一轮会省略较早的工具结果正文。</p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
