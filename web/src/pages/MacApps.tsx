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
    <div className="space-y-6">
      <header>
        <h1 className="text-xl font-semibold">Mac 应用</h1>
        <p className="text-sm text-[var(--muted)] mt-1">
          扫描本机 .app bundle，保存名称、版本、Bundle ID 和路径等元数据。
        </p>
      </header>

      <StatusPanel
        status={statusQ.data}
        isLoading={statusQ.isLoading}
        error={statusQ.error}
      />

      <div className="flex flex-wrap gap-3 items-center">
        <button
          type="button"
          onClick={() => syncM.mutate()}
          disabled={syncM.isPending || statusQ.data?.supported === false}
          className="rounded bg-[var(--accent)] text-white px-4 py-2 text-sm disabled:opacity-50"
        >
          {syncM.isPending ? "同步中…" : "立即同步"}
        </button>
        {syncM.isError ? (
          <span className="text-sm text-red-700">
            {String((syncM.error as Error).message)}
          </span>
        ) : null}
      </div>

      <form onSubmit={onSearch} className="flex flex-wrap gap-2 items-center">
        <input
          className="rounded border border-[var(--border)] px-3 py-2 text-sm min-w-[16rem]"
          placeholder="搜索名称、Bundle ID 或路径"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <button className="rounded border border-[var(--border)] px-3 py-2 text-sm">
          搜索
        </button>
        <label className="flex items-center gap-2 text-sm text-[var(--muted)]">
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
    <div className="rounded border border-[var(--border)] bg-white p-4 text-sm space-y-2">
      <div>
        当前平台：{status.platform} · 已记录 {status.counts.active} 个应用
        {status.counts.missing ? `，已移除 ${status.counts.missing} 个` : ""}
      </div>
      {status.defaultRoots.length ? (
        <div className="text-[var(--muted)] break-all">
          默认目录：{status.defaultRoots.join(" · ")}
        </div>
      ) : (
        <div className="text-amber-700">当前平台不支持 Mac 应用扫描。</div>
      )}
      <RunSummary run={status.lastRun} />
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
      <div className="text-sm text-[var(--muted)]">共 {res?.total ?? 0} 条</div>
      <div className="rounded border border-[var(--border)] bg-white divide-y divide-[var(--border)]">
        {rows.length === 0 ? (
          <div className="p-4 text-sm text-[var(--muted)]">暂无记录。</div>
        ) : (
          rows.map((app) => (
            <div key={app.id} className="p-3 text-sm">
              <div className="flex flex-wrap gap-2 items-baseline">
                <strong>{app.name}</strong>
                <span className="text-[var(--muted)]">
                  {app.short_version ?? app.version ?? ""}
                </span>
                {app.missing_since ? (
                  <span className="text-xs text-amber-700">已移除</span>
                ) : null}
              </div>
              <div className="text-xs text-[var(--muted)] break-all mt-1">
                {app.bundle_id ?? "无 Bundle ID"} · {app.path}
              </div>
            </div>
          ))
        )}
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
