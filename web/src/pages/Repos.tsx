import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { createColumnHelper } from "@tanstack/react-table";
import { Search } from "lucide-react";
import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { apiGet } from "../api";
import { DataTable, useTableQueryState } from "../components/DataTable";
import { shortPath } from "../util/path";

const PAGE_SIZE = 25;

type Status = {
  repos: number;
  manifests: number;
  lastJob: {
    id: number;
    kind: string;
    status: string;
    finished_at: string | null;
  } | null;
};

type RepoRow = {
  id: number;
  path_canonical: string;
  origin_url: string | null;
  last_scanned_at: string | null;
};

type RepoList = {
  repos: RepoRow[];
  total: number;
  limit: number;
  offset: number;
  q: string;
  sort: string | null;
  dir: string | null;
};

/** Debounce a fast-changing value (search input) before it drives the query/URL. */
function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delayMs);
    return () => window.clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

const col = createColumnHelper<RepoRow>();
const columns = [
  col.accessor("path_canonical", {
    id: "path",
    header: "路径",
    cell: (ctx) => (
      <Link
        className="text-[var(--accent)] hover:underline"
        to={`/repos/${ctx.row.original.id}`}
        title={ctx.getValue()}
      >
        {shortPath(ctx.getValue())}
      </Link>
    ),
  }),
  col.accessor((r) => r.origin_url, {
    id: "origin",
    header: "origin",
    cell: (ctx) => (
      <span className="block max-w-[260px] truncate text-[var(--muted)]">
        {ctx.getValue() ?? "—"}
      </span>
    ),
  }),
  col.accessor((r) => r.last_scanned_at, {
    id: "scanned",
    header: "最后扫描",
    cell: (ctx) => (
      <span className="whitespace-nowrap text-[var(--muted)]">{ctx.getValue() ?? "—"}</span>
    ),
  }),
];

export function Repos() {
  const [searchParams, setSearchParams] = useSearchParams();
  const urlQ = searchParams.get("q") ?? "";
  const includeMissing = searchParams.get("includeMissing") === "1";
  const { page, offset, sortKey, sortDir, sorting, setPage, onSortingChange } =
    useTableQueryState(PAGE_SIZE);

  // Search input is debounced before it touches the URL (and the query).
  const [qInput, setQInput] = useState(urlQ);
  const debouncedQ = useDebouncedValue(qInput, 250);
  useEffect(() => {
    if (debouncedQ === urlQ) return;
    const sp = new URLSearchParams(searchParams);
    if (debouncedQ) sp.set("q", debouncedQ);
    else sp.delete("q");
    sp.delete("page"); // a new search starts at page 1
    setSearchParams(sp, { replace: true });
  }, [debouncedQ]); // eslint-disable-line react-hooks/exhaustive-deps

  const status = useQuery({
    queryKey: ["status"],
    queryFn: () => apiGet<Status>("/api/status"),
  });
  const list = useQuery({
    queryKey: ["repos", page, urlQ, sortKey, sortDir, includeMissing],
    queryFn: () =>
      apiGet<RepoList>(
        `/api/repos?limit=${PAGE_SIZE}&offset=${offset}&q=${encodeURIComponent(urlQ)}` +
          (sortKey ? `&sort=${sortKey}&dir=${sortDir}` : "") +
          (includeMissing ? "&includeMissing=1" : "")
      ),
    placeholderData: keepPreviousData,
  });

  const totalPages = list.data ? Math.max(1, Math.ceil(list.data.total / PAGE_SIZE)) : 1;
  const displayPage = Math.min(Math.max(1, page), totalPages);

  if (status.isLoading || list.isLoading) {
    return <p className="text-[var(--muted)]">加载中…</p>;
  }
  if (status.isError) {
    return (
      <div className="rounded border border-red-200 bg-red-50 p-4 text-red-800">
        {String((status.error as Error).message)}
      </div>
    );
  }
  if (list.isError) {
    return (
      <div className="rounded border border-red-200 bg-red-50 p-4 text-red-800">
        {String((list.error as Error).message)}
      </div>
    );
  }

  const s = status.data!;
  const l = list.data!;
  const searching = urlQ.trim().length > 0;
  const empty = l.total === 0;

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">仓库</h1>
          <p className="mt-1 text-sm text-[var(--muted)]">
            本机代码仓库索引，查看路径、origin 和最近扫描时间。
          </p>
        </div>
        <div className="text-sm text-[var(--muted)]">
          {s.lastJob
            ? `最近任务 #${s.lastJob.id} · ${s.lastJob.kind} · ${s.lastJob.status}`
            : "暂无扫描任务"}
        </div>
      </header>

      <div className="grid grid-cols-[repeat(3,minmax(0,1fr))] gap-px overflow-hidden rounded border border-[var(--border)] bg-[var(--border)] text-sm">
        <div className="bg-white px-4 py-3">
          <div className="text-xs text-[var(--muted)]">仓库</div>
          <div className="mt-1 text-xl font-semibold">{s.repos}</div>
        </div>
        <div className="bg-white px-4 py-3">
          <div className="text-xs text-[var(--muted)]">已索引文件</div>
          <div className="mt-1 text-xl font-semibold">{s.manifests}</div>
        </div>
        <div className="bg-white px-4 py-3">
          <div className="text-xs text-[var(--muted)]">当前页</div>
          <div className="mt-1 text-xl font-semibold">
            {displayPage}
            <span className="text-sm font-normal text-[var(--muted)]"> / {totalPages}</span>
          </div>
        </div>
      </div>

      <div className="flex items-center gap-2">
        <div className="flex h-9 flex-1 items-center rounded-lg border border-[var(--border)] bg-white px-2.5 transition-colors focus-within:border-[var(--accent)] focus-within:ring-1 focus-within:ring-[var(--accent)]">
          <Search aria-hidden="true" className="mr-2 h-4 w-4 shrink-0 text-[var(--muted)]" />
          <label className="sr-only" htmlFor="repo-search">搜索仓库</label>
          <input
            id="repo-search"
            value={qInput}
            onChange={(e) => setQInput(e.target.value)}
            placeholder="按路径或 origin 搜索…"
            className="min-w-0 flex-1 bg-transparent text-sm text-[var(--fg)] outline-none placeholder:text-[var(--muted)]"
          />
          {qInput && (
            <button
              type="button"
              onClick={() => setQInput("")}
              className="ml-2 text-xs text-[var(--muted)] hover:text-[var(--fg)]"
            >
              清除
            </button>
          )}
        </div>
        <label className="flex shrink-0 cursor-pointer items-center gap-1.5 text-xs text-[var(--muted)]">
          <input
            type="checkbox"
            checked={includeMissing}
            onChange={(e) => {
              const sp = new URLSearchParams(searchParams);
              if (e.target.checked) sp.set("includeMissing", "1");
              else sp.delete("includeMissing");
              sp.delete("page");
              setSearchParams(sp, { replace: true });
            }}
            className="accent-[var(--accent)]"
          />
          含已删
        </label>
      </div>

      {empty ? (
        <div className="rounded border border-dashed border-[var(--border)] p-8 text-center space-y-2">
          {searching ? (
            <p className="text-[var(--muted)]">没有匹配「{urlQ}」的仓库。</p>
          ) : (
            <>
              <p className="text-[var(--muted)]">还没有索引任何仓库。</p>
              <p className="text-sm text-[var(--muted)]">
                在终端运行{" "}
                <code className="rounded bg-neutral-100 px-1 py-0.5">
                  ai2nao scan --root &lt;目录&gt;
                </code>{" "}
                后刷新本页。
              </p>
            </>
          )}
        </div>
      ) : (
        <DataTable
          columns={columns}
          data={l.repos}
          total={l.total}
          page={page}
          pageSize={PAGE_SIZE}
          sorting={sorting}
          onSortingChange={onSortingChange}
          setPage={setPage}
          isPlaceholderData={list.isPlaceholderData}
          title="仓库清单"
        />
      )}
    </div>
  );
}
