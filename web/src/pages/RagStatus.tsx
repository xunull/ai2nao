import { useEffect, useState } from "react";
import { apiGet } from "../api";
import type { RagStatus as RagStatusPayload } from "../aiChat/types";

export function RagStatus() {
  const [status, setStatus] = useState<RagStatusPayload | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const ac = new AbortController();
    apiGet<RagStatusPayload>("/api/rag/status", { signal: ac.signal })
      .then((next) => {
        setStatus(next);
        setError(null);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
    return () => ac.abort();
  }, []);

  const manifest = status?.manifest;
  const vector = status?.vectorStore;

  return (
    <div className="space-y-5">
      <header className="flex items-start justify-between gap-8">
        <div>
          <h1 className="text-2xl font-semibold text-[var(--fg)]">RAG Status</h1>
          <p className="mt-1 text-sm text-[var(--muted)]">
            {status ? status.dbPath : "正在读取索引状态"}
          </p>
        </div>
        <div className="grid min-w-[720px] grid-cols-4 gap-3">
          <Metric label="Chunks" value={status ? String(status.chunkCount) : "-"} />
          <Metric label="Files" value={manifest ? String(manifest.total) : "-"} />
          <Metric label="Indexed" value={manifest ? String(manifest.indexed) : "-"} />
          <Metric label="Partial" value={manifest ? String(manifest.partial) : "-"} tone={manifest?.partial ? "warn" : "ok"} />
        </div>
      </header>

      {error ? (
        <div className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </div>
      ) : null}

      <section className="grid grid-cols-[1.25fr_1fr] gap-5">
        <div className="rounded border border-[var(--border)] bg-white">
          <div className="border-b border-[var(--border)] px-4 py-3 text-sm font-semibold text-[var(--fg)]">
            Manifest
          </div>
          <div className="grid grid-cols-4 gap-px bg-[var(--border)] text-sm">
            <Cell label="Total" value={manifest?.total} />
            <Cell label="Indexed" value={manifest?.indexed} />
            <Cell label="Skipped" value={manifest?.skipped} />
            <Cell label="Deleted" value={manifest?.deleted} />
            <Cell label="Partial" value={manifest?.partial} tone={manifest?.partial ? "warn" : "default"} />
            <Cell label="Error" value={manifest?.error} tone={manifest?.error ? "bad" : "default"} />
            <Cell label="FTS Error" value={manifest?.ftsError} tone={manifest?.ftsError ? "bad" : "default"} />
            <Cell label="Vector Error" value={manifest?.vectorError} tone={manifest?.vectorError ? "bad" : "default"} />
          </div>
        </div>

        <div className="rounded border border-[var(--border)] bg-white">
          <div className="border-b border-[var(--border)] px-4 py-3 text-sm font-semibold text-[var(--fg)]">
            Vector Store
          </div>
          <dl className="divide-y divide-[var(--border)] text-sm">
            <Row label="Provider" value={vector?.provider ?? "-"} />
            <Row label="Status" value={vector ? (vector.ok ? "ok" : "error") : "-"} />
            <Row label="Sync" value={vector?.syncStatus ?? "-"} />
            <Row label="Indexed" value={vector ? String(vector.indexedCount) : "-"} />
            <Row label="Model" value={vector?.embeddingModel ?? "-"} />
            <Row label="Dim" value={vector?.embeddingDim == null ? "-" : String(vector.embeddingDim)} />
          </dl>
        </div>
      </section>

      <section className="rounded border border-[var(--border)] bg-white">
        <div className="border-b border-[var(--border)] px-4 py-3 text-sm font-semibold text-[var(--fg)]">
          Configuration
        </div>
        <dl className="grid grid-cols-[160px_1fr] gap-x-4 gap-y-3 px-4 py-3 text-sm">
          <dt className="text-[var(--muted)]">Config</dt>
          <dd className="font-mono text-xs text-[var(--fg)]">{status?.configPath ?? "-"}</dd>
          <dt className="text-[var(--muted)]">Default DB</dt>
          <dd className="font-mono text-xs text-[var(--fg)]">{status?.defaultDbPath ?? "-"}</dd>
          <dt className="text-[var(--muted)]">Vector Path</dt>
          <dd className="font-mono text-xs text-[var(--fg)]">{vector?.path ?? "-"}</dd>
          <dt className="text-[var(--muted)]">Roots</dt>
          <dd className="space-y-1 font-mono text-xs text-[var(--fg)]">
            {(status?.corpusRoots.length ? status.corpusRoots : ["-"]).map((root) => (
              <div key={root}>{root}</div>
            ))}
          </dd>
          {vector?.error ? (
            <>
              <dt className="text-[var(--muted)]">Vector Error</dt>
              <dd className="text-sm text-red-700">{vector.error}</dd>
            </>
          ) : null}
        </dl>
      </section>
    </div>
  );
}

function Metric({
  label,
  value,
  tone = "default",
}: {
  label: string;
  value: string;
  tone?: "default" | "ok" | "warn";
}) {
  const toneClass =
    tone === "ok" ? "text-emerald-700" : tone === "warn" ? "text-amber-700" : "text-[var(--fg)]";
  return (
    <div className="rounded border border-[var(--border)] bg-white px-3 py-2">
      <div className="text-xs text-[var(--muted)]">{label}</div>
      <div className={`truncate text-lg font-semibold ${toneClass}`}>{value}</div>
    </div>
  );
}

function Cell({
  label,
  value,
  tone = "default",
}: {
  label: string;
  value: number | undefined;
  tone?: "default" | "warn" | "bad";
}) {
  const toneClass =
    tone === "bad" ? "text-red-700" : tone === "warn" ? "text-amber-700" : "text-[var(--fg)]";
  return (
    <div className="bg-white px-4 py-3">
      <div className="text-xs text-[var(--muted)]">{label}</div>
      <div className={`mt-1 text-xl font-semibold ${toneClass}`}>{value ?? "-"}</div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid grid-cols-[120px_1fr] gap-3 px-4 py-2.5">
      <dt className="text-[var(--muted)]">{label}</dt>
      <dd className="truncate font-mono text-xs text-[var(--fg)]">{value}</dd>
    </div>
  );
}
