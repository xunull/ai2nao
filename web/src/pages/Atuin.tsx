import { useQuery } from "@tanstack/react-query";
import { format } from "date-fns";
import { zhCN } from "date-fns/locale";
import { useMemo, useState } from "react";
import { DayPicker } from "react-day-picker";
import "react-day-picker/style.css";
import { apiGet } from "../api";

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

function formatTime(ns: number): string {
  const ms = Math.floor(ns / 1_000_000);
  return new Date(ms).toLocaleString();
}

export function Atuin() {
  const status = useQuery({
    queryKey: ["atuin-status"],
    queryFn: () => apiGet<AtuinStatus>("/api/atuin/status"),
  });

  const [month, setMonth] = useState(() => new Date());
  const [selected, setSelected] = useState<Date | undefined>(() => new Date());

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

  const dayQ = useQuery({
    queryKey: ["atuin-day", selectedStr],
    queryFn: () => apiGet<DayRes>(`/api/atuin/day?date=${encodeURIComponent(selectedStr)}`),
    enabled: !!selectedStr && status.data?.enabled === true,
  });

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
