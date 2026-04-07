import { useQuery } from "@tanstack/react-query";
import { format } from "date-fns";
import { zhCN } from "date-fns/locale";
import { useMemo, useState } from "react";
import { DayPicker } from "react-day-picker";
import "react-day-picker/style.css";
import { apiGet, apiPost } from "../api";

type AtuinStatus = { enabled: false } | { enabled: true; path: string };

type MonthRes = {
  year: number;
  month: number;
  days: { day: string; count: number }[];
  timezone: string;
};

type Entry = {
  id: string;
  timestamp_ns: number;
  duration: number;
  exit: number;
  command: string;
  cwd: string;
  hostname: string;
  session: string;
};

type DayRes = {
  date: string;
  entries: Entry[];
  timezone: string;
};

type DailySummaryStatus = {
  enabled: boolean;
  modelConfigured: boolean;
  model: string | null;
  cacheDbPath: string | null;
};

type DailySummaryPayload = {
  summary: string;
  nextUp: string | null;
  workMode: "implementation" | "debugging" | "exploration" | null;
  fragmentation: { label: "focused" | "mixed" | "fragmented"; summary: string } | null;
  degraded: boolean;
  degradeReason: string | null;
  facts: {
    date: string;
    totalCommands: number;
    distinctCwds: number;
    repoMatches: number;
    outsideIndexedRepos: number;
    sparse: boolean;
    recap: string;
    topRepoLabel: string | null;
    nextUpHint: string | null;
    repoFacts: Array<{
      repoId: number | null;
      repoLabel: string;
      matched: boolean;
      commandCount: number;
      sampleCommands: string[];
      blurb: string | null;
    }>;
  };
  meta: {
    generatedAt: string;
    model: string | null;
    fromCache: boolean;
    usedLlm: boolean;
  };
};

function formatTime(ns: number): string {
  const ms = Math.floor(ns / 1_000_000);
  return new Date(ms).toLocaleString();
}

export function Atuin() {
  const status = useQuery({
    queryKey: ["atuin-status"],
    queryFn: () => apiGet<AtuinStatus>("/api/atuin/status"),
  });
  const summaryStatus = useQuery({
    queryKey: ["daily-summary-status"],
    queryFn: () => apiGet<DailySummaryStatus>("/api/daily-summary/status"),
  });

  const [month, setMonth] = useState(() => new Date());
  const [selected, setSelected] = useState<Date | undefined>(() => new Date());
  const [summariesByDate, setSummariesByDate] = useState<
    Record<string, DailySummaryPayload | undefined>
  >({});
  const [loadingByDate, setLoadingByDate] = useState<Record<string, boolean>>({});
  const [summaryErrorsByDate, setSummaryErrorsByDate] = useState<
    Record<string, string | undefined>
  >({});

  const y = month.getFullYear();
  const m = month.getMonth() + 1;

  const monthQ = useQuery({
    queryKey: ["atuin-month", y, m],
    queryFn: () => apiGet<MonthRes>(`/api/atuin/month?year=${y}&month=${m}`),
    enabled: status.data?.enabled === true,
  });

  const countByDay = useMemo(() => {
    const map = new Map<string, number>();
    for (const d of monthQ.data?.days ?? []) {
      map.set(d.day, d.count);
    }
    return map;
  }, [monthQ.data]);

  const datesWithHistory = useMemo(() => {
    const out: Date[] = [];
    for (const [day, c] of countByDay) {
      if (c <= 0) continue;
      const [yy, mm, dd] = day.split("-").map(Number);
      out.push(new Date(yy, mm - 1, dd));
    }
    return out;
  }, [countByDay]);

  const selectedStr = selected ? format(selected, "yyyy-MM-dd") : "";
  const summaryForSelected = selectedStr ? summariesByDate[selectedStr] : undefined;
  const summaryLoading = !!(selectedStr && loadingByDate[selectedStr]);
  const summaryError = selectedStr ? summaryErrorsByDate[selectedStr] : undefined;

  const dayQ = useQuery({
    queryKey: ["atuin-day", selectedStr],
    queryFn: () => apiGet<DayRes>(`/api/atuin/day?date=${encodeURIComponent(selectedStr)}`),
    enabled: !!selectedStr && status.data?.enabled === true,
  });
  async function triggerSummary(refresh: boolean) {
    if (!selectedStr) return;
    const date = selectedStr;
    setLoadingByDate((prev) => ({ ...prev, [date]: true }));
    setSummaryErrorsByDate((prev) => ({ ...prev, [date]: undefined }));
    try {
      const payload = await apiPost<DailySummaryPayload>("/api/daily-summary", {
        date,
        refresh,
      });
      setSummariesByDate((prev) => ({
        ...prev,
        [payload.facts.date]: payload,
      }));
    } catch (error) {
      setSummaryErrorsByDate((prev) => ({
        ...prev,
        [date]: error instanceof Error ? error.message : String(error),
      }));
    } finally {
      setLoadingByDate((prev) => ({ ...prev, [date]: false }));
    }
  }

  if (status.isLoading) {
    return <p className="text-[var(--muted)]">加载中…</p>;
  }
  if (status.isError) {
    return (
      <div className="rounded border border-red-200 bg-red-50 p-4 text-red-800">
        {String((status.error as Error).message)}
      </div>
    );
  }

  if (!status.data?.enabled) {
    return (
      <div className="space-y-3 max-w-xl">
        <h1 className="text-xl font-semibold">Atuin 历史</h1>
        <p className="text-[var(--muted)]">
          未连接 Atuin 的{" "}
          <code className="rounded bg-neutral-100 px-1">history.db</code>。
          请先安装{" "}
          <a
            className="text-[var(--accent)] hover:underline"
            href="https://github.com/atuinsh/atuin"
            target="_blank"
            rel="noreferrer"
          >
            Atuin
          </a>{" "}
          并产生历史记录，然后在启动服务时使用默认路径，或{" "}
          <code className="rounded bg-neutral-100 px-1">
            ai2nao serve --atuin-db /path/to/history.db
          </code>
          。
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-xl font-semibold">Atuin 历史</h1>
        <p className="text-xs text-[var(--muted)] mt-1 break-all" title={status.data.path}>
          {status.data.path}
        </p>
        <p className="text-sm text-[var(--muted)] mt-2">
          按<strong>本机本地日历日</strong>聚合；有记录的日期会在日历上高亮。点击日期查看当日命令。
        </p>
      </div>

      <div className="flex flex-col lg:flex-row gap-8 items-start">
        <div className="rounded border border-[var(--border)] bg-white p-4 shadow-sm">
          <DayPicker
            mode="single"
            month={month}
            onMonthChange={setMonth}
            selected={selected}
            onSelect={setSelected}
            locale={zhCN}
            modifiers={{
              hasHistory: datesWithHistory,
            }}
            modifiersClassNames={{
              hasHistory:
                "!bg-sky-100 !text-sky-900 font-medium ring-1 ring-sky-200",
            }}
          />
          {monthQ.isLoading ? (
            <p className="text-xs text-[var(--muted)] mt-2">加载月统计…</p>
          ) : monthQ.isError ? (
            <p className="text-xs text-red-600 mt-2">
              {String((monthQ.error as Error).message)}
            </p>
          ) : null}
        </div>

        <div className="flex-1 min-w-0 space-y-3 w-full">
          <div className="rounded border border-[var(--border)] bg-white p-4 shadow-sm space-y-3">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 className="text-base font-medium">每日摘要</h2>
                <p className="text-sm text-[var(--muted)] mt-1">
                  这是基于今天 shell 活动的推断层，不是审计日志。
                </p>
              </div>
              {summaryStatus.data?.enabled ? (
                <div className="flex gap-2">
                  <button
                    type="button"
                    className="rounded border border-[var(--border)] px-3 py-1.5 text-sm hover:bg-neutral-50 disabled:opacity-50"
                    onClick={() => void triggerSummary(false)}
                    disabled={!selectedStr || summaryLoading}
                  >
                    {summaryLoading ? "生成中…" : "生成摘要"}
                  </button>
                  <button
                    type="button"
                    className="rounded border border-[var(--border)] px-3 py-1.5 text-sm hover:bg-neutral-50 disabled:opacity-50"
                    onClick={() => void triggerSummary(true)}
                    disabled={!selectedStr || summaryLoading}
                  >
                    {summaryLoading ? "刷新中…" : "刷新摘要"}
                  </button>
                </div>
              ) : null}
            </div>
            {!summaryStatus.data?.enabled ? (
              <p className="text-sm text-[var(--muted)]">
                当前服务未启用每日摘要。启动时加上{" "}
                <code className="rounded bg-neutral-100 px-1">
                  ai2nao serve --daily-summary
                </code>
                。
              </p>
            ) : summaryError ? (
              <p className="text-sm text-red-600">{summaryError}</p>
            ) : summaryLoading && summaryForSelected ? (
              <p className="text-sm text-[var(--muted)]">正在刷新摘要…</p>
            ) : null}
            {summaryStatus.data?.enabled && !summaryStatus.data.modelConfigured ? (
              <p className="text-xs text-[var(--muted)]">
                本地 LLM 尚未配置，当前会退化为 factual recap。
              </p>
            ) : null}
            {summaryLoading && !summaryForSelected ? (
              <div className="space-y-3" aria-live="polite">
                <p className="text-sm text-[var(--muted)]">正在生成摘要…</p>
                <div className="space-y-2">
                  <div className="h-4 w-3/4 animate-pulse rounded bg-neutral-100" />
                  <div className="h-4 w-full animate-pulse rounded bg-neutral-100" />
                  <div className="h-4 w-5/6 animate-pulse rounded bg-neutral-100" />
                </div>
                <div className="rounded bg-neutral-50 p-3 text-xs text-[var(--muted)]">
                  正在整理今天的命令、目录归属和 repo 上下文。
                </div>
              </div>
            ) : summaryForSelected ? (
              <div className="space-y-3">
                <div className="space-y-1">
                  <p className="text-sm leading-6">{summaryForSelected.summary}</p>
                  <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-[var(--muted)]">
                    <span>
                      {summaryForSelected.meta.fromCache ? "缓存结果" : "新生成"}
                    </span>
                    <span>
                      {summaryForSelected.meta.usedLlm
                        ? `LLM: ${summaryForSelected.meta.model ?? "configured"}`
                        : "facts only"}
                    </span>
                    {summaryForSelected.degraded ? (
                      <span>degrade: {summaryForSelected.degradeReason}</span>
                    ) : null}
                  </div>
                </div>
                {summaryForSelected.nextUp ? (
                  <div>
                    <h3 className="text-sm font-medium">明日接力棒</h3>
                    <p className="text-sm text-[var(--muted)] mt-1">
                      {summaryForSelected.nextUp}
                    </p>
                  </div>
                ) : null}
                <div className="flex flex-wrap gap-2 text-xs">
                  {summaryForSelected.workMode ? (
                    <span className="rounded bg-neutral-100 px-2 py-1">
                      workMode: {summaryForSelected.workMode}
                    </span>
                  ) : null}
                  {summaryForSelected.fragmentation ? (
                    <span className="rounded bg-neutral-100 px-2 py-1">
                      fragmentation: {summaryForSelected.fragmentation.label}
                    </span>
                  ) : null}
                </div>
                {summaryForSelected.fragmentation ? (
                  <p className="text-xs text-[var(--muted)]">
                    {summaryForSelected.fragmentation.summary}
                  </p>
                ) : null}
                <div className="rounded bg-neutral-50 p-3 text-xs text-[var(--muted)] space-y-2">
                  <p>
                    {summaryForSelected.facts.totalCommands} 条命令，涉及{" "}
                    {summaryForSelected.facts.distinctCwds} 个目录，命中{" "}
                    {summaryForSelected.facts.repoFacts.length} 个主要工作区。
                  </p>
                  {summaryForSelected.facts.repoFacts.length > 0 ? (
                    <ul className="space-y-2">
                      {summaryForSelected.facts.repoFacts.map((repo) => (
                        <li key={`${summaryForSelected.facts.date}-${repo.repoLabel}`}>
                          <div className="font-medium text-[var(--fg)]">
                            {repo.repoLabel} · {repo.commandCount} 条命令
                          </div>
                          {repo.blurb ? <div>{repo.blurb}</div> : null}
                          {repo.sampleCommands.length > 0 ? (
                            <div className="font-mono break-all">
                              {repo.sampleCommands.join(" | ")}
                            </div>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              </div>
            ) : summaryStatus.data?.enabled ? (
              <p className="text-sm text-[var(--muted)]">
                {selectedStr
                  ? "选择一天后，显式点击“生成摘要”或“刷新摘要”。"
                  : "先选择日期，再生成摘要。"}
              </p>
            ) : null}
          </div>
          <h2 className="text-lg font-medium">
            {selectedStr ? `${selectedStr} 的命令` : "选择日期"}
          </h2>
          {dayQ.isLoading ? (
            <p className="text-[var(--muted)] text-sm">加载中…</p>
          ) : dayQ.isError ? (
            <p className="text-red-600 text-sm">
              {String((dayQ.error as Error).message)}
            </p>
          ) : dayQ.data && dayQ.data.entries.length === 0 ? (
            <p className="text-[var(--muted)] text-sm">该日无记录（或均为已删除项）。</p>
          ) : (
            <div className="overflow-x-auto rounded border border-[var(--border)] bg-white">
              <table className="min-w-full text-xs">
                <thead className="bg-neutral-50 text-left">
                  <tr>
                    <th className="px-2 py-2 font-medium whitespace-nowrap">时间</th>
                    <th className="px-2 py-2 font-medium">命令</th>
                    <th className="px-2 py-2 font-medium">目录</th>
                    <th className="px-2 py-2 font-medium">exit</th>
                  </tr>
                </thead>
                <tbody>
                  {(dayQ.data?.entries ?? []).map((e) => (
                    <tr
                      key={e.id}
                      className="border-t border-[var(--border)] align-top"
                    >
                      <td className="px-2 py-1.5 text-[var(--muted)] whitespace-nowrap">
                        {formatTime(e.timestamp_ns)}
                      </td>
                      <td className="px-2 py-1.5 font-mono break-all max-w-[420px]">
                        {e.command}
                      </td>
                      <td className="px-2 py-1.5 text-[var(--muted)] break-all max-w-[240px]">
                        {e.cwd}
                      </td>
                      <td className="px-2 py-1.5 text-[var(--muted)]">{e.exit}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
