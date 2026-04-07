import { useQuery } from "@tanstack/react-query";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { apiGet } from "../api";
import { shortPath } from "../util/path";

type Repo = {
  id: number;
  path_canonical: string;
};

type Manifest = {
  rel_path: string;
  body: string;
};

type Payload = { repo: Repo; manifest: Manifest };

export function FileView() {
  const { id } = useParams();
  const [search] = useSearchParams();
  const relPath = search.get("path") ?? "";

  const q = useQuery({
    queryKey: ["manifest", id, relPath],
    queryFn: () =>
      apiGet<Payload>(
        `/api/repos/${id}/manifest?path=${encodeURIComponent(relPath)}`
      ),
    enabled: !!id && !!relPath,
  });

  if (!id || !relPath) {
    return <p className="text-[var(--muted)]">路径无效</p>;
  }
  if (q.isLoading) return <p className="text-[var(--muted)]">加载中…</p>;
  if (q.isError) {
    return (
      <div className="rounded border border-red-200 bg-red-50 p-4 text-red-800">
        {String((q.error as Error).message)}
      </div>
    );
  }
  const { repo, manifest } = q.data!;

  return (
    <div className="space-y-4">
      <div>
        <Link
          to={`/repos/${repo.id}`}
          className="text-sm text-[var(--accent)] hover:underline"
        >
          ← 返回仓库
        </Link>
      </div>
      <h1 className="text-lg font-semibold break-all">{manifest.rel_path}</h1>
      <p className="text-xs text-[var(--muted)]" title={repo.path_canonical}>
        {shortPath(repo.path_canonical)}
      </p>
      <pre className="rounded border border-[var(--border)] bg-white p-4 text-xs overflow-x-auto max-h-[70vh] overflow-y-auto font-mono whitespace-pre-wrap">
        {manifest.body}
      </pre>
    </div>
  );
}
