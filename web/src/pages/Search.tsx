import { useQuery } from "@tanstack/react-query";
import { FormEvent, useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { apiGet } from "../api";
import { shortPath } from "../util/path";

type Hit = {
  repo_id: number;
  repo_path: string;
  rel_path: string;
  snippet: string;
};

type SearchRes = { hits: Hit[]; q: string; limit: number };

export function Search() {
  const [params, setParams] = useSearchParams();
  const qParam = params.get("q") ?? "";
  const [input, setInput] = useState(qParam);

  useEffect(() => {
    setInput(qParam);
  }, [qParam]);

  const q = useQuery({
    queryKey: ["search", qParam],
    queryFn: () =>
      apiGet<SearchRes>(
        `/api/search?q=${encodeURIComponent(qParam)}&limit=50`
      ),
    enabled: qParam.trim().length > 0,
  });

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    const t = input.trim();
    if (!t) return;
    setParams({ q: t });
  }

  return (
    <div className="space-y-6 max-w-3xl">
      <h1 className="text-xl font-semibold">搜索</h1>
      <form onSubmit={onSubmit} className="space-y-2">
        <input
          className="w-full rounded border border-[var(--border)] px-3 py-2 text-sm"
          placeholder="FTS5 查询…"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          aria-label="搜索全文"
        />
        <p className="text-xs text-[var(--muted)]">
          使用 SQLite FTS5 语法。{" "}
          <a
            className="text-[var(--accent)] hover:underline"
            href="https://www.sqlite.org/fts5.html"
            target="_blank"
            rel="noreferrer"
          >
            文档
          </a>
        </p>
        <button
          type="submit"
          className="rounded bg-[var(--accent)] text-white px-4 py-2 text-sm"
        >
          搜索
        </button>
      </form>

      {!qParam.trim() ? (
        <p className="text-[var(--muted)]">输入关键词后搜索。</p>
      ) : q.isLoading ? (
        <p className="text-[var(--muted)]">加载中…</p>
      ) : q.isError ? (
        <div className="rounded border border-red-200 bg-red-50 p-4 text-red-800">
          {String((q.error as Error).message)}
        </div>
      ) : (
        <ul className="space-y-4">
          {q.data!.hits.length === 0 ? (
            <p className="text-[var(--muted)]">无匹配结果。</p>
          ) : (
            q.data!.hits.map((h, i) => (
              <li
                key={`${h.repo_id}-${h.rel_path}-${i}`}
                className="rounded border border-[var(--border)] bg-white p-4"
              >
                <div className="text-sm font-medium">
                  <Link
                    className="text-[var(--accent)] hover:underline"
                    to={`/repos/${h.repo_id}/file?path=${encodeURIComponent(h.rel_path)}`}
                    title={h.repo_path}
                  >
                    {shortPath(h.repo_path)} — {h.rel_path}
                  </Link>
                </div>
                <pre className="mt-2 text-xs text-[var(--muted)] whitespace-pre-wrap font-mono">
                  {h.snippet}
                </pre>
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  );
}
