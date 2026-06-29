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

type BrewStatus = {
  detected: boolean;
  brewPath: string | null;
  counts: { total: number; formulae: number; casks: number; missing: number };
  lastRun: SyncRun | null;
};

type BrewKind = "" | "formula" | "cask";

type BrewRow = {
  id: number;
  kind: "formula" | "cask";
  name: string;
  full_name: string | null;
  installed_version: string | null;
  current_version: string | null;
  desc: string | null;
  tap: string | null;
  installed_as_dependency: number | null;
  installed_on_request: number | null;
  missing_since: string | null;
};

type BrewRes = {
  rows: BrewRow[];
  total: number;
  limit: number;
  offset: number;
};

// Fallback before the table measures how many rows fit the viewport (see fillHeight).
const FALLBACK_PAGE_SIZE = 12;

function sourceLabel(pkg: BrewRow): string {
  if (pkg.installed_on_request === 1) return "手动安装";
  if (pkg.installed_as_dependency === 1) return "依赖";
  return "未标记";
}

const col = createColumnHelper<BrewRow>();
const columns = [
  col.accessor("name", {
    id: "name",
    header: "包",
    cell: (ctx) => (
      <div className="min-w-0">
        <div className="font-medium">{ctx.getValue()}</div>
        {ctx.row.original.desc ? (
          <div
            className="mt-1 max-w-[36rem] truncate text-xs text-[var(--muted)]"
            title={ctx.row.original.desc}
          >
            {ctx.row.original.desc}
          </div>
        ) : null}
      </div>
    ),
  }),
  col.accessor("kind", {
    id: "kind",
    header: "类型",
    cell: (ctx) => (
      <span className="rounded border border-[var(--border)] px-1.5 py-0.5 text-xs">
        {ctx.getValue()}
      </span>
    ),
  }),
  col.accessor((r) => r.installed_version, {
    id: "version",
    header: "版本",
    cell: (ctx) => (
      <span className="whitespace-nowrap text-[var(--muted)]">
        {ctx.getValue() ?? ctx.row.original.current_version ?? "无版本"}
      </span>
    ),
  }),
  col.accessor((r) => r.tap, {
    id: "tap",
    header: "Tap / 全名",
    cell: (ctx) => (
      <span
        className="block max-w-[24rem] truncate text-[var(--muted)]"
        title={ctx.row.original.full_name ?? ctx.row.original.name}
      >
        {ctx.getValue() ?? "无 tap"} · {ctx.row.original.full_name ?? ctx.row.original.name}
      </span>
    ),
  }),
  col.display({
    id: "source",
    header: "安装来源",
    enableSorting: false,
    cell: (ctx) => (
      <span className="whitespace-nowrap text-[var(--muted)]">{sourceLabel(ctx.row.original)}</span>
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

export function Homebrew() {
  const queryClient = useQueryClient();
  const [q, setQ] = useState("");
  const [submittedQ, setSubmittedQ] = useState("");
  const [kind, setKind] = useState<BrewKind>("");
  const [includeMissing, setIncludeMissing] = useState(false);
  const [autoRows, setAutoRows] = useState(0);
  const pageSize = autoRows || FALLBACK_PAGE_SIZE;
  const { page, offset, sortKey, sortDir, sorting, setPage, onSortingChange } =
    useTableQueryState(pageSize);

  const statusQ = useQuery({
    queryKey: ["brew-status"],
    queryFn: () => apiGet<BrewStatus>("/api/brew/status"),
  });
  const listQ = useQuery({
    queryKey: ["brew-list", submittedQ, kind, includeMissing, page, pageSize, sortKey, sortDir],
    queryFn: () =>
      apiGet<BrewRes>(
        `/api/brew/packages?limit=${pageSize}&offset=${offset}&includeMissing=${
          includeMissing ? "1" : "0"
        }${kind ? `&kind=${kind}` : ""}${submittedQ ? `&q=${encodeURIComponent(submittedQ)}` : ""}` +
          (sortKey ? `&sort=${sortKey}&dir=${sortDir}` : "")
      ),
    placeholderData: keepPreviousData,
  });
  const syncM = useMutation({
    mutationFn: () => apiPost("/api/brew/sync", {}),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["brew-status"] });
      await queryClient.invalidateQueries({ queryKey: ["brew-list"] });
    },
  });

  function onSearch(e: FormEvent) {
    e.preventDefault();
    setPage(1);
    setSubmittedQ(q.trim());
  }

  return (
    <Page
      fill
      title="Homebrew"
      subtitle="同步本机 formula 与 cask，检查版本、tap、安装来源和缺失状态。"
      actions={
        <button
          type="button"
          onClick={() => syncM.mutate()}
          disabled={syncM.isPending || statusQ.data?.detected === false}
          className="rounded bg-[var(--accent)] px-4 py-2 text-sm text-white disabled:opacity-50"
        >
          {syncM.isPending ? "同步中…" : "立即同步"}
        </button>
      }
      toolbar={
        <div className="space-y-3 pb-3">
          <StatusPanel status={statusQ.data} isLoading={statusQ.isLoading} error={statusQ.error} />

          {syncM.isError ? (
            <div className="rounded border border-red-200 bg-red-50 p-3 text-sm text-red-700">
              {String((syncM.error as Error).message)}
            </div>
          ) : null}

          <form
            onSubmit={onSearch}
            className="grid grid-cols-[minmax(16rem,1fr)_160px_auto_auto] items-end gap-3 rounded border border-[var(--border)] bg-white px-4 py-3"
          >
            <label className="min-w-0 text-xs text-[var(--muted)]">
              搜索
              <input
                className="mt-1 h-9 w-full rounded border border-[var(--border)] px-3 text-sm text-[var(--fg)]"
                placeholder="名称、描述或 tap"
                value={q}
                onChange={(e) => setQ(e.target.value)}
              />
            </label>
            <label className="text-xs text-[var(--muted)]">
              类型
              <select
                className="mt-1 h-9 w-full rounded border border-[var(--border)] px-3 text-sm text-[var(--fg)]"
                value={kind}
                onChange={(e) => {
                  setPage(1);
                  setKind(e.target.value as BrewKind);
                }}
              >
                <option value="">全部</option>
                <option value="formula">Formula</option>
                <option value="cask">Cask</option>
              </select>
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
          pageSize={pageSize}
          sorting={sorting}
          onSortingChange={onSortingChange}
          setPage={setPage}
          isPlaceholderData={listQ.isPlaceholderData}
          title="包清单"
          fillHeight
          onPageSizeChange={setAutoRows}
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
  status: BrewStatus | undefined;
  isLoading: boolean;
  error: unknown;
}) {
  if (isLoading) return <p className="text-sm text-[var(--muted)]">加载状态…</p>;
  if (error) return <p className="text-sm text-red-700">{String((error as Error).message)}</p>;
  if (!status) return null;
  return (
    <div className="rounded border border-[var(--border)] bg-white text-sm">
      <div className="grid grid-cols-[160px_160px_160px_160px_minmax(0,1fr)] gap-px bg-[var(--border)]">
        <Metric label="总数" value={String(status.counts.total)} />
        <Metric label="Formula" value={String(status.counts.formulae)} />
        <Metric label="Cask" value={String(status.counts.casks)} />
        <Metric label="已移除" value={String(status.counts.missing)} />
        <div className="min-w-0 bg-white px-4 py-3">
          <div className="text-xs text-[var(--muted)]">brew 路径</div>
          <div className="mt-1 truncate">
            {status.detected ? status.brewPath : "未检测到 Homebrew"}
          </div>
        </div>
      </div>
      {!status.detected ? (
        <div className="border-t border-[var(--border)] px-4 py-3 text-amber-700">
          CLI 可用 --brew 指定路径。
        </div>
      ) : null}
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
