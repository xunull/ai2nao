import { keepPreviousData, useQuery } from "@tanstack/react-query";
import {
  createColumnHelper,
  flexRender,
  getCoreRowModel,
  useReactTable,
  type SortingState,
} from "@tanstack/react-table";
import { ArrowDown, ArrowUp, ChevronsUpDown, Search } from "lucide-react";
import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { apiGet } from "../api";
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

function parsePage(raw: string | null): number {
  const n = parseInt(raw ?? "1", 10);
  if (Number.isNaN(n) || n < 1) return 1;
  return n;
}

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
  const page = parsePage(searchParams.get("page"));
  const urlQ = searchParams.get("q") ?? "";
  const sortKey = searchParams.get("sort") ?? "";
  const sortDir = searchParams.get("dir") === "asc" ? "asc" : "desc";
  const includeMissing = searchParams.get("includeMissing") === "1";

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

  const sorting: SortingState = sortKey ? [{ id: sortKey, desc: sortDir === "desc" }] : [];
  const offset = (page - 1) * PAGE_SIZE;

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
    // Keep the current rows on screen while the next page/sort/search loads, so the
    // page does not flip to a full-page "加载中…" and flicker. Only the table swaps.
    placeholderData: keepPreviousData,
  });

  const totalPages = list.data ? Math.max(1, Math.ceil(list.data.total / PAGE_SIZE)) : 1;
  const displayPage = Math.min(Math.max(1, page), totalPages);

  function setPage(p: number) {
    const next = Math.max(1, Math.min(p, totalPages));
    const sp = new URLSearchParams(searchParams);
    if (next <= 1) sp.delete("page");
    else sp.set("page", String(next));
    setSearchParams(sp, { replace: true });
  }

  function onSortingChange(updater: SortingState | ((old: SortingState) => SortingState)) {
    const next = typeof updater === "function" ? updater(sorting) : updater;
    const s = next[0];
    const sp = new URLSearchParams(searchParams);
    if (s) {
      sp.set("sort", s.id);
      sp.set("dir", s.desc ? "desc" : "asc");
    } else {
      sp.delete("sort");
      sp.delete("dir");
    }
    sp.delete("page"); // re-sort returns to page 1
    setSearchParams(sp, { replace: true });
  }

  const table = useReactTable({
    data: list.data?.repos ?? [],
    columns,
    state: { sorting },
    onSortingChange,
    manualSorting: true,
    manualPagination: true,
    pageCount: totalPages,
    getCoreRowModel: getCoreRowModel(),
  });

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
  const showPager = !empty && totalPages > 1;

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
        <>
          <div
            aria-busy={list.isPlaceholderData}
            className={`overflow-x-auto rounded border border-[var(--border)] bg-white transition-opacity duration-150 ${
              list.isPlaceholderData ? "opacity-60" : "opacity-100"
            }`}
          >
            <div className="flex items-center justify-between border-b border-[var(--border)] px-3 py-2 text-sm">
              <h2 className="font-medium">仓库清单</h2>
              <span className="text-[var(--muted)]">
                共 {l.total} 条 · 每页 {PAGE_SIZE} 条
              </span>
            </div>
            <table className="min-w-full text-sm">
              <thead className="bg-neutral-50 text-left">
                {table.getHeaderGroups().map((hg) => (
                  <tr key={hg.id}>
                    {hg.headers.map((header) => {
                      const sorted = header.column.getIsSorted();
                      return (
                        <th key={header.id} className="px-3 py-2 font-medium">
                          <button
                            type="button"
                            onClick={header.column.getToggleSortingHandler()}
                            className="group inline-flex items-center gap-1 text-[var(--fg)] hover:text-[var(--accent)]"
                          >
                            {flexRender(header.column.columnDef.header, header.getContext())}
                            {sorted === "asc" ? (
                              <ArrowUp className="h-3.5 w-3.5 text-[var(--accent)]" />
                            ) : sorted === "desc" ? (
                              <ArrowDown className="h-3.5 w-3.5 text-[var(--accent)]" />
                            ) : (
                              <ChevronsUpDown className="h-3.5 w-3.5 text-[var(--muted)] opacity-0 group-hover:opacity-60" />
                            )}
                          </button>
                        </th>
                      );
                    })}
                  </tr>
                ))}
              </thead>
              <tbody>
                {table.getRowModel().rows.map((row) => (
                  <tr key={row.id} className="border-t border-[var(--border)]">
                    {row.getVisibleCells().map((cell) => (
                      <td key={cell.id} className="px-3 py-2 align-top">
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 text-sm text-[var(--muted)]">
            <span>{showPager ? `第 ${displayPage} / ${totalPages} 页` : "单页结果"}</span>
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
        </>
      )}
    </div>
  );
}
