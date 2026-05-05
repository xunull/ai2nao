import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FormEvent, useState } from "react";
import { apiGet, apiPost } from "../api";

type SyncRun = {
  id: number;
  status: "running" | "success" | "partial" | "failed";
  started_at: string;
  finished_at: string | null;
  inserted: number;
  updated: number;
  marked_missing: number;
  warnings_count: number;
  error_summary: string | null;
};

type AppsStatus = {
  supported: boolean;
  platform: string;
  defaultRoots: string[];
  counts: { total: number; active: number; missing: number };
  lastRun: SyncRun | null;
};

type AppRow = {
  id: number;
  bundle_id: string | null;
  name: string;
  path: string;
  version: string | null;
  short_version: string | null;
  source_root: string;
  last_seen_at: string;
  missing_since: string | null;
};

type AppsRes = {
  rows: AppRow[];
  total: number;
  limit: number;
  offset: number;
};

const PAGE_SIZE = 50;

export function MacApps() {
  const queryClient = useQueryClient();
  const [q, setQ] = useState("");
  const [submittedQ, setSubmittedQ] = useState("");
  const [includeMissing, setIncludeMissing] = useState(false);
  const [offset, setOffset] = useState(0);

  const statusQ = useQuery({
    queryKey: ["apps-status"],
    queryFn: () => apiGet<AppsStatus>("/api/apps/status"),
  });
  const listQ = useQuery({
    queryKey: ["apps-list", submittedQ, includeMissing, offset],
    queryFn: () =>
      apiGet<AppsRes>(
        `/api/apps?limit=${PAGE_SIZE}&offset=${offset}&includeMissing=${includeMissing ? "1" : "0"}${
          submittedQ ? `&q=${encodeURIComponent(submittedQ)}` : ""
        }`
      ),
  });
  const syncM = useMutation({
    mutationFn: () => apiPost("/api/apps/sync", {}),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["apps-status"] });
      await queryClient.invalidateQueries({ queryKey: ["apps-list"] });
    },
  });

  function onSearch(e: FormEvent) {
    e.preventDefault();
    setOffset(0);
    setSubmittedQ(q.trim());
  }

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Mac 应用</h1>
          <p className="mt-1 text-sm text-[var(--muted)]">
            扫描本机 .app bundle，检查名称、版本、Bundle ID 和路径。
          </p>
        </div>
        <button
          type="button"
          onClick={() => syncM.mutate()}
          disabled={syncM.isPending || statusQ.data?.supported === false}
          className="rounded bg-[var(--accent)] px-4 py-2 text-sm text-white disabled:opacity-50"
        >
          {syncM.isPending ? "同步中…" : "立即同步"}
        </button>
      </header>

      <StatusPanel
        status={statusQ.data}
        isLoading={statusQ.isLoading}
        error={statusQ.error}
      />

      {syncM.isError ? (
        <div className="rounded border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          {String((syncM.error as Error).message)}
        </div>
      ) : null}

      <form
        onSubmit={onSearch}
        className="grid grid-cols-[minmax(16rem,1fr)_auto_auto] items-end gap-3 rounded border border-[var(--border)] bg-white px-4 py-3"
      >
        <label className="min-w-0 text-xs text-[var(--muted)]">
          搜索
          <input
            className="mt-1 h-9 w-full rounded border border-[var(--border)] px-3 text-sm text-[var(--fg)]"
            placeholder="名称、Bundle ID 或路径"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </label>
        <label className="flex h-9 items-center gap-2 text-sm text-[var(--muted)]">
          <input
            type="checkbox"
            checked={includeMissing}
            onChange={(e) => {
              setOffset(0);
              setIncludeMissing(e.target.checked);
            }}
          />
          显示已移除
        </label>
        <button className="h-9 rounded border border-[var(--border)] px-4 text-sm">
          搜索
        </button>
      </form>

      <InventoryList
        res={listQ.data}
        isLoading={listQ.isLoading}
        error={listQ.error}
        offset={offset}
        setOffset={setOffset}
      />
    </div>
  );
}

function StatusPanel({
  status,
  isLoading,
  error,
}: {
  status: AppsStatus | undefined;
  isLoading: boolean;
  error: unknown;
}) {
  if (isLoading) return <p className="text-sm text-[var(--muted)]">加载状态…</p>;
  if (error) return <p className="text-sm text-red-700">{String((error as Error).message)}</p>;
  if (!status) return null;
  return (
    <div className="rounded border border-[var(--border)] bg-white text-sm">
      <div className="grid grid-cols-[160px_160px_160px_minmax(0,1fr)] gap-px bg-[var(--border)]">
        <Metric label="平台" value={status.platform} />
        <Metric label="已记录" value={String(status.counts.active)} />
        <Metric label="已移除" value={String(status.counts.missing)} />
        <div className="min-w-0 bg-white px-4 py-3">
          <div className="text-xs text-[var(--muted)]">默认目录</div>
          <div className="mt-1 truncate">
            {status.defaultRoots.length
              ? status.defaultRoots.join(" · ")
              : "当前平台不支持 Mac 应用扫描"}
          </div>
        </div>
      </div>
      <div className="border-t border-[var(--border)] px-4 py-3">
        <RunSummary run={status.lastRun} />
      </div>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-white px-4 py-3">
      <div className="text-xs text-[var(--muted)]">{label}</div>
      <div className="mt-1 text-lg font-semibold">{value}</div>
    </div>
  );
}

function RunSummary({ run }: { run: SyncRun | null }) {
  if (!run) return <div className="text-[var(--muted)]">尚未同步。</div>;
  const color =
    run.status === "failed"
      ? "text-red-700"
      : run.status === "partial"
        ? "text-amber-700"
        : "text-[var(--muted)]";
  return (
    <div className={color}>
      最近同步：{run.status} · 新增 {run.inserted} · 更新 {run.updated} · 标记移除{" "}
      {run.marked_missing} · warning {run.warnings_count}
      {run.error_summary ? <div className="mt-1 whitespace-pre-wrap">{run.error_summary}</div> : null}
    </div>
  );
}

function InventoryList({
  res,
  isLoading,
  error,
  offset,
  setOffset,
}: {
  res: AppsRes | undefined;
  isLoading: boolean;
  error: unknown;
  offset: number;
  setOffset: (n: number) => void;
}) {
  if (isLoading) return <p className="text-sm text-[var(--muted)]">加载列表…</p>;
  if (error) return <p className="text-sm text-red-700">{String((error as Error).message)}</p>;
  const rows = res?.rows ?? [];
  return (
    <div className="space-y-3">
      <div className="overflow-x-auto rounded border border-[var(--border)] bg-white">
        <div className="flex items-center justify-between border-b border-[var(--border)] px-3 py-2 text-sm">
          <h2 className="font-medium">应用清单</h2>
          <span className="text-[var(--muted)]">共 {res?.total ?? 0} 条</span>
        </div>
        <table className="min-w-full text-sm">
          <thead className="bg-neutral-50 text-left">
            <tr>
              <th className="px-3 py-2 font-medium">应用</th>
              <th className="px-3 py-2 font-medium">Bundle ID</th>
              <th className="px-3 py-2 font-medium">路径</th>
              <th className="px-3 py-2 font-medium">状态</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td className="px-3 py-4 text-[var(--muted)]" colSpan={4}>
                  暂无记录。
                </td>
              </tr>
            ) : (
              rows.map((app) => (
                <tr key={app.id} className="border-t border-[var(--border)]">
                  <td className="px-3 py-2">
                    <div className="font-medium">{app.name}</div>
                    <div className="text-xs text-[var(--muted)]">
                      {app.short_version ?? app.version ?? "无版本"}
                    </div>
                  </td>
                  <td className="max-w-[16rem] truncate px-3 py-2 text-[var(--muted)]">
                    {app.bundle_id ?? "无 Bundle ID"}
                  </td>
                  <td className="max-w-[36rem] truncate px-3 py-2 font-mono text-xs text-[var(--muted)]" title={app.path}>
                    {app.path}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2">
                    {app.missing_since ? (
                      <span className="text-amber-700">已移除</span>
                    ) : (
                      <span className="text-emerald-700">存在</span>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      <Pager total={res?.total ?? 0} offset={offset} setOffset={setOffset} />
    </div>
  );
}

function Pager({
  total,
  offset,
  setOffset,
}: {
  total: number;
  offset: number;
  setOffset: (n: number) => void;
}) {
  return (
    <div className="flex gap-2">
      <button
        type="button"
        className="rounded border border-[var(--border)] px-3 py-1 text-sm disabled:opacity-50"
        disabled={offset <= 0}
        onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
      >
        上一页
      </button>
      <button
        type="button"
        className="rounded border border-[var(--border)] px-3 py-1 text-sm disabled:opacity-50"
        disabled={offset + PAGE_SIZE >= total}
        onClick={() => setOffset(offset + PAGE_SIZE)}
      >
        下一页
      </button>
    </div>
  );
}
