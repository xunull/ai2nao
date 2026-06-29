import {
  flexRender,
  getCoreRowModel,
  useReactTable,
  type ColumnDef,
  type SortingState,
} from "@tanstack/react-table";
import { ArrowDown, ArrowUp, ChevronsUpDown } from "lucide-react";
import { useSearchParams } from "react-router-dom";

export type TableQueryState = {
  page: number;
  offset: number;
  sortKey: string;
  sortDir: "asc" | "desc";
  sorting: SortingState;
  setPage: (p: number) => void;
  onSortingChange: (
    updater: SortingState | ((old: SortingState) => SortingState)
  ) => void;
};

function parsePage(raw: string | null): number {
  const n = parseInt(raw ?? "1", 10);
  return Number.isNaN(n) || n < 1 ? 1 : n;
}

/**
 * Server-side table state (page / sort / dir) backed by the URL query string, so
 * pagination and sort survive refresh and are shareable. The page owns data
 * fetching and passes the derived `offset`/`sortKey`/`sortDir` into its own query.
 * `?page=` is 1-based; sort lives in `?sort=&dir=`. Re-sorting returns to page 1.
 */
export function useTableQueryState(pageSize: number): TableQueryState {
  const [searchParams, setSearchParams] = useSearchParams();
  const page = parsePage(searchParams.get("page"));
  const sortKey = searchParams.get("sort") ?? "";
  const sortDir = searchParams.get("dir") === "asc" ? "asc" : "desc";
  const sorting: SortingState = sortKey ? [{ id: sortKey, desc: sortDir === "desc" }] : [];
  const offset = (page - 1) * pageSize;

  function setPage(p: number) {
    const sp = new URLSearchParams(searchParams);
    if (p <= 1) sp.delete("page");
    else sp.set("page", String(p));
    setSearchParams(sp, { replace: true });
  }

  function onSortingChange(
    updater: SortingState | ((old: SortingState) => SortingState)
  ) {
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
    sp.delete("page"); // a re-sort starts back at page 1
    setSearchParams(sp, { replace: true });
  }

  return { page, offset, sortKey, sortDir, sorting, setPage, onSortingChange };
}

type DataTableProps<T> = {
  columns: ColumnDef<T, any>[];
  data: T[];
  total: number;
  page: number;
  pageSize: number;
  sorting: SortingState;
  onSortingChange: TableQueryState["onSortingChange"];
  setPage: (p: number) => void;
  /**
   * react-query's `isPlaceholderData`: dims the table while the next page/sort
   * loads instead of unmounting it, so the page height never collapses and the
   * scroll position (and the pager) stay put.
   */
  isPlaceholderData?: boolean;
  title: string;
  emptyText?: string;
};

/**
 * Shared server-driven table for the inventory/list pages: sortable headers,
 * URL-backed pagination, no scroll-jump on page change. Columns opt out of
 * sorting with `enableSorting: false`. Pair with {@link useTableQueryState} and a
 * react-query call using `placeholderData: keepPreviousData`.
 */
export function DataTable<T>({
  columns,
  data,
  total,
  page,
  pageSize,
  sorting,
  onSortingChange,
  setPage,
  isPlaceholderData = false,
  title,
  emptyText = "暂无记录。",
}: DataTableProps<T>) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const displayPage = Math.min(Math.max(1, page), totalPages);
  const showPager = total > 0 && totalPages > 1;
  const table = useReactTable({
    data,
    columns,
    state: { sorting },
    onSortingChange,
    manualSorting: true,
    manualPagination: true,
    pageCount: totalPages,
    getCoreRowModel: getCoreRowModel(),
  });

  return (
    <div className="space-y-3">
      <div
        aria-busy={isPlaceholderData}
        className={`overflow-x-auto rounded border border-[var(--border)] bg-white transition-opacity duration-150 ${
          isPlaceholderData ? "opacity-60" : "opacity-100"
        }`}
      >
        <div className="flex items-center justify-between border-b border-[var(--border)] px-3 py-2 text-sm">
          <h2 className="font-medium">{title}</h2>
          <span className="text-[var(--muted)]">
            共 {total} 条 · 每页 {pageSize} 条
          </span>
        </div>
        <table className="min-w-full text-sm">
          <thead className="bg-neutral-50 text-left">
            {table.getHeaderGroups().map((hg) => (
              <tr key={hg.id}>
                {hg.headers.map((header) => {
                  const label = flexRender(
                    header.column.columnDef.header,
                    header.getContext()
                  );
                  if (!header.column.getCanSort()) {
                    return (
                      <th key={header.id} className="px-3 py-2 font-medium">
                        {label}
                      </th>
                    );
                  }
                  const sorted = header.column.getIsSorted();
                  return (
                    <th key={header.id} className="px-3 py-2 font-medium">
                      <button
                        type="button"
                        onClick={header.column.getToggleSortingHandler()}
                        className="group inline-flex items-center gap-1 text-[var(--fg)] hover:text-[var(--accent)]"
                      >
                        {label}
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
            {table.getRowModel().rows.length === 0 ? (
              <tr>
                <td className="px-3 py-4 text-[var(--muted)]" colSpan={columns.length}>
                  {emptyText}
                </td>
              </tr>
            ) : (
              table.getRowModel().rows.map((row) => (
                <tr key={row.id} className="border-t border-[var(--border)]">
                  {row.getVisibleCells().map((cell) => (
                    <td key={cell.id} className="px-3 py-2 align-top">
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3 text-sm text-[var(--muted)]">
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
  );
}
