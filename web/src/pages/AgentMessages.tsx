import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
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

function fmtTime(iso: string): string {
  return new Date(iso).toLocaleString("zh-CN", { hour12: false });
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
  if (q.isLoading) return <div className="text-xs text-[var(--fg-muted)]">加载原文…</div>;
  if (q.isError)
    return <div className="text-xs text-rose-600">原文读取失败：{(q.error as Error).message}</div>;
  const raw = q.data!.raw;
  return (
    <div className="mt-2 space-y-2 border-t border-[var(--border)] pt-2 text-xs">
      <div className="text-[var(--fg-muted)]">
        清洗版本 v{raw.cleanerVersion} · is_human={String(raw.isHuman)} · session {raw.sourceSessionId}
      </div>
      <div>
        <div className="mb-1 font-medium text-[var(--fg)]">原文(raw_text)</div>
        <pre className="max-h-72 overflow-y-auto whitespace-pre-wrap break-words rounded bg-[var(--surface-2)] p-2 text-[var(--fg)]">
          {raw.rawText || "（空）"}
        </pre>
      </div>
    </div>
  );
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
  { value: "1d", label: "1天" },
  { value: "3d", label: "3天" },
  { value: "1w", label: "1周" },
  { value: "2w", label: "2周" },
  { value: "1m", label: "1月" },
  { value: "3m", label: "3月" },
  { value: "6m", label: "6月" },
] as const;

const SOURCE_META: Record<string, { label: string; color: string }> = {
  claude: { label: "Claude", color: "#d97757" },
  codex: { label: "Codex", color: "#2563eb" },
  opencode: { label: "OpenCode", color: "#7c3aed" },
};

const pad2 = (n: number) => String(n).padStart(2, "0");
/** x 轴标签按粒度自适应:小时→HH:00,天/周→MM-DD。 */
function bucketLabel(iso: string, g: Timeline["granularity"]): string {
  const d = new Date(iso);
  if (g === "hour" || g === "3hour") return `${pad2(d.getHours())}:00`;
  return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** 输入统计:累计(all-time)+ 可调窗口趋势图(recharts,自适应粒度 + 环比)。 */
function AnalyticsStrip() {
  const [windowKey, setWindowKey] = useState<string>("1w");
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
    <section className="mb-4 rounded-lg border border-[var(--border)] bg-[var(--surface)] p-3">
      {/* 累计(all-time)+ 窗口选择器(D5:累计与窗口分开标) */}
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
              className={`rounded px-1.5 py-0.5 ${
                windowKey === w.value
                  ? "bg-[var(--fg)] text-[var(--surface)]"
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

export function AgentMessages() {
  const [input, setInput] = useState("");
  const [source, setSource] = useState("");
  const [submitted, setSubmitted] = useState<{ q: string; source: string }>({ q: "", source: "" });
  const [openId, setOpenId] = useState<number | null>(null);

  const q = useQuery<SearchResp>({
    queryKey: ["aum-search", submitted.q, submitted.source],
    queryFn: () => {
      const p = new URLSearchParams({ q: submitted.q });
      if (submitted.source) p.set("source", submitted.source);
      return apiGet<SearchResp>(`/api/agent-user-messages/search?${p.toString()}`);
    },
    enabled: submitted.q.trim().length > 0,
  });

  const hits = q.data?.hits ?? [];

  return (
    <main className="mx-auto max-w-[900px] px-8 py-6">
      <header className="mb-5">
        <h1 className="text-xl font-semibold text-[var(--fg)]">对话搜索</h1>
        <p className="mt-1 text-xs text-[var(--fg-muted)]">
          搜索你在各 AI agent 会话里**自己发的**消息（已过滤注入）。中文 2 字词走 LIKE、≥3 字走 trigram
          全文索引。收录 OpenCode / Claude / Codex 三个 agent。
        </p>
      </header>

      <AnalyticsStrip />

      <form
        className="mb-4 flex items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          setOpenId(null);
          setSubmitted({ q: input.trim(), source });
        }}
      >
        <input
          type="text"
          value={input}
          placeholder="搜我说过的话…"
          onChange={(e) => setInput(e.target.value)}
          className="min-w-0 flex-1 rounded border border-[var(--border)] bg-[var(--surface)] px-3 py-1.5 text-sm text-[var(--fg)]"
        />
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

      {q.isError && (
        <div className="mb-4 rounded-md bg-rose-50 px-3 py-2 text-sm text-rose-800 ring-1 ring-rose-200">
          搜索失败：{(q.error as Error).message}
        </div>
      )}

      {submitted.q && !q.isLoading && (
        <div className="mb-2 text-xs text-[var(--fg-muted)]">
          「{submitted.q}」命中 {hits.length} 条
        </div>
      )}

      <div className="space-y-2">
        {hits.map((h) => (
          <section
            key={h.id}
            className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-3"
          >
            <div className="mb-1 flex items-center gap-2 text-xs text-[var(--fg-muted)]">
              <span className="rounded bg-[var(--surface-2)] px-1.5 py-0.5 text-[11px] uppercase">
                {h.source}
              </span>
              <span>{fmtTime(h.eventAtUtc)}</span>
              <button
                type="button"
                className="ml-auto text-[var(--fg-muted)] underline hover:text-[var(--fg)]"
                onClick={() => setOpenId(openId === h.id ? null : h.id)}
              >
                {openId === h.id ? "收起原文" : "查看原文"}
              </button>
            </div>
            <div className="whitespace-pre-wrap break-words text-sm text-[var(--fg)]">
              <Snippet text={h.snippet} />
            </div>
            {openId === h.id && <RawPanel id={h.id} />}
          </section>
        ))}
      </div>

      {submitted.q && !q.isLoading && hits.length === 0 && !q.isError && (
        <div className="rounded-md border border-dashed border-[var(--border)] p-6 text-center text-sm text-[var(--fg-muted)]">
          没搜到「{submitted.q}」。换个词试试，或确认 OpenCode 用量历史已同步（定时任务
          <code className="mx-1">agent_user_messages.opencode.sync</code>）。
        </div>
      )}
    </main>
  );
}
