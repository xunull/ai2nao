import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { createColumnHelper } from "@tanstack/react-table";
import { RefreshCw } from "lucide-react";
import { useSearchParams } from "react-router-dom";
import { apiGet } from "../api";
import { DataTable } from "../components/DataTable";
import { ProjectOpenActions } from "../components/ProjectOpenActions";
import { formatTokenCount } from "../util/formatDisplay";

type Row = {
  repo: string;
  tokens: number;
  added: number;
  deleted: number;
  net: number;
  commits: number;
  tokensPerLine: number | null;
  status: "ok" | "not_scanned";
};

type ProjectOutputResponse = {
  window: string;
  rows: Row[];
  unmatched: {
    nonPathIdentity: Array<{ key: string; tokens: number }>;
    noMatchingRepo: Array<{ key: string; tokens: number }>;
    gitNoToken: Array<{ repo: string; added: number; deleted: number; commits: number }>;
  };
};

const windowOptions = [
  { value: "1w", label: "最近 1 周" },
  { value: "2w", label: "最近 2 周" },
  { value: "1m", label: "最近 1 个月" },
  { value: "3m", label: "最近 3 个月" },
  { value: "6m", label: "最近 6 个月" },
];

function lastSegment(p: string): string {
  const parts = p.split("/").filter(Boolean);
  return parts[parts.length - 1] || p;
}

function fmtRatio(v: number | null): string {
  if (v == null) return "—";
  return v >= 100 ? Math.round(v).toLocaleString() : v.toFixed(1);
}

const col = createColumnHelper<Row>();

const columns = [
  col.accessor("repo", {
    header: "仓库",
    enableSorting: false,
    cell: (ctx) => {
      const row = ctx.row.original;
      return (
        <div>
          <div className="truncate font-medium text-neutral-950" title={row.repo}>
            {lastSegment(row.repo)}
          </div>
          {row.status === "not_scanned" && (
            <span className="text-[11px] text-amber-700">未同步 git 产出</span>
          )}
        </div>
      );
    },
  }),
  col.accessor("tokens", {
    header: "Token",
    meta: { align: "right" },
    cell: (ctx) => formatTokenCount(ctx.getValue()),
  }),
  col.accessor("added", {
    header: "新增行",
    meta: { align: "right" },
    cell: (ctx) => <span className="text-emerald-700">+{ctx.getValue().toLocaleString()}</span>,
  }),
  col.accessor("net", {
    header: "净变动",
    meta: { align: "right" },
    cell: (ctx) => ctx.getValue().toLocaleString(),
  }),
  col.accessor("commits", {
    header: "提交",
    meta: { align: "right" },
    cell: (ctx) => ctx.getValue(),
  }),
  col.accessor((r) => r.tokensPerLine ?? undefined, {
    id: "tokensPerLine",
    header: "Token / 行",
    meta: { align: "right", headerTitle: "粗略效率，不是价值：删代码/重构/硬 debug 会让它偏高" },
    // null/undefined ratios always sink, regardless of asc/desc.
    sortUndefined: "last",
    cell: (ctx) => <span className="font-medium">{fmtRatio(ctx.row.original.tokensPerLine)}</span>,
  }),
  col.display({
    id: "actions",
    meta: { align: "right" },
    cell: (ctx) => <ProjectOpenActions path={ctx.row.original.repo} />,
  }),
];

export function ProjectOutput() {
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const window = searchParams.get("window") ?? "1w";

  const query = useQuery({
    queryKey: ["project-output", window],
    queryFn: () => apiGet<ProjectOutputResponse>(`/api/project-output?window=${window}`),
  });

  const data = useMemo(() => query.data?.rows ?? [], [query.data]);

  function setWindow(value: string) {
    const next = new URLSearchParams(searchParams);
    next.set("window", value);
    setSearchParams(next, { replace: true });
  }

  const [showUnmatched, setShowUnmatched] = useState(false);
  const unmatchedCount = query.data
    ? query.data.unmatched.nonPathIdentity.length +
      query.data.unmatched.noMatchingRepo.length +
      query.data.unmatched.gitNoToken.length
    : 0;

  return (
    <div className="min-h-[70vh]">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-[var(--fg)]">产出效率</h1>
          <p className="mt-1 text-sm text-[var(--muted)]">
            按仓库把 AI token 消耗和 git 代码产出对起来。Token / 行 只是粗略效率，不代表价值。
          </p>
        </div>
        <div className="text-right text-xs text-[var(--muted)]">
          <div>本机只读 · 你的提交（--author）</div>
        </div>
      </header>

      <section className="mt-5 grid grid-cols-[200px_auto_minmax(0,1fr)] items-end gap-3 border-y border-[var(--border)] py-3">
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-[var(--muted)]">时间范围</span>
          <select
            value={window}
            onChange={(e) => setWindow(e.target.value)}
            className="h-10 w-full rounded-lg border border-neutral-200 bg-white px-3 text-sm"
          >
            {windowOptions.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </label>
        <button
          type="button"
          onClick={() => void queryClient.invalidateQueries({ queryKey: ["project-output"] })}
          className="inline-flex h-10 items-center gap-2 rounded-lg border border-neutral-200 bg-white px-3 text-sm font-medium text-neutral-800 shadow-sm transition hover:border-blue-200 hover:bg-slate-50"
        >
          <RefreshCw className="h-4 w-4" aria-hidden="true" />
          刷新
        </button>
        <div className="text-right text-sm text-[var(--muted)]">
          {query.data ? `${query.data.rows.length} 个仓库` : ""}
        </div>
      </section>

      {query.isError && (
        <div className="mt-5 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-900" role="alert">
          {(query.error as Error).message}
        </div>
      )}

      {query.isLoading && (
        <div className="mt-6 space-y-2">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="h-12 animate-pulse rounded-lg bg-neutral-100" />
          ))}
        </div>
      )}

      {query.data && data.length === 0 && (
        <div className="mt-8 rounded-lg border border-dashed border-neutral-300 bg-white/70 py-20 text-center text-sm text-[var(--muted)]">
          当前范围内没有可对齐 token 与 git 产出的仓库。先在 /scheduler 启用「Git 代码产出统计」任务并 Run now。
        </div>
      )}

      {query.data && data.length > 0 && (
        <div className="mt-6">
          <DataTable
            columns={columns}
            data={data}
            title="产出明细"
            clientSort
            defaultSorting={[{ id: "tokensPerLine", desc: true }]}
          />
        </div>
      )}

      {query.data && unmatchedCount > 0 && (
        <section className="mt-6">
          <button
            type="button"
            onClick={() => setShowUnmatched((v) => !v)}
            className="text-sm font-medium text-[var(--muted)] hover:text-neutral-900"
          >
            {showUnmatched ? "▾" : "▸"} 对不上的 {unmatchedCount} 项（token 无仓库 / 仓库无 token）
          </button>
          {showUnmatched && (
            <div className="mt-3 space-y-4 rounded-lg border border-neutral-200 bg-neutral-50/60 px-4 py-3 text-xs text-neutral-600">
              {query.data.unmatched.nonPathIdentity.length > 0 && (
                <div>
                  <div className="font-medium text-neutral-800">非路径标识（无法归到仓库）</div>
                  {query.data.unmatched.nonPathIdentity.map((u) => (
                    <div key={u.key} className="mt-1 flex justify-between gap-3 font-mono">
                      <span className="truncate" title={u.key}>{u.key}</span>
                      <span className="tabular-nums">{formatTokenCount(u.tokens)}</span>
                    </div>
                  ))}
                </div>
              )}
              {query.data.unmatched.noMatchingRepo.length > 0 && (
                <div>
                  <div className="font-medium text-neutral-800">有 token 但无匹配仓库</div>
                  {query.data.unmatched.noMatchingRepo.map((u) => (
                    <div key={u.key} className="mt-1 flex justify-between gap-3 font-mono">
                      <span className="truncate" title={u.key}>{u.key}</span>
                      <span className="tabular-nums">{formatTokenCount(u.tokens)}</span>
                    </div>
                  ))}
                </div>
              )}
              {query.data.unmatched.gitNoToken.length > 0 && (
                <div>
                  <div className="font-medium text-neutral-800">有 git 产出但无 token</div>
                  {query.data.unmatched.gitNoToken.map((u) => (
                    <div key={u.repo} className="mt-1 flex justify-between gap-3 font-mono">
                      <span className="truncate" title={u.repo}>{lastSegment(u.repo)}</span>
                      <span className="tabular-nums text-emerald-700">+{u.added.toLocaleString()}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </section>
      )}
    </div>
  );
}
