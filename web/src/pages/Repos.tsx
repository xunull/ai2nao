import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { apiGet } from "../api";
import { shortPath } from "../util/path";

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

export function Repos() {
  const status = useQuery({
    queryKey: ["status"],
    queryFn: () => apiGet<Status>("/api/status"),
  });
  const list = useQuery({
    queryKey: ["repos", 1],
    queryFn: () => apiGet<RepoList>("/api/repos?page=1&limit=100"),
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
  const empty = l.total === 0;

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold">仓库</h1>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div className="rounded border border-[var(--border)] bg-white p-4">
          <div className="text-2xl font-semibold">{s.repos}</div>
          <div className="text-sm text-[var(--muted)]">仓库</div>
        </div>
        <div className="rounded border border-[var(--border)] bg-white p-4">
          <div className="text-2xl font-semibold">{s.manifests}</div>
          <div className="text-sm text-[var(--muted)]">已索引文件</div>
        </div>
        <div className="rounded border border-[var(--border)] bg-white p-4">
          <div className="text-sm font-medium">
            {s.lastJob
              ? `#${s.lastJob.id} ${s.lastJob.kind} ${s.lastJob.status}`
              : "暂无任务"}
          </div>
          <div className="text-sm text-[var(--muted)]">最近任务</div>
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
        <div className="overflow-x-auto rounded border border-[var(--border)] bg-white">
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
      )}
    </div>
  );
}
