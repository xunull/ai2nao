import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
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
  page: number;
  limit: number;
};

function parsePage(raw: string | null): number {
  const n = parseInt(raw ?? "1", 10);
  if (Number.isNaN(n) || n < 1) return 1;
  return n;
}

export function Repos() {
  const [searchParams, setSearchParams] = useSearchParams();
  const page = parsePage(searchParams.get("page"));

  const status = useQuery({
    queryKey: ["status"],
    queryFn: () => apiGet<Status>("/api/status"),
  });
  const list = useQuery({
    queryKey: ["repos", page, PAGE_SIZE],
    queryFn: () =>
      apiGet<RepoList>(
        `/api/repos?page=${page}&limit=${PAGE_SIZE}`
      ),
  });

  const totalPages = list.data
    ? Math.max(1, Math.ceil(list.data.total / PAGE_SIZE))
    : 1;
  const displayPage = Math.min(Math.max(1, page), totalPages);

  useEffect(() => {
    if (!list.data) return;
    if (page !== displayPage) {
      const sp = new URLSearchParams(searchParams);
      if (displayPage <= 1) sp.delete("page");
      else sp.set("page", String(displayPage));
      setSearchParams(sp, { replace: true });
    }
  }, [list.data, page, displayPage, searchParams, setSearchParams]);

  function setPage(p: number) {
    const next = Math.max(1, Math.min(p, totalPages));
    const sp = new URLSearchParams(searchParams);
    if (next <= 1) sp.delete("page");
    else sp.set("page", String(next));
    setSearchParams(sp, { replace: true });
  }

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

      {empty ? (
        <div className="rounded border border-dashed border-[var(--border)] p-8 text-center space-y-2">
          <p className="text-[var(--muted)]">还没有索引任何仓库。</p>
          <p className="text-sm text-[var(--muted)]">
            在终端运行{" "}
            <code className="rounded bg-neutral-100 px-1 py-0.5">
              ai2nao scan --root &lt;目录&gt;
            </code>{" "}
            后刷新本页。
          </p>
        </div>
      ) : (
        <>
          <div className="overflow-x-auto rounded border border-[var(--border)] bg-white">
            <div className="flex items-center justify-between border-b border-[var(--border)] px-3 py-2 text-sm">
              <h2 className="font-medium">仓库清单</h2>
              <span className="text-[var(--muted)]">
                共 {l.total} 条 · 每页 {PAGE_SIZE} 条
              </span>
            </div>
            <table className="min-w-full text-sm">
              <thead className="bg-neutral-50 text-left">
                <tr>
                  <th className="px-3 py-2 font-medium">路径</th>
                  <th className="px-3 py-2 font-medium">origin</th>
                  <th className="px-3 py-2 font-medium">最后扫描</th>
                </tr>
              </thead>
              <tbody>
                {l.repos.map((r) => (
                  <tr key={r.id} className="border-t border-[var(--border)]">
                    <td className="px-3 py-2">
                      <Link
                        className="text-[var(--accent)] hover:underline"
                        to={`/repos/${r.id}`}
                        title={r.path_canonical}
                      >
                        {shortPath(r.path_canonical)}
                      </Link>
                    </td>
                    <td className="px-3 py-2 text-[var(--muted)] max-w-[240px] truncate">
                      {r.origin_url ?? "—"}
                    </td>
                    <td className="px-3 py-2 text-[var(--muted)] whitespace-nowrap">
                      {r.last_scanned_at ?? "—"}
                    </td>
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
