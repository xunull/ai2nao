import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createColumnHelper } from "@tanstack/react-table";
import { FormEvent, useState } from "react";
import { apiGet, apiPost } from "../api";
import { DataTable, useTableQueryState } from "../components/DataTable";
import { Page } from "../components/Page";

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

const PAGE_SIZE = 25;

const col = createColumnHelper<AppRow>();
const columns = [
  col.accessor("name", {
    id: "name",
    header: "应用",
    cell: (ctx) => (
      <div className="min-w-0">
        <div className="font-medium">{ctx.getValue()}</div>
        <div className="text-xs text-[var(--muted)]">
          {ctx.row.original.short_version ?? ctx.row.original.version ?? "无版本"}
        </div>
      </div>
    ),
  }),
  col.accessor((r) => r.bundle_id, {
    id: "bundle",
    header: "Bundle ID",
    cell: (ctx) => (
      <span className="block max-w-[16rem] truncate text-[var(--muted)]">
        {ctx.getValue() ?? "无 Bundle ID"}
      </span>
    ),
  }),
  col.accessor("path", {
    id: "path",
    header: "路径",
    cell: (ctx) => (
      <span
        className="block max-w-[36rem] truncate font-mono text-xs text-[var(--muted)]"
        title={ctx.getValue()}
      >
        {ctx.getValue()}
      </span>
    ),
  }),
  col.display({
    id: "status",
    header: "状态",
    enableSorting: false,
    cell: (ctx) =>
      ctx.row.original.missing_since ? (
        <span className="whitespace-nowrap text-amber-700">已移除</span>
      ) : (
        <span className="whitespace-nowrap text-emerald-700">存在</span>
      ),
  }),
];

export function MacApps() {
  const queryClient = useQueryClient();
  const [q, setQ] = useState("");
  const [submittedQ, setSubmittedQ] = useState("");
  const [includeMissing, setIncludeMissing] = useState(false);
  const { page, offset, sortKey, sortDir, sorting, setPage, onSortingChange } =
    useTableQueryState(PAGE_SIZE);

  const statusQ = useQuery({
    queryKey: ["apps-status"],
    queryFn: () => apiGet<AppsStatus>("/api/apps/status"),
  });
  const listQ = useQuery({
    queryKey: ["apps-list", submittedQ, includeMissing, page, sortKey, sortDir],
    queryFn: () =>
      apiGet<AppsRes>(
        `/api/apps?limit=${PAGE_SIZE}&offset=${offset}&includeMissing=${includeMissing ? "1" : "0"}` +
          (submittedQ ? `&q=${encodeURIComponent(submittedQ)}` : "") +
          (sortKey ? `&sort=${sortKey}&dir=${sortDir}` : "")
      ),
    placeholderData: keepPreviousData,
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
    setPage(1);
    setSubmittedQ(q.trim());
  }

  return (
    <Page
      title="Mac 应用"
      subtitle="扫描本机 .app bundle，检查名称、版本、Bundle ID 和路径。"
      actions={
        <button
          type="button"
          onClick={() => syncM.mutate()}
          disabled={syncM.isPending || statusQ.data?.supported === false}
          className="rounded bg-[var(--accent)] px-4 py-2 text-sm text-white disabled:opacity-50"
        >
          {syncM.isPending ? "同步中…" : "立即同步"}
        </button>
      }
      toolbar={
        <div className="space-y-3 pb-3">
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
                  setPage(1);
                  setIncludeMissing(e.target.checked);
                }}
              />
              显示已移除
            </label>
            <button className="h-9 rounded border border-[var(--border)] px-4 text-sm">
              搜索
            </button>
          </form>
        </div>
      }
    >
      {listQ.isError ? (
        <div className="rounded border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          {String((listQ.error as Error).message)}
        </div>
      ) : listQ.isLoading ? (
        <p className="text-sm text-[var(--muted)]">加载列表…</p>
      ) : (
        <DataTable
          columns={columns}
          data={listQ.data?.rows ?? []}
          total={listQ.data?.total ?? 0}
          page={page}
          pageSize={PAGE_SIZE}
          sorting={sorting}
          onSortingChange={onSortingChange}
          setPage={setPage}
          isPlaceholderData={listQ.isPlaceholderData}
          title="应用清单"
        />
      )}
    </Page>
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
