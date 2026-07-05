import { useQuery } from "@tanstack/react-query";
import {
  Area,
  AreaChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { apiGet } from "../api";

// 三源品牌色,与全 app 一致(AgentMessages SOURCE_META)。
const SOURCE_COLORS = {
  claude: "#d97757",
  codex: "#2563eb",
  opencode: "#7c3aed",
} as const;

type Cell = { weekday: number; hour: number; count: number }; // weekday 0=周日
type HeatmapResp = {
  ok: true;
  cells: Cell[];
  maxCount: number;
  total: number;
  peak: Cell | null;
  generatedAt: string;
};

// 显示周一起:行 = weekday 值(1..6,0),对应「一二三四五六日」。
const ROW_WEEKDAYS = [1, 2, 3, 4, 5, 6, 0] as const;
const WEEKDAY_CN = ["日", "一", "二", "三", "四", "五", "六"]; // 索引 = weekday 值
const HOURS = Array.from({ length: 24 }, (_, h) => h);

const CELL = 22;
const LEFT = 40; // 周几标签
const TOP = 18; // 整点标签

const pad2 = (n: number) => String(n).padStart(2, "0");

/** 借 TagTimeHeatmap 的 5 档绿阶;maxCount=0 时防除零(全取最浅)。 */
function colorFor(count: number, maxCount: number): string {
  if (count === 0) return "#ebedf0";
  const ratio = count / Math.max(1, maxCount);
  if (ratio < 0.2) return "#c6e48b";
  if (ratio < 0.45) return "#7bc96f";
  if (ratio < 0.75) return "#239a3b";
  return "#196127";
}

function Heatmap({ data }: { data: HeatmapResp }) {
  const byKey = new Map<string, number>();
  for (const c of data.cells) byKey.set(`${c.weekday}-${c.hour}`, c.count);

  const width = LEFT + HOURS.length * CELL + 8;
  const height = TOP + ROW_WEEKDAYS.length * CELL + 8;

  const peakLine = data.peak
    ? `最活跃:周${WEEKDAY_CN[data.peak.weekday]} ${pad2(data.peak.hour)}:00 · ${data.peak.count} 条`
    : "还没有已索引的消息";

  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-[var(--fg-muted)]">
        <span className="font-medium text-[var(--fg)]">{peakLine}</span>
        <span>累计 {data.total} 条</span>
        <span className="ml-auto flex items-center gap-1">
          少
          {["#ebedf0", "#c6e48b", "#7bc96f", "#239a3b", "#196127"].map((c) => (
            <span
              key={c}
              className="inline-block h-3 w-3 rounded-sm"
              style={{ background: c }}
            />
          ))}
          多
        </span>
      </div>

      {/* overflow-x-auto 兜底:24 列固定尺寸正常不溢出,极端窄容器下内部滚动,不给整页横滚 */}
      <div className="overflow-x-auto rounded-lg border border-[var(--border)] bg-[var(--surface)] p-3">
        <svg width={width} height={height} role="img" aria-label="作息热力图(星期 × 小时)">
          {/* 整点标签(每 3 小时一个,避免拥挤) */}
          <g transform={`translate(${LEFT}, ${TOP - 6})`}>
            {HOURS.map((h) =>
              h % 3 === 0 ? (
                <text
                  key={h}
                  x={h * CELL + CELL / 2}
                  y={0}
                  fontSize="9"
                  fill="#6b7280"
                  textAnchor="middle"
                >
                  {h}
                </text>
              ) : null
            )}
          </g>
          {/* 周几标签 */}
          <g transform={`translate(0, ${TOP})`}>
            {ROW_WEEKDAYS.map((wd, i) => (
              <text
                key={wd}
                x={LEFT - 8}
                y={i * CELL + CELL / 2 + 4}
                fontSize="10"
                fill="#6b7280"
                textAnchor="end"
              >
                周{WEEKDAY_CN[wd]}
              </text>
            ))}
          </g>
          {/* 格子 */}
          <g transform={`translate(${LEFT}, ${TOP})`}>
            {ROW_WEEKDAYS.map((wd, i) =>
              HOURS.map((h) => {
                const count = byKey.get(`${wd}-${h}`) ?? 0;
                return (
                  <rect
                    key={`${wd}-${h}`}
                    x={h * CELL}
                    y={i * CELL}
                    width={CELL - 2}
                    height={CELL - 2}
                    rx={3}
                    fill={colorFor(count, data.maxCount)}
                  >
                    <title>
                      周{WEEKDAY_CN[wd]} {pad2(h)}:00 · {count} 条
                    </title>
                  </rect>
                );
              })
            )}
          </g>
        </svg>
      </div>

      <div className="mt-2 text-[10px] text-[var(--fg-muted)]">
        数据 = 已索引消息快照(按小时增量同步,非实时)· 更新于{" "}
        {new Date(data.generatedAt).toLocaleString("zh-CN", { hour12: false })}
      </div>
    </div>
  );
}

type StreakResp = {
  ok: true;
  currentStreak: number;
  longestStreak: number;
  todayActive: boolean;
  lastActiveDay: string | null;
  totalActiveDays: number;
  generatedAt: string;
};

/** 连续天数纪录卡(Duolingo 式):当前连续🔥 + 历史最长 + 累计 + 未记录提醒。 */
function StreakCard() {
  const q = useQuery<StreakResp>({
    queryKey: ["ai-rhythm-streak"],
    queryFn: () => apiGet<StreakResp>("/api/ai-rhythm/streak"),
  });

  if (q.isLoading) {
    return <div className="mt-4 text-xs text-[var(--fg-muted)]">加载连续纪录…</div>;
  }
  if (q.isError) {
    return (
      <div className="mt-4 rounded-md bg-rose-50 px-3 py-2 text-sm text-rose-800 ring-1 ring-rose-200">
        连续纪录加载失败：{(q.error as Error).message}
      </div>
    );
  }
  const d = q.data!;
  const empty = d.totalActiveDays === 0;
  const broken = !empty && d.currentStreak === 0;
  const graceNudge = d.currentStreak > 0 && !d.todayActive;

  const note = empty
    ? "还没有记录"
    : broken
      ? "连续已断,今天发一条重新开始"
      : graceNudge
        ? "今天还没记录,别断了 🔥"
        : "保持住 🔥";

  return (
    <div className="mt-4 rounded-lg border border-[var(--border)] bg-[var(--surface)] p-4">
      <div className="flex flex-wrap items-baseline gap-x-8 gap-y-2">
        <div>
          <div className="text-3xl font-semibold text-[var(--fg)]">
            🔥 {d.currentStreak}
            <span className="ml-1 text-sm font-normal text-[var(--fg-muted)]">天</span>
          </div>
          <div className="mt-0.5 text-xs text-[var(--fg-muted)]">当前连续</div>
        </div>
        <div>
          <div className="text-xl font-semibold text-[var(--fg)]">{d.longestStreak} 天</div>
          <div className="mt-0.5 text-xs text-[var(--fg-muted)]">历史最长</div>
        </div>
        <div>
          <div className="text-xl font-semibold text-[var(--fg)]">{d.totalActiveDays} 天</div>
          <div className="mt-0.5 text-xs text-[var(--fg-muted)]">累计活跃</div>
        </div>
        <div
          className={`ml-auto self-center text-sm ${
            graceNudge ? "font-medium text-amber-600" : "text-[var(--fg-muted)]"
          }`}
        >
          {note}
        </div>
      </div>
    </div>
  );
}

type CommandRank = { name: string; count: number };
type CommandsResp = {
  ok: true;
  commands: CommandRank[];
  maxCount: number;
  totalCommands: number;
  distinctCommands: number;
  generatedAt: string;
};

/** 命令 / 技能用量排行卡:top N + 次数 + 占比横条。 */
function CommandLeaderboardCard() {
  const q = useQuery<CommandsResp>({
    queryKey: ["ai-rhythm-commands"],
    queryFn: () => apiGet<CommandsResp>("/api/ai-rhythm/commands"),
  });

  if (q.isLoading) {
    return <div className="mt-4 text-xs text-[var(--fg-muted)]">加载命令排行…</div>;
  }
  if (q.isError) {
    return (
      <div className="mt-4 rounded-md bg-rose-50 px-3 py-2 text-sm text-rose-800 ring-1 ring-rose-200">
        命令排行加载失败：{(q.error as Error).message}
      </div>
    );
  }
  const d = q.data!;
  return (
    <div className="mt-4 rounded-lg border border-[var(--border)] bg-[var(--surface)] p-4">
      <div className="mb-3 flex items-baseline justify-between">
        <h2 className="text-sm font-medium text-[var(--fg)]">
          命令 / 技能排行 <span className="text-[var(--fg-muted)]">· 你最依赖的工作流</span>
        </h2>
        <span className="text-xs text-[var(--fg-muted)]">
          {d.totalCommands} 次 · {d.distinctCommands} 种
        </span>
      </div>
      {d.commands.length === 0 ? (
        <p className="text-xs text-[var(--fg-muted)]">还没有命令调用</p>
      ) : (
        <ol className="space-y-1.5">
          {d.commands.map((c) => (
            <li key={c.name} className="flex items-center gap-3 text-xs">
              <code className="w-52 shrink-0 truncate text-[var(--fg)]" title={`/${c.name}`}>
                /{c.name}
              </code>
              <div className="h-2 flex-1 overflow-hidden rounded-sm bg-[var(--border)]/40">
                <div
                  className="h-full rounded-sm bg-emerald-500"
                  style={{ width: `${(c.count / Math.max(1, d.maxCount)) * 100}%` }}
                />
              </div>
              <span className="w-10 shrink-0 text-right tabular-nums text-[var(--fg-muted)]">
                {c.count}
              </span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

type WeekMix = {
  week: string;
  claude: number;
  codex: number;
  opencode: number;
  total: number;
};
type SourceTrendResp = { ok: true; weeks: WeekMix[]; generatedAt: string };

/** 习惯演变 · 三源迁移卡:每周三源计数的堆叠面积。 */
function SourceTrendCard() {
  const q = useQuery<SourceTrendResp>({
    queryKey: ["ai-rhythm-source-trend"],
    queryFn: () => apiGet<SourceTrendResp>("/api/ai-rhythm/source-trend"),
  });

  if (q.isLoading) {
    return <div className="mt-4 text-xs text-[var(--fg-muted)]">加载习惯曲线…</div>;
  }
  if (q.isError) {
    return (
      <div className="mt-4 rounded-md bg-rose-50 px-3 py-2 text-sm text-rose-800 ring-1 ring-rose-200">
        习惯曲线加载失败：{(q.error as Error).message}
      </div>
    );
  }
  const weeks = q.data!.weeks;
  return (
    <div className="mt-4 rounded-lg border border-[var(--border)] bg-[var(--surface)] p-4">
      <div className="mb-3 flex items-baseline justify-between">
        <h2 className="text-sm font-medium text-[var(--fg)]">
          习惯演变 · 三源迁移{" "}
          <span className="text-[var(--fg-muted)]">· 你按周用哪个 agent</span>
        </h2>
        <div className="flex items-center gap-3 text-xs text-[var(--fg-muted)]">
          {(["claude", "codex", "opencode"] as const).map((s) => (
            <span key={s} className="flex items-center gap-1">
              <span
                className="inline-block h-2.5 w-2.5 rounded-sm"
                style={{ background: SOURCE_COLORS[s] }}
              />
              {s}
            </span>
          ))}
        </div>
      </div>
      {weeks.length === 0 ? (
        <p className="text-xs text-[var(--fg-muted)]">还没有足够数据</p>
      ) : (
        <div className="h-44">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={weeks} margin={{ top: 6, right: 8, left: 0, bottom: 0 }}>
              <XAxis
                dataKey="week"
                tickFormatter={(w: string) => w.replace(/^\d{4}-/, "")}
                tick={{ fontSize: 10, fill: "#6b7280" }}
                interval="preserveStartEnd"
              />
              <YAxis
                tick={{ fontSize: 10, fill: "#6b7280" }}
                width={40}
                allowDecimals={false}
              />
              <Tooltip
                contentStyle={{ fontSize: 12 }}
                labelFormatter={(label) => String(label).replace(/^\d{4}-/, "")}
              />
              {/* codex 在底(初期主力),claude 在上(后期反超),迁移一眼可见 */}
              <Area
                type="monotone"
                dataKey="codex"
                stackId="s"
                stroke={SOURCE_COLORS.codex}
                fill={SOURCE_COLORS.codex}
                fillOpacity={0.75}
              />
              <Area
                type="monotone"
                dataKey="claude"
                stackId="s"
                stroke={SOURCE_COLORS.claude}
                fill={SOURCE_COLORS.claude}
                fillOpacity={0.75}
              />
              <Area
                type="monotone"
                dataKey="opencode"
                stackId="s"
                stroke={SOURCE_COLORS.opencode}
                fill={SOURCE_COLORS.opencode}
                fillOpacity={0.75}
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}

/** 「我的 AI 节律」自量化仪表盘:作息热力图 + 连续天数 + 命令排行 + 习惯演变。 */
export function AiRhythm() {
  const q = useQuery<HeatmapResp>({
    queryKey: ["ai-rhythm-heatmap"],
    queryFn: () => apiGet<HeatmapResp>("/api/ai-rhythm/heatmap"),
  });

  return (
    <main className="mx-auto max-w-[900px] px-8 py-6">
      <header className="mb-5">
        <h1 className="text-xl font-semibold text-[var(--fg)]">已索引消息节律</h1>
        <p className="mt-1 text-xs text-[var(--fg-muted)]">
          你对各 AI agent 说过的话(仅本人、已过滤注入)按「本地星期几 × 整点」的分布 —— 一眼看出你的作息节律。
          全源合计。数据是已索引消息的快照,非实时。
        </p>
      </header>

      {q.isLoading ? (
        <div className="text-xs text-[var(--fg-muted)]">加载热力图…</div>
      ) : q.isError ? (
        <div className="rounded-md bg-rose-50 px-3 py-2 text-sm text-rose-800 ring-1 ring-rose-200">
          加载失败：{(q.error as Error).message}
        </div>
      ) : (
        <Heatmap data={q.data!} />
      )}

      <StreakCard />
      <CommandLeaderboardCard />
      <SourceTrendCard />
    </main>
  );
}
