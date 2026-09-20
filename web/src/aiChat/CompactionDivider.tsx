import { useEffect, useState } from "react";
import { z } from "zod";
import { formatTokenCount, formatUsd } from "../util/formatDisplay";
import { revertCompaction } from "./compactionApi";
import { OriginalMessagesSheet } from "./OriginalMessagesSheet";
import { useAiChatUsage } from "./usageContext";

/**
 * 压缩分隔线的 activity 渲染器。
 *
 * **`content` 必须是 zod schema。** CopilotKit 在选中渲染器之后会跑
 * `renderer.content.safeParse(message.content)`,**失败就 `return null`**、只留一句
 * `console.warn` —— 界面什么都不显示、也没有任何提示。类型上它写的是
 * `StandardSchemaV1`,运行期却直接调 `.safeParse`,所以光实现 standard-schema 接口不够。
 *
 * schema 只列要用的字段:zod 的 object 默认剥掉多余键,解析照样成功。
 */
const compactionContent = z.object({
  kind: z.literal("compaction"),
  id: z.string(),
  trigger: z.enum(["manual", "auto"]),
  excludedMessageIds: z.array(z.string()),
  summary: z.object({
    decisions: z.array(z.string()),
    constraints: z.array(z.string()),
    state: z.array(z.string()),
    nextSteps: z.array(z.string()),
  }),
  // 下面两项只用来显示「释放 · 花费」。**不能写成必填**:schema 一旦对不上,整条分隔线
  // 就静默消失(见上)。`freedTokens` 是后加的字段,老事件没有。
  summaryCallIds: z.array(z.string()).default([]),
  freedTokens: z.number().optional(),
  createdAt: z.string(),
});

type CompactionContent = z.infer<typeof compactionContent>;

// 间距、边框、列表符号类带 `!`:CopilotKit 对聊天区的元素级重置会把它们清零(详见 ChatContextBar)。
function Section({ title, items }: { title: string; items: string[] }) {
  if (items.length === 0) return null;
  return (
    <div className="!mt-1.5">
      <div className="text-[11px] font-medium text-neutral-500">{title}</div>
      <ul className="!mt-0.5 !list-disc !pl-4 text-[11px] leading-4 text-neutral-600">
        {items.map((x, i) => (
          <li key={i}>{x}</li>
        ))}
      </ul>
    </div>
  );
}

function CompactionDividerView({ content }: { content: CompactionContent }) {
  const { sessionId, notifyCompactionChanged, justCompactedId, usage } = useAiChatUsage();
  // 默认收起 —— 分隔线是上下文标记,不是内容。**只在刚压缩完的那一次展开**(规格《7》),
  // 让用户当场看到摘要写了什么、省了多少、花了多少。
  const justNow = content.id === justCompactedId;
  const [open, setOpen] = useState(justNow);
  // 分隔线可能比用量先到(重挂后快照与用量各取各的),所以「刚压缩」晚到时也要展开一次。
  useEffect(() => {
    if (justNow) setOpen(true);
  }, [justNow]);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const n = content.excludedMessageIds.length;
  // 摘要请求的花费从账本取,不在事件里存 —— 账目可能晚结算(租约补写),事件是只追加的。
  const ids = new Set(content.summaryCallIds);
  const summaryCalls = usage
    ? Object.values(usage.byRun).flatMap((r) => r.calls.filter((c) => ids.has(c.callId)))
    : [];
  const cost = summaryCalls.reduce((sum, c) => sum + (c.costUsd ?? 0), 0);
  // 有一笔不是 priced,合计就只是下限 —— 与用量行同一个 `≥` 口径。
  const costAtLeast = summaryCalls.some((c) => c.costState !== "priced");

  async function revert() {
    setBusy(true);
    setErr(null);
    try {
      await revertCompaction(sessionId, content.id);
      notifyCompactionChanged();
    } catch (e: unknown) {
      // 规格:撤销闸拒绝时显示原因(例如「撤销后上下文会超出模型窗口」)。
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="!my-3 !border-y !border-neutral-200 !px-1 !py-2 text-[11px] leading-4 text-neutral-500">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="tabular-nums hover:text-neutral-700"
        >
          {open ? "▾" : "▸"} 此处已压缩 · {n} 条消息不再发给模型 ·{" "}
          {content.trigger === "auto" ? "自动" : "手动"}
        </button>
        <button
          type="button"
          disabled={!sessionId}
          onClick={() => setSheetOpen(true)}
          className="underline hover:text-neutral-700 disabled:opacity-40"
        >
          查看原文
        </button>
        {/* 快照里只放行栈顶那条分隔线,所以这里撤销的一定是栈顶(后端也会再校验一次)。 */}
        <button
          type="button"
          disabled={busy || !sessionId}
          onClick={() => void revert()}
          className="underline hover:text-neutral-700 disabled:opacity-40"
        >
          {busy ? "撤销中…" : "撤销"}
        </button>
      </div>
      {err ? (
        <p className="!mt-1 text-amber-800" role="alert">
          {err}
        </p>
      ) : null}
      {open ? (
        <div className="!pb-1 !pl-3">
          {content.freedTokens !== undefined || summaryCalls.length > 0 ? (
            <p className="!mt-1 tabular-nums">
              {content.freedTokens !== undefined
                ? `释放 ≈${formatTokenCount(content.freedTokens)} token`
                : null}
              {content.freedTokens !== undefined && summaryCalls.length > 0 ? " · " : null}
              {summaryCalls.length > 0
                ? `花费 ${costAtLeast ? "≥" : ""}${formatUsd(cost)}`
                : null}
            </p>
          ) : null}
          <Section title="已确定的决定" items={content.summary.decisions} />
          <Section title="必须遵守的约束" items={content.summary.constraints} />
          <Section title="当前状态" items={content.summary.state} />
          <Section title="待办" items={content.summary.nextSteps} />
        </div>
      ) : null}
      {sheetOpen ? (
        <OriginalMessagesSheet
          open
          onOpenChange={setSheetOpen}
          sessionId={sessionId}
          foldedIds={content.excludedMessageIds}
        />
      ) : null}
    </div>
  );
}

/**
 * 注册给 `<CopilotKit renderActivityMessages={[...]}>`。
 * `activityType` 必须与后端写入的字面量一字不差,否则 `findRenderer` 选不中。
 */
export const compactionActivityRenderer = {
  activityType: "ai2nao.compaction",
  content: compactionContent,
  render: ({ content }: { content: CompactionContent }) => (
    <CompactionDividerView content={content} />
  ),
};
