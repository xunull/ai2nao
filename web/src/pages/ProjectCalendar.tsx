/**
 * 项目活动日历 —— 「那一天,哪些项目在动」。
 *
 *   左:月历,格子色阶 = 当天**活跃项目数**(不是对话条数)。
 *      本机实测 96 天里 93 天有对话,所以「有活动就高亮」和「按条数染色」两个维度
 *      都已经饱和、看不出东西。有区分度的是注意力散成了几瓣。
 *      五档按实测分布切:1 / 2-3 / 4-5 / 6-8 / 9+。
 *      无对话但有提交的日子打一个小点,不参与色阶(否则 rebase 能把「专注的一天」染成「乱跳」)。
 *
 *   右:当日面板。主列表只含**有对话**的项目(行数恒等于格子上的数字);
 *      「只有提交、没有对话」的项目放底部折叠区,两者都不丢也不互相污染。
 *
 * 时区(设计 R8):服务端权威。「今天」用响应里的 serverToday,不用 new Date();
 * 日期全程以 'YYYY-MM-DD' 字符串作 key;需要 Date 对象时一律**本地构造**
 * new Date(y, m-1, d) —— new Date('2026-07-28') 按 UTC 午夜解析,负时区会错一天。
 *
 * 布局(项目铁律):不出横向滚动条 —— 长 slug / 长 commit subject 一律 truncate + title。
 *
 * 垂直方向交给 Layout 的 <main>(它是全站的滚动容器,`min-h-0 flex-1 overflow-y-auto`)。
 * 这里**不**自己造内部滚动容器:main 和页面之间还隔着一层高度 auto 的 `py-5` wrapper,
 * 任何 h-full / calc(100vh - Xrem) 都得去猜 Layout 的内边距,Layout 一改就静默失效。
 * 取而代之:左侧日历 sticky 常驻(滚动时不跑掉),右侧随 main 自然滚 —— 与全站其它页一致。
 */
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { zhCN } from "date-fns/locale";
import { useMemo, useState } from "react";
import { DayPicker } from "react-day-picker";
import "react-day-picker/style.css";
import { apiGet, apiPost } from "../api";

type MonthDay = {
  day: string;
  projectCount: number;
  messageCount: number;
  commitCount: number;
  commitOnlyProjectCount: number;
};

type MonthRes = {
  year: number;
  month: number;
  days: MonthDay[];
  serverToday: string;
  dataStartDay: string | null;
};

type DaySourceCount = { source: string; count: number };
type DayCommit = { hash: string; subject: string; atMs: number };

type DayProject = {
  key: string;
  name: string;
  path: string | null;
  messageCount: number;
  bySource: DaySourceCount[];
  firstAtMs: number;
  lastAtMs: number;
  firstHumanText: string;
  commits: DayCommit[];
};

type DayCommitOnlyProject = {
  key: string;
  name: string;
  path: string | null;
  commits: DayCommit[];
};

type DayRes = {
  date: string;
  projectCount: number;
  messageCount: number;
  commitCount: number;
  projects: DayProject[];
  commitOnlyProjects: DayCommitOnlyProject[];
};

type SyncRes = {
  coverage: {
    totalRepos: number;
    scannedRepos: number;
    okCount: number;
    failedCount: number;
    neverScanned: number;
    lastScanAt: string | null;
    cutoffDay: string | null;
  };
  progress: {
    running: boolean;
    done: number;
    total: number;
    startedAt: string | null;
    finishedAt: string | null;
    lastStatus: string | null;
    errorSummary: string | null;
  };
};

/**
 * 五档色阶。阈值按 2026-07-28 实测分布切(1:10天 / 2-3:21天 / 4-5:24天 / 6-8:25天 / 9+:13天),
 * 五档基本均衡。原来拍脑袋的 1/2/3/4+ 是错的 —— 41% 的日子在 4 个项目以上,
 * 「4+」封顶会把 4 个和 15 个染成同色,恰好抹掉最想看的那一端。
 */
const LEVELS = [
  { min: 1, max: 1, cls: "!bg-sky-50 !text-sky-900" },
  { min: 2, max: 3, cls: "!bg-sky-100 !text-sky-900" },
  { min: 4, max: 5, cls: "!bg-sky-200 !text-sky-900" },
  { min: 6, max: 8, cls: "!bg-sky-400 !text-white" },
  { min: 9, max: Infinity, cls: "!bg-sky-600 !text-white" },
] as const;

const LEVEL_LABELS = ["1 个", "2-3", "4-5", "6-8", "9+"];

/** 'YYYY-MM-DD' → 本地 Date。绝不用 new Date(字符串)(那是 UTC 解析)。 */
function toLocalDate(day: string): Date {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(y, m - 1, d);
}

/** 本地 Date → 'YYYY-MM-DD'。 */
function toDayString(d: Date): string {
  const p = (n: number) => (n < 10 ? `0${n}` : String(n));
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function hhmm(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => (n < 10 ? `0${n}` : String(n));
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

function levelIndexFor(count: number): number {
  return LEVELS.findIndex((l) => count >= l.min && count <= l.max);
}

export function ProjectCalendar() {
  const qc = useQueryClient();
  const [month, setMonth] = useState(() => new Date());
  // 初值先留空,拿到 serverToday 之后再定 —— 不用浏览器的「今天」(设计 R8)。
  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  const [commitOnlyOpen, setCommitOnlyOpen] = useState(false);
  const [expandedCommits, setExpandedCommits] = useState<Record<string, boolean>>({});

  const monthQ = useQuery({
    queryKey: ["project-calendar-month", month.getFullYear(), month.getMonth() + 1],
    queryFn: () =>
      apiGet<MonthRes>(
        `/api/project-calendar/month?year=${month.getFullYear()}&month=${month.getMonth() + 1}`
      ),
  });

  const syncQ = useQuery({
    queryKey: ["project-calendar-sync"],
    queryFn: () => apiGet<SyncRes>("/api/project-calendar/sync-status"),
    // 同步进行中每 2 秒轮询;闲时不轮询。
    refetchInterval: (q) => (q.state.data?.progress.running ? 2000 : false),
  });

  const effectiveDay = selectedDay ?? monthQ.data?.serverToday ?? null;

  const dayQ = useQuery({
    queryKey: ["project-calendar-day", effectiveDay],
    queryFn: () =>
      apiGet<DayRes>(
        `/api/project-calendar/day?date=${encodeURIComponent(effectiveDay!)}`
      ),
    enabled: !!effectiveDay,
  });

  const syncMut = useMutation({
    mutationFn: () => apiPost<unknown>("/api/project-calendar/sync-commits", {}),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ["project-calendar-sync"] });
      void qc.invalidateQueries({ queryKey: ["project-calendar-month"] });
      void qc.invalidateQueries({ queryKey: ["project-calendar-day"] });
    },
  });

  // 五档 modifier 各自的日期数组 + commitOnly 小点的日期数组。
  const modifiers = useMemo(() => {
    const buckets: Date[][] = LEVELS.map(() => []);
    const commitOnly: Date[] = [];
    for (const d of monthQ.data?.days ?? []) {
      if (d.projectCount > 0) {
        const idx = levelIndexFor(d.projectCount);
        if (idx >= 0) buckets[idx].push(toLocalDate(d.day));
      } else if (d.commitOnlyProjectCount > 0) {
        // 无对话但有提交 —— 打点,不进色阶。
        commitOnly.push(toLocalDate(d.day));
      }
    }
    return {
      lv0: buckets[0],
      lv1: buckets[1],
      lv2: buckets[2],
      lv3: buckets[3],
      lv4: buckets[4],
      commitOnly,
    };
  }, [monthQ.data]);

  const coverage = syncQ.data?.coverage;
  const progress = syncQ.data?.progress;
  const syncing = progress?.running || syncMut.isPending;

  // 早于对话数据起始日的月份:格子会全灰,得说清楚为什么。
  const dataStartDay = monthQ.data?.dataStartDay ?? null;
  const viewingBeforeData =
    !!dataStartDay &&
    `${month.getFullYear()}-${String(month.getMonth() + 1).padStart(2, "0")}-31` <
      dataStartDay;

  // 提交数据晚于水位的日子,提交栏不可信。
  const commitsStale =
    !!coverage?.cutoffDay && !!effectiveDay && effectiveDay > coverage.cutoffDay;

  return (
    <div className="flex flex-col gap-4">
      <div className="shrink-0">
        <h1 className="text-xl font-semibold">项目活动日历</h1>
        <p className="text-sm text-[var(--muted)] mt-1">
          按<strong>本机本地日</strong>聚合。格子颜色 ={" "}
          <strong>当天活跃的项目数</strong>，判断依据是那天有没有 AI
          编码对话（claude / codex / opencode）归属于该项目。
        </p>
      </div>

      {/* 提交数据水位 —— 不用 MAX(提交时间) 冒充水位,那会对失败和从未扫描的仓库撒谎 */}
      {coverage && (
        <div
          className={`shrink-0 rounded border px-3 py-2 text-xs flex items-center justify-between gap-4 ${
            coverage.neverScanned > 0 || coverage.failedCount > 0
              ? "border-amber-300 bg-amber-50 text-amber-900"
              : "border-[var(--border)] bg-white text-[var(--muted)]"
          }`}
        >
          <span className="min-w-0 truncate">
            {coverage.lastScanAt ? (
              <>
                提交数据 · 上次扫描 {coverage.cutoffDay} · {coverage.totalRepos}{" "}
                个仓库：{coverage.okCount} 成功
                {coverage.failedCount > 0 && ` · ${coverage.failedCount} 失败`}
                {coverage.neverScanned > 0 &&
                  ` · ${coverage.neverScanned} 从未扫描`}
              </>
            ) : (
              <>提交数据从未同步过 —— 所有日期的提交栏都会显示「未同步」</>
            )}
            {progress?.errorSummary && (
              <span className="ml-2 opacity-70" title={progress.errorSummary}>
                （{progress.errorSummary}）
              </span>
            )}
          </span>
          <button
            type="button"
            className="shrink-0 rounded border border-current px-2 py-1 disabled:opacity-50"
            disabled={syncing}
            onClick={() => syncMut.mutate()}
          >
            {syncing
              ? `同步中 ${progress?.done ?? 0}/${progress?.total ?? 0}…`
              : "立即同步"}
          </button>
        </div>
      )}

      <div className="flex gap-6 items-start">
        {/* 左:日历。sticky 常驻 —— 右侧滚很长时它不跑掉。 */}
        <div className="shrink-0 sticky top-0 rounded border border-[var(--border)] bg-white p-4 shadow-sm">
          <DayPicker
            mode="single"
            month={month}
            onMonthChange={setMonth}
            selected={effectiveDay ? toLocalDate(effectiveDay) : undefined}
            onSelect={(d) => d && setSelectedDay(toDayString(d))}
            locale={zhCN}
            modifiers={modifiers}
            modifiersClassNames={{
              lv0: LEVELS[0].cls,
              lv1: LEVELS[1].cls,
              lv2: LEVELS[2].cls,
              lv3: LEVELS[3].cls,
              lv4: LEVELS[4].cls,
              commitOnly:
                "relative after:content-[''] after:absolute after:bottom-1 after:left-1/2 after:-translate-x-1/2 after:w-1 after:h-1 after:rounded-full after:bg-slate-400",
            }}
          />

          <div className="mt-3 flex items-center gap-1.5 text-[11px] text-[var(--muted)]">
            <span>项目数</span>
            {LEVELS.map((l, i) => (
              <span
                key={i}
                className={`px-1.5 py-0.5 rounded ${l.cls.replace(/!/g, "")}`}
                title={`${LEVEL_LABELS[i]} 个项目`}
              >
                {LEVEL_LABELS[i]}
              </span>
            ))}
          </div>
          <p className="mt-2 text-[11px] text-[var(--muted)]">
            格子下方小点 = 那天无对话、但有提交
          </p>

          {viewingBeforeData && dataStartDay && (
            <p className="mt-2 text-[11px] text-amber-700">
              对话数据从 {dataStartDay} 开始，此前只有提交记录。
            </p>
          )}
          {monthQ.isError && (
            <p className="mt-2 text-xs text-red-600">
              {String((monthQ.error as Error).message)}
            </p>
          )}
        </div>

        {/* 右:当日面板。随 main 滚,不自造滚动容器(见文件头)。 */}
        <div className="flex-1 min-w-0 flex flex-col gap-3">
          <DayHeader day={effectiveDay} data={dayQ.data} error={dayQ.error} />

          <div data-testid="project-calendar-cards" className="space-y-2">
            {dayQ.isLoading && (
              <p className="text-sm text-[var(--muted)]">加载中…</p>
            )}
            {dayQ.data?.projects.length === 0 && !dayQ.isLoading && (
              <p className="text-sm text-[var(--muted)]">
                这天没有 AI 对话记录。
              </p>
            )}

            {dayQ.data?.projects.map((p) => (
              <ProjectCard
                key={p.key}
                p={p}
                commitsStale={commitsStale}
                expanded={!!expandedCommits[p.key]}
                onToggle={() =>
                  setExpandedCommits((s) => ({ ...s, [p.key]: !s[p.key] }))
                }
              />
            ))}

            {!!dayQ.data?.commitOnlyProjects.length && (
              <div className="rounded border border-[var(--border)] bg-white">
                <button
                  type="button"
                  className="w-full text-left px-3 py-2 text-xs text-[var(--muted)]"
                  onClick={() => setCommitOnlyOpen((v) => !v)}
                >
                  {commitOnlyOpen ? "▾" : "▸"} 仅有提交、无对话（
                  {dayQ.data.commitOnlyProjects.length} 个项目）
                </button>
                {commitOnlyOpen && (
                  <div className="px-3 pb-3 space-y-2">
                    {dayQ.data.commitOnlyProjects.map((p) => (
                      <div key={p.key} className="text-xs min-w-0">
                        <div
                          className="font-medium truncate"
                          title={p.path ?? p.key}
                        >
                          {p.name}
                          {!p.path && (
                            <span className="ml-1 text-[var(--muted)]">
                              （非仓库）
                            </span>
                          )}
                        </div>
                        <div className="text-[var(--muted)]">
                          {p.commits.length} 个提交
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function DayHeader({
  day,
  data,
  error,
}: {
  day: string | null;
  data: DayRes | undefined;
  error: unknown;
}) {
  if (error) {
    return (
      <p className="shrink-0 text-sm text-red-600">
        {String((error as Error).message)}
      </p>
    );
  }
  return (
    <div className="shrink-0">
      <h2 className="text-base font-medium">{day ?? "选择日期"}</h2>
      {data && (
        <p className="text-sm text-[var(--muted)]">
          {data.projectCount} 个项目 · {data.messageCount} 条对话 ·{" "}
          {data.commitCount} 个提交
        </p>
      )}
    </div>
  );
}

const COMMIT_PREVIEW = 3;

function ProjectCard({
  p,
  commitsStale,
  expanded,
  onToggle,
}: {
  p: DayProject;
  commitsStale: boolean;
  expanded: boolean;
  onToggle: () => void;
}) {
  const shown = expanded ? p.commits : p.commits.slice(0, COMMIT_PREVIEW);
  const rest = p.commits.length - shown.length;

  return (
    <div className="rounded border border-[var(--border)] bg-white p-3 shadow-sm min-w-0">
      <div className="flex items-baseline justify-between gap-3 min-w-0">
        <span className="font-medium truncate" title={p.path ?? p.key}>
          {p.name}
          {!p.path && (
            <span className="ml-1 text-xs text-[var(--muted)]">（非仓库）</span>
          )}
        </span>
        <span className="shrink-0 text-xs text-[var(--muted)]">
          {p.messageCount} 条对话 ·{" "}
          {commitsStale ? "提交未同步" : `${p.commits.length} 个提交`}
        </span>
      </div>

      <div className="mt-1 text-xs text-[var(--muted)]">
        {hhmm(p.firstAtMs)} — {hhmm(p.lastAtMs)}
      </div>

      <div className="mt-1 flex flex-wrap gap-1">
        {p.bySource.map((s) => (
          <span
            key={s.source}
            className="rounded bg-slate-100 px-1.5 py-0.5 text-[11px]"
          >
            {s.source} {s.count}
          </span>
        ))}
      </div>

      {p.firstHumanText && (
        <p className="mt-1.5 text-xs text-[var(--muted)] truncate" title={p.firstHumanText}>
          「{p.firstHumanText}」
        </p>
      )}

      {!commitsStale && shown.length > 0 && (
        <ul className="mt-1.5 space-y-0.5">
          {shown.map((c) => (
            <li
              key={c.hash}
              className="text-xs truncate"
              title={c.subject || "(无主题)"}
            >
              ● {c.subject || "(无主题)"}
            </li>
          ))}
          {rest > 0 && (
            <li>
              <button
                type="button"
                className="text-xs text-sky-700"
                onClick={onToggle}
              >
                …还有 {rest} 个
              </button>
            </li>
          )}
          {expanded && p.commits.length > COMMIT_PREVIEW && (
            <li>
              <button
                type="button"
                className="text-xs text-sky-700"
                onClick={onToggle}
              >
                收起
              </button>
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
