import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { apiGet } from "../api";

type LeadSeverity = "info" | "notable" | "warning";

type Lead = {
  id: string;
  severity: LeadSeverity;
  title: string;
  detail?: string;
  href: string;
  asOf: string;
};

type LeadsResp = {
  ok: true;
  leads: Lead[];
  overflow: number;
  errors: { probeId: string; message: string }[];
  fallbackCards?: string[];
};

/**
 * 首页「今日线索」。
 *
 * 这一屏的存在理由:全站 50 多页,真正被打开的集中在成本那几页,其余的不是没用,是
 * **想不起来去看**。所以这里不摆指标,摆的是「今天为什么该看某一页」+ 一个能点进去的链。
 *
 * 版面约束(项目铁律):禁止垂直过度滚动。后端已经把非 warning 的线索截到 7 条并给出
 * overflow 计数;前端不再自己截,只负责把 overflow 表达成一行提示。
 */
export function Home() {
  const q = useQuery<LeadsResp>({
    queryKey: ["home-leads"],
    queryFn: () => apiGet<LeadsResp>("/api/home/leads"),
  });

  return (
    <main className="mx-auto max-w-[1040px] px-8 py-6">
      <header className="mb-5">
        <h1 className="text-xl font-semibold text-[var(--fg)]">
          今天{" "}
          <span className="text-sm font-normal text-[var(--fg-muted)]">
            · 这台机器上值得知道的事
          </span>
        </h1>
      </header>

      {q.isLoading && <p className="text-sm text-[var(--fg-muted)]">正在看今天发生了什么...</p>}

      {q.isError && (
        <p className="text-sm text-red-600">
          读取失败:{q.error instanceof Error ? q.error.message : String(q.error)}
        </p>
      )}

      {q.data && (
        <>
          <LeadList leads={q.data.leads} overflow={q.data.overflow} />
          {q.data.leads.length === 0 && <EmptyState cards={q.data.fallbackCards ?? []} />}
          <ProbeErrors errors={q.data.errors} />
        </>
      )}
    </main>
  );
}

const SEVERITY_STYLE: Record<LeadSeverity, string> = {
  warning: "border-l-[3px] border-l-red-500",
  notable: "border-l-[3px] border-l-amber-500",
  info: "border-l-[3px] border-l-transparent",
};

function LeadList({ leads, overflow }: { leads: Lead[]; overflow: number }) {
  const [expanded, setExpanded] = useState(false);
  if (leads.length === 0) return null;
  return (
    <ul className="flex flex-col gap-1.5">
      {leads.map((lead) => (
        <li key={lead.id}>
          <Link
            to={lead.href}
            className={`flex items-baseline gap-3 rounded-md bg-[var(--surface)] px-3 py-2.5 outline-none transition-colors hover:bg-[var(--surface-hover)] focus-visible:ring-2 focus-visible:ring-[var(--sidebar-focus)] ${SEVERITY_STYLE[lead.severity]}`}
          >
            {/*
              标题不加 flex-1:加了它会吃掉整行宽度,把 detail 顶到 1040px 容器的最右边,
              两段文字隔着几百像素,读起来像不相干的两件事。让标题按内容宽度排,detail
              紧跟其后;标题过长时靠 min-w-0 + truncate 收缩。
            */}
            <span className="min-w-0 truncate text-sm text-[var(--fg)]">{lead.title}</span>
            {lead.detail && (
              <span className="shrink-0 text-xs text-[var(--fg-muted)]">{lead.detail}</span>
            )}
          </Link>
        </li>
      ))}
      {overflow > 0 && (
        <li>
          {expanded ? (
            <p className="px-3 py-2 text-xs text-[var(--fg-muted)]">
              还有 {overflow} 条没那么要紧的,按重要性排在后面 —— 明天再看也不迟。
            </p>
          ) : (
            <button
              type="button"
              onClick={() => setExpanded(true)}
              className="px-3 py-2 text-xs text-[var(--fg-muted)] underline-offset-2 hover:underline"
            >
              还有 {overflow} 条
            </button>
          )}
        </li>
      )}
    </ul>
  );
}

/**
 * 没有任何线索时不显示「今天没有线索」这种空白 —— 摆几张现成的卡。
 * 卡片是服务端渲染好的 SVG(`/api/cards/:file`),这里只负责嵌。
 */
function EmptyState({ cards }: { cards: string[] }) {
  if (cards.length === 0) {
    return <p className="text-sm text-[var(--fg-muted)]">今天这台机器上没什么反常的。</p>;
  }
  return (
    <div>
      <p className="mb-3 text-sm text-[var(--fg-muted)]">
        今天这台机器上没什么反常的。顺手看看最近的样子:
      </p>
      <div className="flex flex-wrap items-start gap-3">
        {cards.map((name) => (
          <img
            key={name}
            src={`/api/cards/${name}.svg`}
            alt=""
            className="max-w-full rounded-md border border-[var(--border)]"
          />
        ))}
      </div>
    </div>
  );
}

/**
 * 探针自己坏掉是**运维信息**,不是业务线索 —— 所以单独一条紧凑提示,不混进上面的列表,
 * 也不占那 7 条的版面。多个探针同时坏时只显示一行,不让它铺满首屏。
 */
function ProbeErrors({ errors }: { errors: { probeId: string; message: string }[] }) {
  if (errors.length === 0) return null;
  const ids = errors.map((e) => e.probeId).join("、");
  return (
    <p className="mt-4 text-xs text-[var(--fg-muted)]">
      有 {errors.length} 个探针没跑起来({ids})。其余线索不受影响。
    </p>
  );
}
