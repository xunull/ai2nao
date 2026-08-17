import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import {
  Bar,
  BarChart,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { apiGet } from "../api";

type Hit = {
  id: number;
  source: string;
  sourceSessionId: string;
  eventAtUtc: string;
  snippet: string;
  /** V53:命中的是谁说的。后端可选返回,老响应里没有。 */
  role?: "user" | "assistant";
  /** 命中 AI 的话时,它在回答的那条提问;锚点行已删则为 null。 */
  answering?: string | null;
};
type SearchResp = { ok: true; hits: Hit[] };
type RawResp = {
  ok: true;
  raw: {
    id: number;
    source: string;
    sourceSessionId: string;
    eventAtUtc: string;
    rawText: string;
    rawPayloadJson: string;
    cleanedText: string;
    isHuman: boolean;
    cleanerVersion: number;
  };
};

const SOURCES = [
  { value: "", label: "全部来源" },
  { value: "opencode", label: "OpenCode" },
  { value: "claude", label: "Claude" },
  { value: "codex", label: "Codex" },
] as const;

type RoleFilter = "user" | "assistant" | "all";

/**
 * 默认 "我说的" —— 与 AI 内容入库之前逐条一致。
 * AI 消息是人类消息的 5.76 倍、中位只有 87 字,默认混进来会淹没结果,
 * 所以「搜 AI 的话」做成显式动作而不是默认行为。
 */
const ROLE_FILTERS = [
  { value: "user", label: "我说的" },
  { value: "assistant", label: "AI 说的" },
  { value: "all", label: "全部" },
] as const;

const SOURCE_META: Record<string, { label: string; color: string }> = {
  claude: { label: "Claude", color: "#d97757" },
  codex: { label: "Codex", color: "#2563eb" },
  opencode: { label: "OpenCode", color: "#7c3aed" },
};

/** 日期分隔条(按本地日分组);行内只留时分秒,不重复日期。 */
function fmtDay(iso: string): string {
  return new Date(iso).toLocaleDateString("zh-CN", {
    year: "numeric",
    month: "long",
    day: "numeric",
    weekday: "short",
  });
}
function fmtTimeOnly(iso: string): string {
  return new Date(iso).toLocaleTimeString("zh-CN", { hour12: false });
}

/** 片段里 [..] 是命中高亮(trigram snippet / LIKE 手工窗口都用这对括号)。 */
function Snippet({ text }: { text: string }) {
  const parts = text.split(/(\[[^\]]*\])/g);
  return (
    <>
      {parts.map((p, i) =>
        p.startsWith("[") && p.endsWith("]") ? (
          <mark key={i} className="rounded bg-amber-100 px-0.5 text-amber-900">
            {p.slice(1, -1)}
          </mark>
        ) : (
          <span key={i}>{p}</span>
        )
      )}
    </>
  );
}

function RawPanel({ id }: { id: number }) {
  const q = useQuery<RawResp>({
    queryKey: ["aum-raw", id],
    queryFn: () => apiGet<RawResp>(`/api/agent-user-messages/${id}/raw`),
  });
  if (q.isLoading) return <div className="mt-2 text-xs text-[var(--fg-muted)]">加载原文…</div>;
  if (q.isError)
    return (
      <div className="mt-2 text-xs text-rose-600">
        原文读取失败：{(q.error as Error).message}
      </div>
    );
  const raw = q.data!.raw;
  return (
    <div className="mt-2 space-y-2 border-l-2 border-[var(--border)] pl-3 text-xs">
      <div className="text-[var(--fg-muted)]">
        清洗版本 v{raw.cleanerVersion} · is_human={String(raw.isHuman)} · session {raw.sourceSessionId}
      </div>
      <pre className="max-h-72 overflow-y-auto whitespace-pre-wrap break-words rounded bg-[var(--surface-2)] p-2 text-[var(--fg)]">
        {raw.rawText || "（空）"}
      </pre>
    </div>
  );
}

/**
 * 消息流:紧凑行(去卡片壳)。左侧品牌色圆点标来源,正文为主行,时间小号,
 * 「查看原文」悬停/聚焦才出;行间细分隔线,悬停微高亮。按天分组。
 */
type StreamRow = { id: number; source: string; eventAtUtc: string; content: ReactNode };

function MessageRow({
  row,
  open,
  onToggle,
}: {
  row: StreamRow;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="group flex gap-2.5 border-b border-[var(--border)] py-2.5 last:border-b-0 hover:bg-[var(--surface-2)]">
      <span
        className="mt-[7px] h-2 w-2 shrink-0 rounded-full"
        style={{ backgroundColor: SOURCE_META[row.source]?.color ?? "var(--fg-muted)" }}
        title={SOURCE_META[row.source]?.label ?? row.source}
      />
      <div className="min-w-0 flex-1">
        <div className="whitespace-pre-wrap break-words text-sm text-[var(--fg)]">
          {row.content}
        </div>
        <div className="mt-1 flex items-center gap-3 text-[11px] text-[var(--fg-muted)]">
          <span className="tabular-nums">{fmtTimeOnly(row.eventAtUtc)}</span>
          <button
            type="button"
            onClick={onToggle}
            className="underline decoration-dotted underline-offset-2 opacity-0 transition group-hover:opacity-100 hover:text-[var(--fg)] focus-visible:opacity-100"
          >
            {open ? "收起原文" : "查看原文"}
          </button>
        </div>
        {open && <RawPanel id={row.id} />}
      </div>
    </div>
  );
}

function MessageStream({
  rows,
  openId,
  setOpenId,
}: {
  rows: StreamRow[];
  openId: number | null;
  setOpenId: (n: number | null) => void;
}) {
  const out: ReactNode[] = [];
  let lastDay = "";
  for (const r of rows) {
    const day = fmtDay(r.eventAtUtc);
    if (day !== lastDay) {
      out.push(
        <div
          key={`day-${day}`}
          className="mb-0.5 mt-5 text-xs font-medium text-[var(--fg-muted)] first:mt-0"
        >
          {day}
        </div>
      );
      lastDay = day;
    }
    out.push(
      <MessageRow
        key={r.id}
        row={r}
        open={openId === r.id}
        onToggle={() => setOpenId(openId === r.id ? null : r.id)}
      />
    );
  }
  return <div>{out}</div>;
}

type AllTimeTotal = { source: string; count: number; charSum: number };
type TimelineBucket = {
  bucketStart: string;
  bucketEnd: string;
  claude: number;
  codex: number;
  opencode: number;
  total: number;
};
type Timeline = {
  window: string;
  granularity: "hour" | "3hour" | "day" | "week";
  range: { from: string; to: string };
  buckets: TimelineBucket[];
  windowTotal: number;
  previousWindowTotal: number;
  deltaRatio: number | null;
  lastBucketPartial: boolean;
};
type AnalyticsResp = { ok: true; allTimeTotals: AllTimeTotal[]; timeline: Timeline };

const WINDOWS = [
  { value: "today", label: "今天" },
  { value: "1d", label: "1天" },
  { value: "3d", label: "3天" },
  { value: "1w", label: "1周" },
  { value: "2w", label: "2周" },
  { value: "1m", label: "1月" },
  { value: "3m", label: "3月" },
  { value: "6m", label: "6月" },
] as const;

const pad2 = (n: number) => String(n).padStart(2, "0");
/** x 轴标签按粒度自适应:小时→HH:00,天/周→MM-DD。 */
function bucketLabel(iso: string, g: Timeline["granularity"]): string {
  const d = new Date(iso);
  if (g === "hour" || g === "3hour") return `${pad2(d.getHours())}:00`;
  return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** 输入统计:累计(all-time)+ 可调窗口趋势图(recharts,自适应粒度 + 环比)。windowKey 受控(父上提)。 */
function AnalyticsStrip({
  windowKey,
  setWindowKey,
}: {
  windowKey: string;
  setWindowKey: (w: string) => void;
}) {
  const q = useQuery<AnalyticsResp>({
    queryKey: ["aum-analytics", windowKey],
    queryFn: () =>
      apiGet<AnalyticsResp>(`/api/agent-user-messages/analytics?window=${windowKey}`),
  });
  if (!q.data) return null;
  const { allTimeTotals, timeline } = q.data;
  const grand = allTimeTotals.reduce((a, t) => a + t.count, 0);
  if (grand === 0) return null;

  const data = timeline.buckets.map((b) => ({
    label: bucketLabel(b.bucketStart, timeline.granularity),
    claude: b.claude,
    codex: b.codex,
    opencode: b.opencode,
  }));
  const delta = timeline.deltaRatio;

  return (
    <section className="mb-5 rounded-lg border border-[var(--border)] bg-[var(--surface)] p-3">
      {/* 累计(all-time)+ 窗口选择器 */}
      <div className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-[var(--fg-muted)]">
        <span className="font-medium text-[var(--fg)]">累计 {grand} 条</span>
        {allTimeTotals.map((t) => (
          <span key={t.source}>
            {SOURCE_META[t.source]?.label ?? t.source} {t.count}
          </span>
        ))}
        <span className="ml-auto flex items-center gap-0.5">
          {WINDOWS.map((w) => (
            <button
              key={w.value}
              type="button"
              onClick={() => setWindowKey(w.value)}
              className={`rounded px-2 py-0.5 ${
                windowKey === w.value
                  ? "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200"
                  : "text-[var(--fg-muted)] hover:bg-[var(--surface-2)]"
              }`}
            >
              {w.label}
            </button>
          ))}
        </span>
      </div>

      {/* 本窗口总数 + 环比 */}
      <div className="mb-1 flex items-center gap-2 text-xs text-[var(--fg-muted)]">
        <span>本窗口 {timeline.windowTotal} 条</span>
        {delta != null && (
          <span className={delta >= 0 ? "text-emerald-600" : "text-rose-600"}>
            {delta >= 0 ? "↑" : "↓"} {Math.abs(delta * 100).toFixed(0)}% 环比
          </span>
        )}
      </div>

      <div style={{ width: "100%", height: 180 }}>
        <ResponsiveContainer>
          <BarChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: -20 }}>
            <XAxis dataKey="label" tick={{ fontSize: 10 }} interval="preserveStartEnd" />
            <YAxis tick={{ fontSize: 10 }} allowDecimals={false} width={32} />
            <Tooltip
              contentStyle={{ fontSize: 12 }}
              formatter={(value, name) => [value, SOURCE_META[String(name)]?.label ?? String(name)]}
            />
            <Legend
              formatter={(name: string) => SOURCE_META[name]?.label ?? name}
              wrapperStyle={{ fontSize: 10 }}
            />
            <Bar dataKey="opencode" stackId="s" fill={SOURCE_META.opencode.color} />
            <Bar dataKey="claude" stackId="s" fill={SOURCE_META.claude.color} />
            <Bar dataKey="codex" stackId="s" fill={SOURCE_META.codex.color} />
          </BarChart>
        </ResponsiveContainer>
      </div>
      {timeline.lastBucketPartial && (
        <div className="text-[10px] text-[var(--fg-muted)]">最后一柱截至现在(未满桶)</div>
      )}
    </section>
  );
}

type ListItem = {
  id: number;
  source: string;
  sourceSessionId: string;
  eventAtUtc: string;
  text: string;
};
type ListCursor = { eventAt: string; id: number };
type ListResp = { ok: true; items: ListItem[]; nextBefore: ListCursor | null };

/**
 * 窗口浏览(全源、最新在前、keyset 加载更多)。搜索框为空时显示。
 * useInfiniteQuery + 复合游标(eventAt,id);窗口切换 → queryKey 变 → 自动重置分页。
 * 消息用 MessageStream(紧凑行、按天分组、plain-text)渲染;加载更多在流末尾,页面自然增长。
 */
function BrowseList({ windowKey }: { windowKey: string }) {
  const [openId, setOpenId] = useState<number | null>(null);
  const q = useInfiniteQuery<ListResp>({
    queryKey: ["aum-browse", windowKey],
    queryFn: ({ pageParam }) => {
      const p = new URLSearchParams({ window: windowKey });
      const cur = pageParam as ListCursor | null;
      if (cur) {
        p.set("before", cur.eventAt);
        p.set("beforeId", String(cur.id));
      }
      return apiGet<ListResp>(`/api/agent-user-messages/list?${p.toString()}`);
    },
    initialPageParam: null,
    getNextPageParam: (last) => last.nextBefore ?? undefined,
  });

  if (q.isLoading)
    return <div className="text-xs text-[var(--fg-muted)]">加载中…</div>;
  if (q.isError)
    return (
      <div className="text-sm text-rose-600">浏览失败：{(q.error as Error).message}</div>
    );
  const items = q.data?.pages.flatMap((pg) => pg.items) ?? [];
  if (items.length === 0)
    return (
      <div className="rounded-md border border-dashed border-[var(--border)] p-6 text-center text-sm text-[var(--fg-muted)]">
        这个时间窗口内还没有你发的消息。换个窗口，或确认历史已同步。
      </div>
    );

  const rows: StreamRow[] = items.map((it) => ({
    id: it.id,
    source: it.source,
    eventAtUtc: it.eventAtUtc,
    content: it.text,
  }));
  return (
    <div>
      <MessageStream rows={rows} openId={openId} setOpenId={setOpenId} />
      {q.hasNextPage && (
        <button
          type="button"
          onClick={() => q.fetchNextPage()}
          disabled={q.isFetchingNextPage}
          className="mt-3 w-full rounded-md border border-[var(--border)] py-2 text-sm text-[var(--fg-muted)] hover:bg-[var(--surface-2)] disabled:opacity-50"
        >
          {q.isFetchingNextPage ? "加载中…" : "加载更多"}
        </button>
      )}
    </div>
  );
}

export function AgentMessages() {
  const [input, setInput] = useState("");
  const [source, setSource] = useState("");
  // 默认 "user":与加 AI 内容之前逐条一致。搜 AI 的话是显式动作 —— AI 消息是人类的
  // 5.76 倍且中位只有 87 字,默认混进来会淹没结果。
  const [role, setRole] = useState<RoleFilter>("user");
  const [submitted, setSubmitted] = useState<{ q: string; source: string; role: RoleFilter }>({
    q: "",
    source: "",
    role: "user",
  });
  const [openId, setOpenId] = useState<number | null>(null);
  const [windowKey, setWindowKey] = useState<string>("1w"); // 上提:图 + 浏览列表共用

  const q = useQuery<SearchResp>({
    queryKey: ["aum-search", submitted.q, submitted.source, submitted.role],
    queryFn: () => {
      const p = new URLSearchParams({ q: submitted.q });
      if (submitted.source) p.set("source", submitted.source);
      // 只有非默认值才带上,免得给所有既有请求平白加一个参数。
      if (submitted.role !== "user") p.set("role", submitted.role);
      return apiGet<SearchResp>(`/api/agent-user-messages/search?${p.toString()}`);
    },
    enabled: submitted.q.trim().length > 0,
  });

  const hits = q.data?.hits ?? [];
  const searchRows: StreamRow[] = hits.map((h) => ({
    id: h.id,
    source: h.source,
    eventAtUtc: h.eventAtUtc,
    content: (
      <div>
        {h.role === "assistant" && (
          <div className="mb-1 flex items-baseline gap-1.5 text-[11px] text-[var(--fg-muted)]">
            <span className="shrink-0 rounded bg-violet-50 px-1 py-px font-medium text-violet-700 ring-1 ring-violet-200">
              AI
            </span>
            {h.answering ? (
              <span className="truncate" title={h.answering}>
                在回答：{h.answering}
              </span>
            ) : (
              // 锚点行已随源文件一起被删(孤儿会话)。不是 bug,说清楚。
              <span className="italic">这条提问已随源文件删除</span>
            )}
          </div>
        )}
        <Snippet text={h.snippet} />
      </div>
    ),
  }));

  return (
    <main className="mx-auto max-w-[1040px] px-8 py-6">
      <header className="mb-5">
        <h1 className="text-xl font-semibold text-[var(--fg)]">对话搜索</h1>
        <p className="mt-1 text-xs text-[var(--fg-muted)]">
          默认搜你自己发的消息（已过滤注入）。切到「AI 说的」可以搜 Claude
          的回答——它按「只看对话」的口径入库，工具调用和系统事件不收。中文 2 字词走
          LIKE、≥3 字走 trigram 全文索引。收录 OpenCode / Claude / Codex 三个 agent。
        </p>
      </header>

      <AnalyticsStrip windowKey={windowKey} setWindowKey={setWindowKey} />

      <form
        className="mb-4 flex items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          setOpenId(null);
          setSubmitted({ q: input.trim(), source, role });
        }}
      >
        <input
          type="text"
          value={input}
          placeholder="搜我说过的话…"
          onChange={(e) => {
            const v = e.target.value;
            setInput(v);
            // 清空输入 → 回到窗口浏览
            if (!v.trim()) {
              setSubmitted({ q: "", source: "", role: "user" });
              setOpenId(null);
            }
          }}
          className="min-w-0 flex-1 rounded border border-[var(--border)] bg-[var(--surface)] px-3 py-1.5 text-sm text-[var(--fg)]"
        />
        <select
          value={role}
          aria-label="搜谁说的话"
          onChange={(e) => setRole(e.target.value as RoleFilter)}
          className="rounded border border-[var(--border)] bg-[var(--surface)] px-2 py-1.5 text-sm text-[var(--fg)]"
        >
          {ROLE_FILTERS.map((r) => (
            <option key={r.value} value={r.value}>
              {r.label}
            </option>
          ))}
        </select>
        <select
          value={source}
          onChange={(e) => setSource(e.target.value)}
          className="rounded border border-[var(--border)] bg-[var(--surface)] px-2 py-1.5 text-sm text-[var(--fg)]"
        >
          {SOURCES.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </select>
        <button
          type="submit"
          disabled={!input.trim()}
          className="rounded-md border border-emerald-300 bg-emerald-50 px-3 py-1.5 text-sm text-emerald-800 hover:bg-emerald-100 disabled:opacity-50"
        >
          搜索
        </button>
      </form>

      {/* 搜索框为空 → 窗口浏览列表;有提交词 → 全量搜索结果 */}
      {submitted.q ? (
        <>
          {q.isError && (
            <div className="mb-4 rounded-md bg-rose-50 px-3 py-2 text-sm text-rose-800 ring-1 ring-rose-200">
              搜索失败：{(q.error as Error).message}
            </div>
          )}

          {!q.isLoading && !q.isError && (
            <div className="mb-1 text-xs text-[var(--fg-muted)]">
              「{submitted.q}」命中 {hits.length} 条
            </div>
          )}

          <MessageStream rows={searchRows} openId={openId} setOpenId={setOpenId} />

          {!q.isLoading && hits.length === 0 && !q.isError && (
            <div className="rounded-md border border-dashed border-[var(--border)] p-6 text-center text-sm text-[var(--fg-muted)]">
              没搜到「{submitted.q}」。
              {submitted.role === "user" ? (
                <>
                  试试切到「AI 说的」——
                  默认只搜你自己发的消息，AI 的回答要显式选。
                </>
              ) : (
                <>
                  换个词试试，或确认同步任务已跑过（
                  <code className="mx-1">agent_user_messages.claude.sync</code>）。
                  AI 的回答从 V53 起才入库，更早的会话只有你的提问。
                </>
              )}
            </div>
          )}
        </>
      ) : (
        <BrowseList windowKey={windowKey} />
      )}
    </main>
  );
}
