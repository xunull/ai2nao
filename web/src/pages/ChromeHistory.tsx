import { useQuery, useQueryClient } from "@tanstack/react-query";
import { format } from "date-fns";
import { zhCN } from "date-fns/locale";
import { useMemo, useState } from "react";
import { DayPicker } from "react-day-picker";
import "react-day-picker/style.css";
import { apiGet, apiPost } from "../api";
import { formatFileTimeMs } from "../util/formatDisplay";

type ChromeHistoryStatus = {
  supported: boolean;
  profile: string;
  defaultHistoryPath: string | null;
  platform: string;
};

type MonthRes = {
  year: number;
  month: number;
  profile: string;
  days: { day: string; count: number }[];
  timezone: string;
};

type DayEntry = {
  visit_id: number;
  url_id: number;
  url: string;
  title: string | null;
  visit_time: number;
  visit_time_unix_ms: number;
  transition: number | null;
  calendar_day: string;
  inserted_at: string;
};

type DayRes = {
  date: string;
  profile: string;
  entries: DayEntry[];
  timezone: string;
};

type SyncRes = {
  ok: boolean;
  profile: string;
  sourcePath: string;
  insertedUrls: number;
  insertedVisits: number;
  skippedVisits: number;
  errors: string[];
};

function enc(s: string): string {
  return encodeURIComponent(s);
}

export function ChromeHistory() {
  const queryClient = useQueryClient();
  const [profile, setProfile] = useState("Default");
  const [profileDraft, setProfileDraft] = useState("Default");
  const [month, setMonth] = useState(() => new Date());
  const [selected, setSelected] = useState<Date | undefined>(() => new Date());
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState<string | null>(null);

  const status = useQuery({
    queryKey: ["chrome-history-status", profile],
    queryFn: () =>
      apiGet<ChromeHistoryStatus>(
        `/api/chrome-history/status?profile=${enc(profile)}`
      ),
  });

  const y = month.getFullYear();
  const m = month.getMonth() + 1;

  const monthQ = useQuery({
    queryKey: ["chrome-history-month", profile, y, m],
    queryFn: () =>
      apiGet<MonthRes>(
        `/api/chrome-history/month?year=${y}&month=${m}&profile=${enc(profile)}`
      ),
  });

  const countByDay = useMemo(() => {
    const map = new Map<string, number>();
    for (const d of monthQ.data?.days ?? []) {
      map.set(d.day, d.count);
    }
    return map;
  }, [monthQ.data]);

  const datesWithVisits = useMemo(() => {
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
    queryKey: ["chrome-history-day", profile, selectedStr],
    queryFn: () =>
      apiGet<DayRes>(
        `/api/chrome-history/day?date=${enc(selectedStr)}&profile=${enc(profile)}`
      ),
    enabled: !!selectedStr,
  });

  function applyProfile() {
    const p = profileDraft.trim() || "Default";
    setProfile(p);
    setProfileDraft(p);
  }

  async function onSync() {
    setSyncing(true);
    setSyncMsg(null);
    try {
      const r = await apiPost<SyncRes>("/api/chrome-history/sync", {
        profile,
      });
      const errPart =
        r.errors.length > 0 ? ` 警告：${r.errors.join("；")}` : "";
      setSyncMsg(
        `同步完成：新增 ${r.insertedVisits} 条访问、${r.insertedUrls} 条 URL 行，跳过 ${r.skippedVisits} 条重复。${errPart}`
      );
      await queryClient.invalidateQueries({ queryKey: ["chrome-history-month"] });
      await queryClient.invalidateQueries({ queryKey: ["chrome-history-day"] });
    } catch (e) {
      setSyncMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setSyncing(false);
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
        <h1 className="text-xl font-semibold">Chrome 历史</h1>
        <p className="text-sm text-[var(--muted)] mt-2">
          从本机 Chrome{" "}
          <code className="rounded bg-neutral-100 px-1 text-xs">History</code>{" "}
          SQLite 增量镜像到索引库（仅插入、不删除）。与{" "}
          <code className="rounded bg-neutral-100 px-1 text-xs">
            npm run chrome-history:watch
          </code>{" "}
          使用同一套逻辑；下方「立即同步」相当于一次{" "}
          <code className="rounded bg-neutral-100 px-1 text-xs">
            ai2nao chrome-history sync
          </code>
          。
        </p>
        <div className="mt-3 flex flex-wrap gap-2 items-center text-sm">
          <label className="text-[var(--muted)]">Profile 目录名</label>
          <input
            className="rounded border border-[var(--border)] px-2 py-1 text-sm min-w-[8rem]"
            value={profileDraft}
            onChange={(e) => setProfileDraft(e.target.value)}
            aria-label="Chrome profile 文件夹名"
          />
          <button
            type="button"
            className="rounded border border-[var(--border)] px-3 py-1 text-sm"
            onClick={() => applyProfile()}
          >
            应用
          </button>
        </div>
        {status.data?.defaultHistoryPath ? (
          <p className="text-xs text-[var(--muted)] mt-2 break-all">
            默认 History 路径：{status.data.defaultHistoryPath}
          </p>
        ) : null}
        {unsupported ? (
          <p className="text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded p-3 mt-3">
            当前系统（{status.data.platform}
            ）未内置 Chrome History 默认路径。可在 API{" "}
            <code className="rounded bg-white px-1">
              POST /api/chrome-history/sync
            </code>{" "}
            中传入{" "}
            <code className="rounded bg-white px-1">
              {`{ "profile": "…", "historyPath": "/path/to/History" }`}
            </code>
            。
          </p>
        ) : null}
      </div>

      <div className="flex flex-wrap gap-3 items-center">
        <button
          type="button"
          className="rounded bg-[var(--accent)] text-white px-4 py-2 text-sm disabled:opacity-50"
          onClick={() => void onSync()}
          disabled={syncing || unsupported}
        >
          {syncing ? "同步中…" : "立即同步"}
        </button>
        {syncMsg ? (
          <span className="text-sm text-[var(--muted)]">{syncMsg}</span>
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
              hasVisits: datesWithVisits,
            }}
            modifiersClassNames={{
              hasVisits:
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
          <div className="rounded border border-[var(--border)] bg-white p-4 shadow-sm">
            <h2 className="text-base font-medium">
              {selectedStr ? selectedStr : "选择日期"}
            </h2>
            {selectedStr && !dayQ.isLoading && !dayQ.isError ? (
              <p className="text-sm text-[var(--muted)] mt-1">
                当日共 {dayQ.data?.entries.length ?? 0} 条
              </p>
            ) : null}
            {dayQ.isLoading ? (
              <p className="text-sm text-[var(--muted)] mt-2">加载…</p>
            ) : dayQ.isError ? (
              <p className="text-sm text-red-600 mt-2">
                {String((dayQ.error as Error).message)}
              </p>
            ) : (
              <ul className="mt-3 space-y-2 text-sm max-h-[28rem] overflow-y-auto">
                {(dayQ.data?.entries ?? []).length === 0 ? (
                  <li className="text-[var(--muted)]">
                    当日无记录（可先同步或确认 Profile 与 Chrome 是否写入该库）。
                  </li>
                ) : (
                  dayQ.data?.entries.map((e) => (
                    <li
                      key={e.visit_id}
                      className="border-b border-[var(--border)] pb-2 last:border-0"
                    >
                      <a
                        href={e.url}
                        target="_blank"
                        rel="noreferrer"
                        className="text-[var(--accent)] hover:underline break-all"
                      >
                        {e.title?.trim() ? e.title : e.url}
                      </a>
                      <div className="text-xs text-[var(--muted)] mt-1 font-mono break-all">
                        {e.url}
                      </div>
                      <div className="text-xs text-[var(--muted)] mt-1">
                        访问时间 {formatFileTimeMs(e.visit_time_unix_ms)}
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
