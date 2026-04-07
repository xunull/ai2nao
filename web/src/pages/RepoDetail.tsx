import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";
import { apiGet } from "../api";
import { shortPath } from "../util/path";

type Repo = {
  id: number;
  path_canonical: string;
  origin_url: string | null;
  last_scanned_at: string | null;
};

type Manifest = {
  id: number;
  rel_path: string;
  mtime_ms: number | null;
  size_bytes: number | null;
};

type Detail = { repo: Repo; manifests: Manifest[] };

export function RepoDetail() {
  const { id } = useParams();
  const q = useQuery({
    queryKey: ["repo", id],
    queryFn: () => apiGet<Detail>(`/api/repos/${id}`),
    enabled: !!id,
  });

  if (q.isLoading) return <p className="text-[var(--muted)]">加载中…</p>;
  if (q.isError) {
    return (
      <div className="rounded border border-red-200 bg-red-50 p-4 text-red-800">
        {String((q.error as Error).message)}
      </div>
    );
  }
  const { repo, manifests } = q.data!;

  return (
    <div className="space-y-4">
      <div>
        <Link to="/repos" className="text-sm text-[var(--accent)] hover:underline">
          ← 仓库列表
        </Link>
      </div>
      <h1 className="text-xl font-semibold" title={repo.path_canonical}>
        {shortPath(repo.path_canonical)}
      </h1>
      <p className="text-sm text-[var(--muted)] break-all">
        {repo.path_canonical}
      </p>
      <p className="text-sm">
        <span className="text-[var(--muted)]">origin:</span>{" "}
        {repo.origin_url ?? "—"}
      </p>
      <p className="text-sm text-[var(--muted)]">
        最后扫描: {repo.last_scanned_at ?? "—"}
      </p>

      <h2 className="text-lg font-medium pt-2">已索引文件</h2>
      {manifests.length === 0 ? (
        <p className="text-[var(--muted)]">暂无清单文件。</p>
      ) : (
        <div className="overflow-x-auto rounded border border-[var(--border)] bg-white">
          <table className="min-w-full text-sm">
            <thead className="bg-neutral-50 text-left">
              <tr>
                <th className="px-3 py-2 font-medium">文件</th>
                <th className="px-3 py-2 font-medium">大小</th>
                <th className="px-3 py-2 font-medium">mtime</th>
              </tr>
            </thead>
            <tbody>
              {manifests.map((m) => (
                <tr key={m.id} className="border-t border-[var(--border)]">
                  <td className="px-3 py-2">
                    <Link
                      className="text-[var(--accent)] hover:underline"
                      to={`/repos/${repo.id}/file?path=${encodeURIComponent(m.rel_path)}`}
                    >
                      {m.rel_path}
                    </Link>
                  </td>
                  <td className="px-3 py-2 text-[var(--muted)]">
                    {m.size_bytes ?? "—"}
                  </td>
                  <td className="px-3 py-2 text-[var(--muted)] whitespace-nowrap">
                    {m.mtime_ms != null
                      ? new Date(m.mtime_ms).toISOString()
                      : "—"}
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
