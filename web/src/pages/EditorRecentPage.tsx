import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FormEvent, useState } from "react";
import { apiGet, apiPost } from "../api";

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

const PAGE_SIZE = 50;

export function EditorRecentPage({ config }: { config: EditorRecentConfig }) {
  const queryClient = useQueryClient();
  const [q, setQ] = useState("");
  const [submittedQ, setSubmittedQ] = useState("");
  const [scope, setScope] = useState<"all" | "local" | "remote">("all");
  const [includeMissing, setIncludeMissing] = useState(false);
  const [offset, setOffset] = useState(0);
  const [syncNotice, setSyncNotice] = useState<string | null>(null);

  const common = new URLSearchParams({
    app: config.app,
    limit: String(PAGE_SIZE),
    offset: String(offset),
    scope,
    includeMissing: includeMissing ? "1" : "0",
  });
  if (submittedQ) common.set("q", submittedQ);
  const commonQuery = common.toString();

  const statusKey = [config.queryKeyPrefix, "status"];
  const projectsKey = [config.queryKeyPrefix, "projects", submittedQ, scope, includeMissing, offset];
  const entriesKey = [config.queryKeyPrefix, "entries", submittedQ, scope, includeMissing, offset];

  const statusQ = useQuery({
    queryKey: statusKey,
    queryFn: () => apiGet<EditorStatus>(`/api/vscode/status?app=${config.app}`),
  });
  const projectsQ = useQuery({
    queryKey: projectsKey,
    queryFn: () => apiGet<PageRes<EditorProject>>(`/api/vscode/recent-projects?${commonQuery}`),
  });
  const entriesQ = useQuery({
    queryKey: entriesKey,
    queryFn: () => apiGet<PageRes<EditorEntry>>(`/api/vscode/recent?${commonQuery}`),
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
    setOffset(0);
    setSubmittedQ(q.trim());
  }

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-xl font-semibold">{config.title}</h1>
        <p className="text-sm text-[var(--muted)] mt-1">{config.description}</p>
      </header>

      <StatusPanel
        label={config.statusLabel}
        status={statusQ.data}
        isLoading={statusQ.isLoading}
        error={statusQ.error}
      />

      <div className="flex flex-wrap gap-3 items-center">
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
        {syncM.isError ? (
          <span className="text-sm text-red-700">{String((syncM.error as Error).message)}</span>
        ) : null}
        {syncNotice ? <span className="text-sm text-emerald-700">{syncNotice}</span> : null}
      </div>

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
              setOffset(0);
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
              setOffset(0);
              setIncludeMissing(e.target.checked);
            }}
          />
          显示已消失
        </label>
      </form>

      <ProjectsTable res={projectsQ.data} isLoading={projectsQ.isLoading} error={projectsQ.error} />
      <EntriesTable res={entriesQ.data} isLoading={entriesQ.isLoading} error={entriesQ.error} />

      <div className="flex gap-2">
        <button
          className="min-h-11 rounded border border-[var(--border)] px-4 py-2 text-sm disabled:opacity-50"
          disabled={offset === 0}
          onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
        >
          上一页
        </button>
        <button
          className="min-h-11 rounded border border-[var(--border)] px-4 py-2 text-sm disabled:opacity-50"
          disabled={!entriesQ.data || offset + PAGE_SIZE >= entriesQ.data.total}
          onClick={() => setOffset(offset + PAGE_SIZE)}
        >
          下一页
        </button>
      </div>
    </div>
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

function ProjectsTable({
  res,
  isLoading,
  error,
}: {
  res: PageRes<EditorProject> | undefined;
  isLoading: boolean;
  error: unknown;
}) {
  if (isLoading) return <p className="text-sm text-[var(--muted)]">加载项目…</p>;
  if (error) return <p className="text-sm text-red-700">{String((error as Error).message)}</p>;
  return (
    <section className="space-y-2">
      <h2 className="text-base font-semibold">最近项目</h2>
      <div className="overflow-x-auto rounded border border-[var(--border)] bg-white">
        <table className="min-w-full text-sm">
          <thead className="bg-slate-50 text-left text-[var(--muted)]">
            <tr>
              <th className="px-3 py-2">项目</th>
              <th className="px-3 py-2">来源</th>
              <th className="px-3 py-2">条目</th>
              <th className="px-3 py-2">路径</th>
            </tr>
          </thead>
          <tbody>
            {(res?.rows ?? []).map((row) => (
              <tr key={row.key} className="border-t border-[var(--border)]">
                <td className="px-3 py-2 font-medium">{row.label}</td>
                <td className="px-3 py-2 text-[var(--muted)]">
                  {row.repo ? "仓库" : row.remoteType ? `远程 ${row.remoteType}` : row.kind}
                </td>
                <td className="px-3 py-2">{row.entryCount}</td>
                <td className="px-3 py-2 text-[var(--muted)] break-all">
                  {row.path ?? row.remoteAuthorityHash ?? row.key}
                </td>
              </tr>
            ))}
            {res?.rows.length === 0 ? (
              <tr>
                <td className="px-3 py-4 text-[var(--muted)]" colSpan={4}>
                  没有匹配的项目
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function EntriesTable({
  res,
  isLoading,
  error,
}: {
  res: PageRes<EditorEntry> | undefined;
  isLoading: boolean;
  error: unknown;
}) {
  if (isLoading) return <p className="text-sm text-[var(--muted)]">加载原始条目…</p>;
  if (error) return <p className="text-sm text-red-700">{String((error as Error).message)}</p>;
  return (
    <section className="space-y-2">
      <h2 className="text-base font-semibold">原始条目</h2>
      <div className="overflow-x-auto rounded border border-[var(--border)] bg-white">
        <table className="min-w-full text-sm">
          <thead className="bg-slate-50 text-left text-[var(--muted)]">
            <tr>
              <th className="px-3 py-2">#</th>
              <th className="px-3 py-2">类型</th>
              <th className="px-3 py-2">名称</th>
              <th className="px-3 py-2">位置</th>
            </tr>
          </thead>
          <tbody>
            {(res?.rows ?? []).map((row) => (
              <tr key={row.id} className="border-t border-[var(--border)]">
                <td className="px-3 py-2 text-[var(--muted)]">{row.recent_index + 1}</td>
                <td className="px-3 py-2">{row.remote_type ?? row.kind}</td>
                <td className="px-3 py-2 font-medium">{row.label ?? "(未命名)"}</td>
                <td className="px-3 py-2 text-[var(--muted)] break-all">
                  {row.path ?? row.uri_redacted}
                </td>
              </tr>
            ))}
            {res?.rows.length === 0 ? (
              <tr>
                <td className="px-3 py-4 text-[var(--muted)]" colSpan={4}>
                  没有匹配的条目
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </section>
  );
}
