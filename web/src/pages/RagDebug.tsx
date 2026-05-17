import { FormEvent, useEffect, useState } from "react";
import { apiGet, apiPost } from "../api";
import type { RagEvidenceHit, RagStatus } from "../aiChat/types";

type RagDebugResponse = {
  ok: true;
  query: string;
  fts: RagEvidenceHit[];
  vector: RagEvidenceHit[];
  hybrid: RagEvidenceHit[];
  meta: {
    vectorProvider: "none" | "lancedb";
    vectorAvailable: boolean;
    vectorStaleReason?: string;
    queryEmbeddingDim?: number;
    errors: { branch: "fts" | "vector"; message: string }[];
  };
};

export function RagDebug() {
  const [query, setQuery] = useState("");
  const [topK, setTopK] = useState(8);
  const [status, setStatus] = useState<RagStatus | null>(null);
  const [result, setResult] = useState<RagDebugResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const ac = new AbortController();
    apiGet<RagStatus>("/api/rag/status", { signal: ac.signal })
      .then(setStatus)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
    return () => ac.abort();
  }, []);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const q = query.trim();
    if (!q) return;
    setLoading(true);
    setError(null);
    try {
      const next = await apiPost<RagDebugResponse>("/api/rag/debug-search", {
        query: q,
        topK,
      });
      setResult(next);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-4">
      <header className="flex items-start justify-between gap-6">
        <div>
          <h1 className="text-2xl font-semibold text-[var(--fg)]">RAG 调试</h1>
        </div>
        <div className="grid min-w-[520px] grid-cols-4 gap-2 text-xs">
          <Metric label="Chunks" value={status ? String(status.chunkCount) : "-"} />
          <Metric label="Vector" value={status?.vectorStore.provider ?? "-"} />
          <Metric label="Indexed" value={String(status?.vectorStore.indexedCount ?? "-")} />
          <Metric label="Sync" value={status?.vectorStore.syncStatus ?? "-"} />
        </div>
      </header>

      <form onSubmit={onSubmit} className="flex items-center gap-3 rounded border border-[var(--border)] bg-white p-3">
        <input
          className="h-10 flex-1 rounded border border-[var(--border)] px-3 text-sm"
          placeholder="Query"
          value={query}
          onChange={(e) => setQuery(e.currentTarget.value)}
        />
        <label className="flex items-center gap-2 text-sm text-[var(--muted)]">
          TopK
          <input
            type="number"
            min={1}
            max={20}
            value={topK}
            onChange={(e) => setTopK(Math.min(20, Math.max(1, Number(e.currentTarget.value) || 8)))}
            className="h-10 w-20 rounded border border-[var(--border)] px-2 text-[var(--fg)]"
          />
        </label>
        <button
          type="submit"
          disabled={loading || !query.trim()}
          className="h-10 rounded bg-[var(--accent)] px-4 text-sm font-medium text-white disabled:opacity-50"
        >
          {loading ? "检索中" : "检索"}
        </button>
      </form>

      {error ? (
        <div className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </div>
      ) : null}

      {result ? (
        <>
          <div className="flex items-center gap-3 rounded border border-[var(--border)] bg-white px-3 py-2 text-xs text-[var(--muted)]">
            <span>Provider: {result.meta.vectorProvider}</span>
            <span>Vector: {result.meta.vectorAvailable ? "available" : "unavailable"}</span>
            <span>Dim: {result.meta.queryEmbeddingDim ?? "-"}</span>
            {result.meta.vectorStaleReason ? <span>{result.meta.vectorStaleReason}</span> : null}
          </div>
          <div className="grid grid-cols-3 gap-4">
            <ResultColumn title="FTS" hits={result.fts} />
            <ResultColumn title="Vector" hits={result.vector} />
            <ResultColumn title="Hybrid" hits={result.hybrid} />
          </div>
        </>
      ) : null}
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded border border-[var(--border)] bg-white px-3 py-2">
      <div className="text-[var(--muted)]">{label}</div>
      <div className="truncate font-semibold text-[var(--fg)]">{value}</div>
    </div>
  );
}

function ResultColumn({ title, hits }: { title: string; hits: RagEvidenceHit[] }) {
  return (
    <section className="min-w-0 rounded border border-[var(--border)] bg-white">
      <div className="border-b border-[var(--border)] px-3 py-2 text-sm font-semibold text-[var(--fg)]">
        {title} · {hits.length}
      </div>
      <div className="max-h-[calc(100vh-290px)] space-y-2 overflow-auto p-3">
        {hits.length === 0 ? (
          <p className="text-sm text-[var(--muted)]">无结果</p>
        ) : (
          hits.map((hit) => <HitCard key={`${title}-${hit.chunkId}`} hit={hit} />)
        )}
      </div>
    </section>
  );
}

function HitCard({ hit }: { hit: RagEvidenceHit }) {
  return (
    <article className="rounded border border-[var(--border)] bg-neutral-50 p-2">
      <div className="flex items-center justify-between gap-2">
        <h3 className="truncate text-xs font-semibold text-neutral-950">{hit.filePath}</h3>
        <span className="shrink-0 text-[11px] text-neutral-500">#{hit.ranks.hybrid}</span>
      </div>
      <div className="mt-1 flex gap-2 text-[11px] text-neutral-500">
        <span>{hit.matchedBy.join("+")}</span>
        <span>rrf {hit.scores.rrfScore.toFixed(4)}</span>
        {hit.scores.vectorScore !== undefined ? <span>vec {hit.scores.vectorScore.toFixed(4)}</span> : null}
      </div>
      <p className="mt-2 max-h-28 overflow-hidden whitespace-pre-wrap text-xs leading-5 text-neutral-700">
        {hit.contentPreview}
      </p>
    </article>
  );
}
