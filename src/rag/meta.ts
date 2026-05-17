import type Database from "better-sqlite3";

export const RAG_VECTOR_SCHEMA_VERSION = "1";

export type RagVectorSyncState = {
  provider: string;
  path: string | null;
  embeddingModel: string | null;
  embeddingDim: number | null;
  status: "none" | "fresh" | "partial" | "stale" | "unavailable";
  error: string | null;
};

export function ensureRagMetaTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS rag_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
}

export function getRagMeta(db: Database.Database, key: string): string | null {
  ensureRagMetaTable(db);
  const row = db.prepare("SELECT value FROM rag_meta WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

export function setRagMeta(db: Database.Database, key: string, value: string): void {
  ensureRagMetaTable(db);
  db.prepare(
    "INSERT INTO rag_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).run(key, value);
}

export function markVectorSync(
  db: Database.Database,
  state: Omit<RagVectorSyncState, "embeddingDim"> & { embeddingDim: number | null }
): void {
  const tx = db.transaction(() => {
    setRagMeta(db, "vector.provider", state.provider);
    setRagMeta(db, "vector.path", state.path ?? "");
    setRagMeta(db, "vector.embedding_model", state.embeddingModel ?? "");
    setRagMeta(db, "vector.embedding_dim", String(state.embeddingDim ?? ""));
    setRagMeta(db, "vector.schema_version", RAG_VECTOR_SCHEMA_VERSION);
    setRagMeta(db, "vector.status", state.status);
    setRagMeta(db, "vector.error", state.error ?? "");
  });
  tx();
}

export function readVectorSyncState(db: Database.Database): RagVectorSyncState {
  const dimRaw = getRagMeta(db, "vector.embedding_dim");
  const dim = dimRaw ? Number.parseInt(dimRaw, 10) : Number.NaN;
  const status = getRagMeta(db, "vector.status");
  return {
    provider: getRagMeta(db, "vector.provider") || "none",
    path: getRagMeta(db, "vector.path") || null,
    embeddingModel: getRagMeta(db, "vector.embedding_model") || null,
    embeddingDim: Number.isFinite(dim) ? dim : null,
    status:
      status === "fresh" ||
      status === "partial" ||
      status === "stale" ||
      status === "unavailable"
        ? status
        : "none",
    error: getRagMeta(db, "vector.error") || null,
  };
}
