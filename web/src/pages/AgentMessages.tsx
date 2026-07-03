import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
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

type AnalyticsResp = {
  ok: true;
  totals: { source: string; count: number; charSum: number }[];
  byDay: { day: string; count: number }[];
};

const SOURCE_LABEL: Record<string, string> = {
  opencode: "OpenCode",
  claude: "Claude",
  codex: "Codex",
};

/** 紧凑统计条:跨源计数 + 近 30 天输入量迷你柱(不竖向铺开)。 */
function AnalyticsStrip() {
  const q = useQuery<AnalyticsResp>({
    queryKey: ["aum-analytics"],
    queryFn: () => apiGet<AnalyticsResp>("/api/agent-user-messages/analytics"),
  });
  if (!q.data) return null;
  const { totals, byDay } = q.data;
  const grand = totals.reduce((a, t) => a + t.count, 0);
  if (grand === 0) return null;
  const recent = byDay.slice(-30);
  const max = Math.max(1, ...recent.map((d) => d.count));

  return (
    <section className="mb-4 rounded-lg border border-[var(--border)] bg-[var(--surface)] p-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-[var(--fg-muted)]">
        <span className="font-medium text-[var(--fg)]">我的输入 · 共 {grand} 条</span>
        {totals.map((t) => (
          <span key={t.source}>
            {SOURCE_LABEL[t.source] ?? t.source} {t.count} 条 · {t.charSum} 字
          </span>
        ))}
      </div>
      {recent.length > 0 && (
        <>
          <div className="mt-2 flex h-12 items-end gap-0.5">
            {recent.map((d) => (
              <div
                key={d.day}
                title={`${d.day}: ${d.count} 条`}
                className="min-h-[2px] flex-1 rounded-sm bg-emerald-300"
                style={{ height: `${(d.count / max) * 100}%` }}
              />
            ))}
          </div>
          <div className="mt-1 text-[10px] text-[var(--fg-muted)]">
            近 {recent.length} 天每日输入量(峰值 {max} 条/天)
          </div>
        </>
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
