import { useQuery, useQueryClient } from "@tanstack/react-query";
import { format } from "date-fns";
import { zhCN } from "date-fns/locale";
import { useMemo, useState } from "react";
import { DayPicker } from "react-day-picker";
import "react-day-picker/style.css";
import { apiGet, apiPost } from "../api";
import { formatByteSize, formatFileTimeMs } from "../util/formatDisplay";

type DownloadsStatus = {
  supported: boolean;
  defaultRoots: string[];
  platform: string;
};

type MonthRes = {
  year: number;
  month: number;
  days: { day: string; count: number }[];
  timezone: string;
};

type DayRes = {
  date: string;
  entries: {
    id: number;
    root_path: string;
    rel_path: string;
    file_birthtime_ms: number;
    size_bytes: number | null;
    calendar_day: string;
  }[];
  timezone: string;
};

type ScanRes = {
  ok: boolean;
  inserted: number;
  skipped: number;
  roots: string[];
  errors: string[];
};

export function Downloads() {
  const queryClient = useQueryClient();
  const status = useQuery({
    queryKey: ["downloads-status"],
    queryFn: () => apiGet<DownloadsStatus>("/api/downloads/status"),
  });

  const [month, setMonth] = useState(() => new Date());
  const [selected, setSelected] = useState<Date | undefined>(() => new Date());
  const [scanning, setScanning] = useState(false);
  const [scanMsg, setScanMsg] = useState<string | null>(null);

  const y = month.getFullYear();
  const m = month.getMonth() + 1;

  const monthQ = useQuery({
    queryKey: ["downloads-month", y, m],
    queryFn: () =>
      apiGet<MonthRes>(`/api/downloads/month?year=${y}&month=${m}`),
  });

  const countByDay = useMemo(() => {
    const map = new Map<string, number>();
    for (const d of monthQ.data?.days ?? []) {
      map.set(d.day, d.count);
    }
    return map;
  }, [monthQ.data]);

  const datesWithFiles = useMemo(() => {
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
    queryKey: ["downloads-day", selectedStr],
    queryFn: () =>
      apiGet<DayRes>(
        `/api/downloads/day?date=${encodeURIComponent(selectedStr)}`
      ),
    enabled: !!selectedStr,
  });

  async function onScan() {
    setScanning(true);
    setScanMsg(null);
    try {
      const r = await apiPost<ScanRes>("/api/downloads/scan", {});
      setScanMsg(
        `扫描完成：新增 ${r.inserted} 条，跳过 ${r.skipped} 条（已索引）。`
      );
      await queryClient.invalidateQueries({ queryKey: ["downloads-month"] });
      await queryClient.invalidateQueries({ queryKey: ["downloads-day"] });
    } catch (e) {
      setScanMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setScanning(false);
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

  const unsupported = status.data && !status.data.supported;

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-xl font-semibold">下载目录</h1>
        <p className="text-sm text-[var(--muted)] mt-2">
          文件名可能敏感；此处按<strong>本机日历日</strong>聚合已记录的文件（仅索引元数据）。
          使用「立即扫描」与 CLI{" "}
          <code className="rounded bg-neutral-100 px-1 text-xs">
            ai2nao downloads scan
          </code>{" "}
          相同逻辑。
        </p>
        {status.data?.defaultRoots.length ? (
          <p className="text-xs text-[var(--muted)] mt-2 break-all">
            默认根目录：{status.data.defaultRoots.join(" · ")}
          </p>
        ) : null}
        {unsupported ? (
          <p className="text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded p-3 mt-3">
            当前系统（{status.data.platform}
            ）无内置 ~/Downloads 根路径。请使用{" "}
            <code className="rounded bg-white px-1">
              ai2nao downloads scan --root /path
            </code>{" "}
            ，或调用 API{" "}
            <code className="rounded bg-white px-1">
              POST /api/downloads/scan
            </code>{" "}
            并传入{" "}
            <code className="rounded bg-white px-1">
              {`{ "roots": ["/path"] }`}
            </code>
            。
          </p>
        ) : null}
      </div>

      <div className="flex flex-wrap gap-3 items-center">
        <button
          type="button"
          className="rounded bg-[var(--accent)] text-white px-4 py-2 text-sm disabled:opacity-50"
          onClick={() => void onScan()}
          disabled={scanning || unsupported}
        >
          {scanning ? "扫描中…" : "立即扫描"}
        </button>
        {scanMsg ? (
          <span className="text-sm text-[var(--muted)]">{scanMsg}</span>
        ) : null}
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
              hasFiles: datesWithFiles,
            }}
            modifiersClassNames={{
              hasFiles:
                "!bg-emerald-100 !text-emerald-900 font-medium ring-1 ring-emerald-200",
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
          <div className="rounded border border-[var(--border)] bg-white p-4 shadow-sm">
            <h2 className="text-base font-medium">
              {selectedStr ? selectedStr : "选择日期"}
            </h2>
            {dayQ.isLoading ? (
              <p className="text-sm text-[var(--muted)] mt-2">加载…</p>
            ) : dayQ.isError ? (
              <p className="text-sm text-red-600 mt-2">
                {String((dayQ.error as Error).message)}
              </p>
            ) : (
              <ul className="mt-3 space-y-2 text-sm max-h-[28rem] overflow-y-auto">
                {(dayQ.data?.entries ?? []).length === 0 ? (
                  <li className="text-[var(--muted)]">当日无记录（可先扫描）。</li>
                ) : (
                  dayQ.data?.entries.map((e) => (
                    <li
                      key={e.id}
                      className="border-b border-[var(--border)] pb-2 last:border-0"
                    >
                      <div className="font-mono text-xs break-all">
                        {e.rel_path}
                      </div>
                      <div className="text-xs text-[var(--muted)] mt-1">
                        大小 {formatByteSize(e.size_bytes)} · 时间{" "}
                        {formatFileTimeMs(e.file_birthtime_ms)}
                      </div>
                    </li>
                  ))
                )}
              </ul>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
