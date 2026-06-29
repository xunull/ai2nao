import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createColumnHelper } from "@tanstack/react-table";
import { FormEvent, useState } from "react";
import { apiGet, apiPost } from "../api";
import { DataTable, useTableQueryState } from "../components/DataTable";
import { Page } from "../components/Page";

type EditorApp = "code" | "cursor";

type EditorRecentConfig = {
  app: EditorApp;
  queryKeyPrefix: string;
  title: string;
  description: string;
  statusLabel: string;
  syncLabel: string;
  syncingLabel: string;
};

type EditorStatus = {
  app: string;
  supported: boolean;
  statePath: string | null;
  exists: boolean;
  counts: { total: number; active: number; missing: number; remote: number };
  lastSeenAt: string | null;
};

type EditorProject = {
  key: string;
  label: string;
  path: string | null;
  repo: { id: number; path_canonical: string; origin_url: string | null } | null;
  entryCount: number;
  latestRecentIndex: number;
  kind: string;
  remoteType: string | null;
  remoteAuthorityHash: string | null;
  missing: boolean;
};

type EditorEntry = {
  id: number;
  kind: string;
  recent_index: number;
  uri_redacted: string;
  path: string | null;
  label: string | null;
  remote_type: string | null;
  remote_authority_hash: string | null;
  exists_on_disk: number | null;
  missing_since: string | null;
};

type PageRes<T> = {
  rows: T[];
  total: number;
  limit: number;
  offset: number;
  warnings?: Array<{ code: string; message: string }>;
};

// Fallback per table before each measures how many rows fit its half of the viewport.
const FALLBACK_PAGE_SIZE = 6;

const projectCol = createColumnHelper<EditorProject>();
const projectColumns = [
  projectCol.accessor("label", {
    id: "label",
    header: "项目",
    enableSorting: false,
    cell: (ctx) => <span className="font-medium">{ctx.getValue()}</span>,
  }),
  projectCol.display({
    id: "source",
    header: "来源",
    enableSorting: false,
    cell: (ctx) => (
      <span className="text-[var(--muted)]">
        {ctx.row.original.repo
          ? "仓库"
          : ctx.row.original.remoteType
            ? `远程 ${ctx.row.original.remoteType}`
            : ctx.row.original.kind}
      </span>
    ),
  }),
  projectCol.accessor("entryCount", { id: "entryCount", header: "条目", enableSorting: false }),
  projectCol.display({
    id: "path",
    header: "路径",
    enableSorting: false,
    cell: (ctx) => (
      <span className="break-all text-[var(--muted)]">
        {ctx.row.original.path ?? ctx.row.original.remoteAuthorityHash ?? ctx.row.original.key}
      </span>
    ),
  }),
];

const entryCol = createColumnHelper<EditorEntry>();
const entryColumns = [
  entryCol.accessor((r) => r.recent_index, {
    id: "idx",
    header: "#",
    enableSorting: false,
    cell: (ctx) => <span className="text-[var(--muted)]">{ctx.getValue() + 1}</span>,
  }),
  entryCol.display({
    id: "type",
    header: "类型",
    enableSorting: false,
    cell: (ctx) => <span>{ctx.row.original.remote_type ?? ctx.row.original.kind}</span>,
  }),
  entryCol.accessor((r) => r.label, {
    id: "name",
    header: "名称",
    enableSorting: false,
    cell: (ctx) => <span className="font-medium">{ctx.getValue() ?? "(未命名)"}</span>,
  }),
  entryCol.display({
    id: "loc",
    header: "位置",
    enableSorting: false,
    cell: (ctx) => (
      <span className="break-all text-[var(--muted)]">
        {ctx.row.original.path ?? ctx.row.original.uri_redacted}
      </span>
    ),
  }),
];

export function EditorRecentPage({ config }: { config: EditorRecentConfig }) {
  const queryClient = useQueryClient();
  const [q, setQ] = useState("");
  const [submittedQ, setSubmittedQ] = useState("");
  const [scope, setScope] = useState<"all" | "local" | "remote">("all");
  const [includeMissing, setIncludeMissing] = useState(false);
  const [syncNotice, setSyncNotice] = useState<string | null>(null);
  const [projFit, setProjFit] = useState(0);
  const [entryFit, setEntryFit] = useState(0);
  // Two tables share one pager, so use the SMALLER fit — that way both fit their
  // half of the viewport without a scrollbar and paginate in lockstep.
  const pageSize = projFit && entryFit ? Math.min(projFit, entryFit) : FALLBACK_PAGE_SIZE;
  const { page, offset, setPage } = useTableQueryState(pageSize);

  const common = new URLSearchParams({
    app: config.app,
    limit: String(pageSize),
    offset: String(offset),
    scope,
    includeMissing: includeMissing ? "1" : "0",
  });
  if (submittedQ) common.set("q", submittedQ);
  const commonQuery = common.toString();

  const statusKey = [config.queryKeyPrefix, "status"];
  const projectsKey = [config.queryKeyPrefix, "projects", submittedQ, scope, includeMissing, page, pageSize];
  const entriesKey = [config.queryKeyPrefix, "entries", submittedQ, scope, includeMissing, page, pageSize];

  const statusQ = useQuery({
    queryKey: statusKey,
    queryFn: () => apiGet<EditorStatus>(`/api/vscode/status?app=${config.app}`),
  });
  const projectsQ = useQuery({
    queryKey: projectsKey,
    queryFn: () => apiGet<PageRes<EditorProject>>(`/api/vscode/recent-projects?${commonQuery}`),
    placeholderData: keepPreviousData,
  });
  const entriesQ = useQuery({
    queryKey: entriesKey,
    queryFn: () => apiGet<PageRes<EditorEntry>>(`/api/vscode/recent?${commonQuery}`),
    placeholderData: keepPreviousData,
  });
  const syncM = useMutation({
    mutationFn: () => apiPost("/api/vscode/sync", { app: config.app }),
    onMutate: () => {
      setSyncNotice(null);
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: [config.queryKeyPrefix] });
      setSyncNotice(`同步完成：${new Date().toLocaleTimeString()}`);
    },
  });

  function onSearch(e: FormEvent) {
    e.preventDefault();
    setPage(1);
    setSubmittedQ(q.trim());
  }

  const total = entriesQ.data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const displayPage = Math.min(Math.max(1, page), totalPages);
  const showPager = totalPages > 1;

  return (
    <Page
      fill
      title={config.title}
      subtitle={config.description}
      actions={
        <button
          type="button"
          onClick={() => {
            if (!syncM.isPending) syncM.mutate();
          }}
          disabled={syncM.isPending || statusQ.data?.supported === false}
          className="min-h-11 rounded bg-[var(--accent)] px-4 py-2 text-sm text-white disabled:opacity-50"
        >
          {syncM.isPending ? config.syncingLabel : config.syncLabel}
        </button>
      }
      toolbar={
        <div className="space-y-3 pb-3">
          {syncM.isError || syncNotice ? (
            <div className="text-sm">
              {syncM.isError ? (
                <span className="text-red-700">{String((syncM.error as Error).message)}</span>
              ) : null}
              {syncNotice ? <span className="text-emerald-700">{syncNotice}</span> : null}
            </div>
          ) : null}
          <StatusPanel
            label={config.statusLabel}
            status={statusQ.data}
            isLoading={statusQ.isLoading}
            error={statusQ.error}
          />
          <form onSubmit={onSearch} className="flex flex-wrap items-end gap-3">
            <label className="flex flex-col gap-1 text-xs text-[var(--muted)]">
              搜索范围
              <input
                className="min-h-11 min-w-[18rem] rounded border border-[var(--border)] px-3 py-2 text-sm text-[var(--fg)]"
                placeholder="项目、路径或远程类型"
                value={q}
                onChange={(e) => setQ(e.target.value)}
              />
            </label>
            <button className="min-h-11 rounded border border-[var(--border)] px-4 py-2 text-sm">
              搜索
            </button>
            <label className="flex flex-col gap-1 text-xs text-[var(--muted)]">
              类型
              <select
                className="min-h-11 rounded border border-[var(--border)] bg-white px-3 py-2 text-sm text-[var(--fg)]"
                value={scope}
                onChange={(e) => {
                  setPage(1);
                  setScope(e.target.value as "all" | "local" | "remote");
                }}
              >
                <option value="all">全部</option>
                <option value="local">本地</option>
                <option value="remote">远程</option>
              </select>
            </label>
            <label className="flex min-h-11 items-center gap-2 text-sm text-[var(--muted)]">
              <input
                type="checkbox"
                className="size-4"
                checked={includeMissing}
                onChange={(e) => {
                  setPage(1);
                  setIncludeMissing(e.target.checked);
                }}
              />
              显示已消失
            </label>
          </form>
        </div>
      }
    >
      <div className="flex min-h-0 flex-1 flex-col gap-4">
        <section className="flex min-h-0 flex-1 flex-col gap-2">
          <h2 className="shrink-0 text-base font-semibold">最近项目</h2>
          {projectsQ.isError ? (
            <p className="text-sm text-red-700">{String((projectsQ.error as Error).message)}</p>
          ) : projectsQ.isLoading ? (
            <p className="text-sm text-[var(--muted)]">加载项目…</p>
          ) : (
            <DataTable
              columns={projectColumns}
              data={projectsQ.data?.rows ?? []}
              total={projectsQ.data?.total ?? 0}
              page={page}
              pageSize={pageSize}
              sorting={[]}
              onSortingChange={() => {}}
              setPage={setPage}
              isPlaceholderData={projectsQ.isPlaceholderData}
              title="最近项目"
              emptyText="没有匹配的项目"
              hidePager
              fillHeight
              onPageSizeChange={setProjFit}
            />
          )}
        </section>

        <section className="flex min-h-0 flex-1 flex-col gap-2">
          <h2 className="shrink-0 text-base font-semibold">原始条目</h2>
          {entriesQ.isError ? (
            <p className="text-sm text-red-700">{String((entriesQ.error as Error).message)}</p>
          ) : entriesQ.isLoading ? (
            <p className="text-sm text-[var(--muted)]">加载原始条目…</p>
          ) : (
            <DataTable
              columns={entryColumns}
              data={entriesQ.data?.rows ?? []}
              total={entriesQ.data?.total ?? 0}
              page={page}
              pageSize={pageSize}
              sorting={[]}
              onSortingChange={() => {}}
              setPage={setPage}
              isPlaceholderData={entriesQ.isPlaceholderData}
              title="原始条目"
              emptyText="没有匹配的条目"
              hidePager
              fillHeight
              onPageSizeChange={setEntryFit}
            />
          )}
        </section>

        <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 text-sm text-[var(--muted)]">
          <span>{showPager ? `第 ${displayPage} / ${totalPages} 页` : `共 ${total} 条`}</span>
          {showPager ? (
            <div className="flex items-center gap-2">
              <button
                type="button"
                className="rounded border border-[var(--border)] bg-white px-3 py-1.5 text-[var(--fg)] hover:bg-neutral-50 disabled:opacity-40"
                disabled={displayPage <= 1}
                onClick={() => setPage(displayPage - 1)}
              >
                上一页
              </button>
              <button
                type="button"
                className="rounded border border-[var(--border)] bg-white px-3 py-1.5 text-[var(--fg)] hover:bg-neutral-50 disabled:opacity-40"
                disabled={displayPage >= totalPages}
                onClick={() => setPage(displayPage + 1)}
              >
                下一页
              </button>
            </div>
          ) : null}
        </div>
      </div>
    </Page>
  );
}

function StatusPanel({
  label,
  status,
  isLoading,
  error,
}: {
  label: string;
  status: EditorStatus | undefined;
  isLoading: boolean;
  error: unknown;
}) {
  if (isLoading) return <p className="text-sm text-[var(--muted)]">加载状态…</p>;
  if (error) return <p className="text-sm text-red-700">{String((error as Error).message)}</p>;
  if (!status) return null;
  return (
    <div className="rounded border border-[var(--border)] bg-white p-4 text-sm space-y-2">
      <div>
        {label}：{status.counts.active} 个活跃 · 远程 {status.counts.remote} · 已消失{" "}
        {status.counts.missing}
      </div>
      <div className="text-[var(--muted)] break-all">
        state.vscdb：{status.statePath ?? "当前平台未配置"} {status.exists ? "" : "（未找到）"}
      </div>
      <div className="text-[var(--muted)]">
        最近同步：{status.lastSeenAt ? new Date(status.lastSeenAt).toLocaleString() : "尚未同步"}
      </div>
    </div>
  );
}
