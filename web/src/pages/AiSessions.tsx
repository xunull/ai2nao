import { useEffect, useMemo, useState } from "react";
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
  hermes: { label: "Hermes", color: "#c026d3" },
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

  // 下钻区按**工作目录**分组。
  //
  // 为什么不是平铺加一列:页面可见的 159 个目录里 85.5% 超过 50 字符,
  // 而那一行已经有源/标题/条数/时长四列,塞第五列必挤爆标题。
  //
  // 为什么组内还要封顶 + 整个区域独立滚动:1280×860(桌面端真实默认窗口)下,
  // 平铺封顶 20 行是 1.42 屏;16 个组头 + 首组 20 行是 1.99 屏 —— **更差**。
  // 反解出总行数上限约 13 行,而 16 个组头本身就超了,所以靠调封顶数字治不住。
  // 把下钻区从页面滚动里摘出来才是结构性的:页面恒定 ≈1 屏,与那天多忙无关。
  const GROUP_CAP = 20;

  const groups = useMemo(() => {
    const all = detail.data?.sessions ?? [];
    // key 用 projectPath 原值(含 null)。**不能用 COUNT(DISTINCT) 的口径** ——
    // SQL 忽略 NULL,而 null 必须自成一组(真库 08-25 就是 SQL 给 7 / 正确答案 8)。
    const by = new Map<string, { path: string | null; items: DaySession[] }>();
    for (const x of all) {
      const k = x.projectPath ?? "\u0000null";
      const g = by.get(k) ?? { path: x.projectPath, items: [] };
      g.items.push(x);
      by.set(k, g);
    }
    // 组内自己排,**不依赖后端的 ORDER BY** —— 依赖它的话组件就静默耦合到
    // 那条 SQL 上,改了 SQL 界面顺序会坏而没有任何测试能抓到(这一条是
    // 组件测试用乱序 mock 喂进来才发现的)。
    for (const g of by.values()) g.items.sort((x, y) => y.messages - x.messages);
    // 组序:会话数倒序 → 同数按组内最大消息数倒序 → 再按路径字典序。
    // tie-break 不能省:实测 76.3% 的组是单场组,不写死就等于把顺序
    // 交给 Array.sort 的稳定性,结果确定但语义是偶然的。
    return [...by.values()].sort((a, b) => {
      if (b.items.length !== a.items.length) return b.items.length - a.items.length;
      const am = Math.max(...a.items.map((x) => x.messages));
      const bm = Math.max(...b.items.map((x) => x.messages));
      if (bm !== am) return bm - am;
      return (a.path ?? "").localeCompare(b.path ?? "");
    });
  }, [detail.data]);

  // 首个**多场**组默认展开(单场组是内联的,不需要展开)。
  const firstMulti = groups.find((g) => g.items.length > 1)?.path ?? null;
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  // 切换日期必须重置 —— 组件不卸载,而日均 6.6 个目录里撞名是常态,
  // 不重置的话上一天展开过的路径在新的一天还是展开的。
  //
  // 依赖里的 `day` 是**防御性的,不是承重的**:实测把它从 deps 里删掉,
  // 9 条测试一条都不红 —— 因为切日期时 react-query 会先进 loading
  // (detail.data 变 undefined → groups 空 → firstMulti 变 null),
  // effect 靠 firstMulti 就重跑了。留着它是为了将来若引入
  // keepPreviousData / 缓存命中(没有 loading 间隙)时仍然正确。
  // 真正被测试守住的是**整个 effect**:删掉它,4 条会红。
  useEffect(() => {
    setExpanded(new Set(firstMulti === null ? [] : [firstMulti]));
  }, [day, firstMulti]);

  const toggle = (k: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });

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

          {/* 图表在 jsdom 里没有尺寸,柱子点不到 —— 给每天一个 sr-only 入口,
              既让键盘用户能到达,也让组件测试有稳定的落点。 */}
          <div className="sr-only">
            {rows.map((r) => (
              <button key={r.day} data-testid={`open-day-${r.day}`} onClick={() => setDay(r.day)}>
                {r.day}
              </button>
            ))}
          </div>

          {/* 覆盖面随数字一起显示 —— 不写明就读起来像「全部 AI 会话」。 */}
          <p className="mt-2 text-[11px] leading-relaxed text-[var(--muted)]">
            覆盖 {data!.coverage.sources.join(" / ")}。{data!.coverage.note}
          </p>

          {day && (
            <section data-testid="day-detail" className="mt-5 border-t border-[var(--border)] pt-4">
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
                <div
                  data-testid="day-detail-scroll"
                  className="mt-2 max-h-[38vh] overflow-y-auto pr-1"
                >
                  {groups.map((g) => {
                    const key = g.path ?? "\u0000null";
                    const single = g.items.length === 1;
                    const open = single || expanded.has(key);
                    const shown = g.items.slice(0, GROUP_CAP);
                    return (
                      <div key={key} className="border-t border-[var(--border)] first:border-t-0">
                        <div
                          data-testid={`group-head-${key}`}
                          data-path={g.path ?? ""}
                          className="flex items-center gap-3 py-1.5 text-xs"
                        >
                          {single ? (
                            <>
                              <GroupLabel path={g.path} />
                              <SessionCells s={g.items[0]!} />
                            </>
                          ) : (
                            <button
                              onClick={() => toggle(key)}
                              className="flex w-full items-center gap-2 text-left"
                            >
                              <span className="w-3 shrink-0 text-[var(--muted)]">
                                {open ? "▾" : "▸"}
                              </span>
                              <GroupLabel path={g.path} />
                              <span className="ml-auto shrink-0 text-[var(--muted)]">
                                {g.items.length} 场
                              </span>
                            </button>
                          )}
                        </div>
                        {!single && open && (
                          <ul
                            data-testid={`group-body-${key}`}
                            className="divide-y divide-[var(--border)] pl-5"
                          >
                            {shown.map((s) => (
                              <li
                                key={`${s.source}/${s.sessionId}`}
                                className="flex items-center gap-3 py-1.5 text-xs"
                              >
                                <SessionCells s={s} />
                              </li>
                            ))}
                          </ul>
                        )}
                        {!single && open && g.items.length > GROUP_CAP && (
                          <p className="py-1 pl-5 text-[11px] text-[var(--muted)]">
                            按消息数倒序，只显示前 {GROUP_CAP} 场；这个目录共 {g.items.length} 场。
                          </p>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </section>
          )}
        </>
      )}
    </div>
  );
}

/**
 * 组头的目录标签,三态:
 *   真路径        原样(前端把 /Users/<name> 缩成 ~ —— 浏览器里没有 $HOME,
 *                 后端也不下发,所以这是个启发式。实测页面可见的 159 个目录
 *                 159/159 都在 /Users/ 下,可行;但它是 macOS-only 的猜测。
 *                 这条 regex 不含用户名,gitleaks 既不误报也不漏放。)
 *   kimi:conv-*   「无工作目录」—— 桌面版对话,本来就没有 cwd
 *   null          「无目录记录」—— 有会话但没留下 duration 行
 * 后两者**不能混成一句** —— 一个是「设计如此」,一个是「数据缺失」。
 */
function GroupLabel({ path }: { path: string | null }) {
  if (path === null) {
    return <span className="truncate text-[var(--muted)] italic">无目录记录</span>;
  }
  if (!path.startsWith("/")) {
    return <span className="truncate text-[var(--muted)] italic">无工作目录 · kimi 桌面版对话</span>;
  }
  return (
    <span className="truncate font-mono" title={path}>
      {path.replace(/^\/Users\/[^/]+/, "~")}
    </span>
  );
}

function SessionCells({ s }: { s: DaySession }) {
  return (
    <>
      <span
        className="w-24 shrink-0 font-medium"
        style={{ color: SOURCE_META[s.source as SourceKey]?.color }}
      >
        {SOURCE_META[s.source as SourceKey]?.label ?? s.source}
      </span>
      <span className="min-w-0 flex-1 truncate">
        {s.title ?? (
          <span className="text-[var(--muted)]">无标题 · {s.sessionId.slice(0, 24)}</span>
        )}
      </span>
      <span className="w-20 shrink-0 text-right text-[var(--muted)]">{s.messages} 条</span>
      <span className="w-24 shrink-0 text-right text-[var(--muted)]">{fmtMs(s.activeMs)}</span>
    </>
  );
}
