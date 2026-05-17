import type Database from "better-sqlite3";
import type {
  RagFileFtsStatus,
  RagFileManifest,
  RagFileStatus,
  RagFileVectorStatus,
  RagManifestCounts,
} from "./manifestTypes.js";

type RagFileRow = {
  source_root: string;
  file_path: string;
  mtime_ms: number;
  size_bytes: number;
  file_sha256: string | null;
  status: RagFileStatus;
  fts_status: RagFileFtsStatus;
  vector_status: RagFileVectorStatus;
  chunk_count: number;
  embedding_model: string | null;
  embedding_dim: number | null;
  vector_provider: string | null;
  last_indexed_at: string | null;
  deleted_at: string | null;
  last_error: string | null;
};

export type UpsertRagFileManifestInput = {
  sourceRoot: string;
  filePath: string;
  mtimeMs: number;
  sizeBytes: number;
  fileSha256: string | null;
  status: RagFileStatus;
  ftsStatus: RagFileFtsStatus;
  vectorStatus: RagFileVectorStatus;
  chunkCount: number;
  embeddingModel: string | null;
  embeddingDim: number | null;
  vectorProvider: string | null;
  lastIndexedAt: string | null;
  deletedAt: string | null;
  lastError: string | null;
};

function mapRow(row: RagFileRow): RagFileManifest {
  return {
    sourceRoot: row.source_root,
    filePath: row.file_path,
    mtimeMs: row.mtime_ms,
    sizeBytes: row.size_bytes,
    fileSha256: row.file_sha256,
    status: row.status,
    ftsStatus: row.fts_status,
    vectorStatus: row.vector_status,
    chunkCount: row.chunk_count,
    embeddingModel: row.embedding_model,
    embeddingDim: row.embedding_dim,
    vectorProvider: row.vector_provider,
    lastIndexedAt: row.last_indexed_at,
    deletedAt: row.deleted_at,
    lastError: row.last_error,
  };
}

export function listRagFileManifests(db: Database.Database): RagFileManifest[] {
  const rows = db
    .prepare(
      `SELECT
        source_root, file_path, mtime_ms, size_bytes, file_sha256,
        status, fts_status, vector_status, chunk_count,
        embedding_model, embedding_dim, vector_provider,
        last_indexed_at, deleted_at, last_error
       FROM rag_files`
    )
    .all() as RagFileRow[];
  return rows.map(mapRow);
}

export function getRagFileManifest(
  db: Database.Database,
  sourceRoot: string,
  filePath: string
): RagFileManifest | null {
  const row = db
    .prepare(
      `SELECT
        source_root, file_path, mtime_ms, size_bytes, file_sha256,
        status, fts_status, vector_status, chunk_count,
        embedding_model, embedding_dim, vector_provider,
        last_indexed_at, deleted_at, last_error
       FROM rag_files
       WHERE source_root = ? AND file_path = ?`
    )
    .get(sourceRoot, filePath) as RagFileRow | undefined;
  return row ? mapRow(row) : null;
}

export function upsertRagFileManifest(
  db: Database.Database,
  input: UpsertRagFileManifestInput
): void {
  db.prepare(
    `INSERT INTO rag_files (
      source_root, file_path, mtime_ms, size_bytes, file_sha256,
      status, fts_status, vector_status, chunk_count,
      embedding_model, embedding_dim, vector_provider,
      last_indexed_at, deleted_at, last_error
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(source_root, file_path) DO UPDATE SET
      mtime_ms = excluded.mtime_ms,
      size_bytes = excluded.size_bytes,
      file_sha256 = excluded.file_sha256,
      status = excluded.status,
      fts_status = excluded.fts_status,
      vector_status = excluded.vector_status,
      chunk_count = excluded.chunk_count,
      embedding_model = excluded.embedding_model,
      embedding_dim = excluded.embedding_dim,
      vector_provider = excluded.vector_provider,
      last_indexed_at = excluded.last_indexed_at,
      deleted_at = excluded.deleted_at,
      last_error = excluded.last_error`
  ).run(
    input.sourceRoot,
    input.filePath,
    input.mtimeMs,
    input.sizeBytes,
    input.fileSha256,
    input.status,
    input.ftsStatus,
    input.vectorStatus,
    input.chunkCount,
    input.embeddingModel,
    input.embeddingDim,
    input.vectorProvider,
    input.lastIndexedAt,
    input.deletedAt,
    input.lastError
  );
}

export function markRagFileDeleted(
  db: Database.Database,
  args: {
    sourceRoot: string;
    filePath: string;
    mtimeMs?: number;
    sizeBytes?: number;
    vectorStatus: RagFileVectorStatus;
    deletedAt: string;
    lastError: string | null;
  }
): void {
  const existing = getRagFileManifest(db, args.sourceRoot, args.filePath);
  upsertRagFileManifest(db, {
    sourceRoot: args.sourceRoot,
    filePath: args.filePath,
    mtimeMs: args.mtimeMs ?? existing?.mtimeMs ?? 0,
    sizeBytes: args.sizeBytes ?? existing?.sizeBytes ?? 0,
    fileSha256: existing?.fileSha256 ?? null,
    status: args.vectorStatus === "error" ? "partial" : "deleted",
    ftsStatus: "deleted",
    vectorStatus: args.vectorStatus,
    chunkCount: 0,
    embeddingModel: existing?.embeddingModel ?? null,
    embeddingDim: existing?.embeddingDim ?? null,
    vectorProvider: existing?.vectorProvider ?? null,
    lastIndexedAt: existing?.lastIndexedAt ?? null,
    deletedAt: args.deletedAt,
    lastError: args.lastError,
  });
}

export function ragManifestCounts(db: Database.Database): RagManifestCounts {
  const rows = db
    .prepare("SELECT status, fts_status AS ftsStatus, vector_status AS vectorStatus, COUNT(*) AS n FROM rag_files GROUP BY status, fts_status, vector_status")
    .all() as {
      status: RagFileStatus;
      ftsStatus: RagFileFtsStatus;
      vectorStatus: RagFileVectorStatus;
      n: number;
    }[];
  const counts: RagManifestCounts = {
    total: 0,
    indexed: 0,
    skipped: 0,
    partial: 0,
    error: 0,
    deleted: 0,
    ftsError: 0,
    vectorError: 0,
  };
  for (const row of rows) {
    counts.total += row.n;
    counts[row.status] += row.n;
    if (row.ftsStatus === "error") counts.ftsError += row.n;
    if (row.vectorStatus === "error") counts.vectorError += row.n;
  }
  return counts;
}

export function cleanupDeletedRagFileManifests(
  db: Database.Database,
  olderThan: Date
): number {
  const info = db
    .prepare(
      "DELETE FROM rag_files WHERE status = 'deleted' AND deleted_at IS NOT NULL AND deleted_at < ?"
    )
    .run(olderThan.toISOString());
  return info.changes;
}
