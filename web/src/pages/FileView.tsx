import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { apiGet } from "../api";
import { JsonHighlighted } from "../components/JsonHighlighted";
import { tryPrettyJson } from "../util/jsonFormat";
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

const preBoxClass =
  "rounded border border-[var(--border)] bg-white p-4 text-xs overflow-x-auto max-h-[70vh] overflow-y-auto font-mono whitespace-pre-wrap";

export function FileView() {
  const { id } = useParams();
  const [search] = useSearchParams();
  const relPath = search.get("path") ?? "";
  const [jsonMode, setJsonMode] = useState<"pretty" | "raw">("pretty");

  const q = useQuery({
    queryKey: ["manifest", id, relPath],
    queryFn: () =>
      apiGet<Payload>(
        `/api/repos/${id}/manifest?path=${encodeURIComponent(relPath)}`
      ),
    enabled: !!id && !!relPath,
  });

  const pretty = useMemo(() => {
    if (!q.data) return null;
    return tryPrettyJson(q.data.manifest.body);
  }, [q.data]);

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
  const displayBody =
    pretty && jsonMode === "pretty" ? pretty : manifest.body;
  const isJson = pretty !== null;

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
      {isJson ? (
        <div className="flex gap-2 text-sm">
          <button
            type="button"
            className={`rounded px-3 py-1.5 border ${
              jsonMode === "pretty"
                ? "border-[var(--accent)] bg-blue-50 text-[var(--accent)]"
                : "border-[var(--border)] bg-white text-[var(--muted)]"
            }`}
            onClick={() => setJsonMode("pretty")}
          >
            格式化 JSON
          </button>
          <button
            type="button"
            className={`rounded px-3 py-1.5 border ${
              jsonMode === "raw"
                ? "border-[var(--accent)] bg-blue-50 text-[var(--accent)]"
                : "border-[var(--border)] bg-white text-[var(--muted)]"
            }`}
            onClick={() => setJsonMode("raw")}
          >
            原始文本
          </button>
        </div>
      ) : null}
      {isJson ? (
        <JsonHighlighted code={displayBody} className={preBoxClass} />
      ) : (
        <pre className={preBoxClass}>{displayBody}</pre>
      )}
    </div>
  );
}
