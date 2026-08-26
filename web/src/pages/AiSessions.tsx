import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  ComposedChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { apiGet } from "../api";

/**
 * 每天有多少 AI 会话。
 *
 * 口径：**按有活动的天** —— 那天只要跟这场会话有来往就计一次。
 * 真库 42.3% 的 claude 会话跨天（最长 56 天），按开始日算会让「整天在续旧会话」
 * 的日子显示成零。
 *
 * 两条线都来自 `agent_user_messages`，所以同集合、可比：
 *   柱（堆叠） = 在用   折线 = 新开（首条消息日）
 */

const SOURCE_META = {
  claude: { label: "Claude Code", color: "#d97757" },
  codex: { label: "Codex", color: "#2563eb" },
  opencode: { label: "opencode", color: "#0d9488" },
  kimi: { label: "Kimi", color: "#7c3aed" },
} as const;
type SourceKey = keyof typeof SOURCE_META;
const SOURCES = Object.keys(SOURCE_META) as SourceKey[];

const WINDOWS = [
  { key: "1w", label: "最近 7 天" },
  { key: "1m", label: "最近 30 天" },
  { key: "3m", label: "最近 90 天" },
  { key: "6m", label: "最近 180 天" },
] as const;

type DailyPoint = { day: string; sessions: number; bySource: Record<string, number> };
type Resp = {
  window: string;
  from: string;
  to: string;
  active: DailyPoint[];
  started: DailyPoint[];
  coverage: { sources: string[]; note: string };
};
type DaySession = {
  source: string;
  sessionId: string;
  messages: number;
  title: string | null;
  activeMs: number | null;
  projectPath: string | null;
};

const fmtMs = (ms: number | null): string => {
  if (ms == null) return "—";
  const m = Math.round(ms / 60000);
  return m < 60 ? `${m} 分钟` : `${Math.floor(m / 60)} 小时 ${m % 60} 分`;
};

export function AiSessions() {
  const [win, setWin] = useState<(typeof WINDOWS)[number]["key"]>("3m");
  const [day, setDay] = useState<string | null>(null);

  const { data, isLoading, error } = useQuery({
    queryKey: ["ai-sessions", win],
    queryFn: () => apiGet<Resp>(`/api/ai-sessions?window=${win}`),
  });
  const detail = useQuery({
    queryKey: ["ai-sessions-day", day],
    queryFn: () => apiGet<{ day: string; sessions: DaySession[] }>(`/api/ai-sessions/day/${day}`),
    enabled: day != null,
  });

  const started = new Map((data?.started ?? []).map((p) => [p.day, p.sessions]));
  const rows = (data?.active ?? []).map((p) => ({
    day: p.day,
    label: p.day.slice(5),
    ...Object.fromEntries(SOURCES.map((s) => [s, p.bySource[s] ?? 0])),
    新开: started.get(p.day) ?? 0,
  }));

  // 忙的一天能有 84 场会话 —— 全列出来是 2.3 屏,撞 CLAUDE.md 的
  // 「禁止垂直上限滚动太多」。封顶到 20 条,余下的显式说明有多少,
  // **不静默截断**(按消息数倒序,所以留下的是那天真正花了功夫的)。
  const DETAIL_CAP = 20;
  const allDetail = detail.data?.sessions ?? [];
  const shownDetail = allDetail.slice(0, DETAIL_CAP);

  const total = (data?.active ?? []).reduce((n, p) => n + p.sessions, 0);
  const days = data?.active.length ?? 0;

  return (
    <div className="px-8 py-5">
      <header className="flex items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">每日会话</h1>
          <p className="mt-1 text-sm text-[var(--muted)]">
            那天在跟几个 AI 会话打交道。跨天的会话，在<b>每个</b>有活动的天都计一次。
          </p>
        </div>
        <div className="flex items-center gap-2">
          {WINDOWS.map((w) => (
            <button
              key={w.key}
              onClick={() => {
                setWin(w.key);
                setDay(null);
              }}
              className={`rounded px-2.5 py-1 text-xs ${
                win === w.key
                  ? "bg-[var(--fg)] text-[var(--bg)]"
                  : "border border-[var(--border)] text-[var(--muted)]"
              }`}
            >
              {w.label}
            </button>
          ))}
        </div>
      </header>

      {error ? (
        <p className="mt-6 text-sm text-red-600">加载失败：{String(error)}</p>
      ) : isLoading ? (
        <p className="mt-6 text-sm text-[var(--muted)]">加载中…</p>
      ) : days === 0 ? (
        <p className="mt-6 text-sm text-[var(--muted)]">这个时间范围内没有会话记录。</p>
      ) : (
        <>
          <div className="mt-3 flex items-baseline gap-6 text-sm">
            <span>
              <b className="text-lg">{total}</b> 场会话
            </span>
            <span className="text-[var(--muted)]">
              {days} 天有记录 · 日均 {(total / days).toFixed(1)}
            </span>
          </div>

          <div className="mt-4 h-[300px]">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={rows} margin={{ top: 8, right: 8, bottom: 0, left: -18 }}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--border)" />
                <XAxis dataKey="label" tick={{ fontSize: 11 }} interval="preserveStartEnd" />
                <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
                <Tooltip
                  contentStyle={{ fontSize: 12 }}
                  labelFormatter={(l) => `${l}（点柱子看当天会话）`}
                />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                {SOURCES.map((s) => (
                  <Bar
                    key={s}
                    dataKey={s}
                    name={SOURCE_META[s].label}
                    stackId="a"
                    fill={SOURCE_META[s].color}
                    isAnimationActive={false}
                    onClick={(d: { payload?: { day?: string } }) => setDay(d?.payload?.day ?? null)}
                    cursor="pointer"
                  />
                ))}
                <Line
                  type="monotone"
                  dataKey="新开"
                  stroke="var(--fg)"
                  strokeWidth={1.5}
                  dot={false}
                  isAnimationActive={false}
                />
              </ComposedChart>
            </ResponsiveContainer>
          </div>

          {/* 覆盖面随数字一起显示 —— 不写明就读起来像「全部 AI 会话」。 */}
          <p className="mt-2 text-[11px] leading-relaxed text-[var(--muted)]">
            覆盖 {data!.coverage.sources.join(" / ")}。{data!.coverage.note}
          </p>

          {day && (
            <section className="mt-5 border-t border-[var(--border)] pt-4">
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-medium">{day} 的会话</h2>
                <button
                  onClick={() => setDay(null)}
                  className="text-xs text-[var(--muted)] hover:underline"
                >
                  收起
                </button>
              </div>
              {detail.isLoading ? (
                <p className="mt-2 text-sm text-[var(--muted)]">加载中…</p>
              ) : (
                <ul className="mt-2 divide-y divide-[var(--border)]">
                  {shownDetail.map((s) => (
                    <li key={`${s.source}/${s.sessionId}`} className="flex gap-3 py-1.5 text-xs">
                      <span
                        className="w-24 shrink-0 font-medium"
                        style={{ color: SOURCE_META[s.source as SourceKey]?.color }}
                      >
                        {SOURCE_META[s.source as SourceKey]?.label ?? s.source}
                      </span>
                      <span className="min-w-0 flex-1 truncate">
                        {s.title ?? (
                          <span className="text-[var(--muted)]">
                            无时长记录 · {s.sessionId.slice(0, 28)}
                          </span>
                        )}
                      </span>
                      <span className="w-20 shrink-0 text-right text-[var(--muted)]">
                        {s.messages} 条
                      </span>
                      <span className="w-24 shrink-0 text-right text-[var(--muted)]">
                        {fmtMs(s.activeMs)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              {allDetail.length > DETAIL_CAP && (
                <p className="mt-2 text-[11px] text-[var(--muted)]">
                  按消息数倒序，只显示前 {DETAIL_CAP} 场；这天共 {allDetail.length} 场。
                </p>
              )}
            </section>
          )}
        </>
      )}
    </div>
  );
}
