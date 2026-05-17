import type Database from "better-sqlite3";
import { defaultRagVectorDbPath } from "../config.js";
import { chunkText } from "./chunk.js";
import { deleteChunksForFile } from "./dbChunks.js";
import {
  fetchEmbeddingsBatch,
  float32ToBlob,
} from "./embeddings.js";
import type { IngestFileProgress, IngestResult } from "./ingest.js";
import type { RagFileFtsStatus, RagFileVectorStatus } from "./manifestTypes.js";
import {
  markRagFileDeleted,
  upsertRagFileManifest,
} from "./manifest.js";
import { markVectorSync, readVectorSyncState } from "./meta.js";
import { sha256Hex } from "./sha256.js";
import { createVectorStore } from "./vectorStore/factory.js";
import type { RagVectorChunk } from "./vectorStore/types.js";
import { readFileLimited } from "./walkFiles.js";
import type { RagIngestPlan, RagIngestPlanAction } from "./ingestPlan.js";

export type ExecuteRagIngestPlanOptions = {
  onProgress?: (p: IngestFileProgress) => void;
};

const nowIso = () => new Date().toISOString();

function vectorProviderForPlan(plan: RagIngestPlan): "none" | "lancedb" {
  return plan.effectiveConfig.vectorStore?.provider ?? "none";
}

function vectorPathForPlan(plan: RagIngestPlan): string | null {
  return plan.effectiveConfig.vectorStore?.provider === "lancedb"
    ? plan.effectiveConfig.vectorStore.path ?? defaultRagVectorDbPath()
    : null;
}

function vectorUnavailableStatus(plan: RagIngestPlan): RagFileVectorStatus {
  if (!plan.effectiveConfig.embedding?.enabled) return "unavailable";
  return vectorProviderForPlan(plan) === "none" ? "none" : "indexed";
}

function emptyResult(plan: RagIngestPlan): IngestResult {
  return {
    roots: plan.roots.length,
    filesSeen: plan.filesSeen,
    filesIndexed: 0,
    filesSkipped: 0,
    filesDeleted: 0,
    filesPartial: 0,
    chunksInserted: 0,
    errors: [...plan.warnings],
    plan: plan.counts,
    dryRun: false,
  };
}

export async function executeRagIngestPlan(
  db: Database.Database,
  plan: RagIngestPlan,
  options: ExecuteRagIngestPlanOptions = {}
): Promise<IngestResult> {
  const result = emptyResult(plan);
  const vectorStore = createVectorStore(plan.effectiveConfig);
  let vectorHadError = false;
  let vectorEmbeddingDim: number | null = null;

  const executable = plan.actions.filter((action) => action.kind !== "skip");
  result.filesSkipped = plan.counts.skip;
  if (executable.length === 0) return result;

  const previousVectorSync = readVectorSyncState(db);
  let ordinal = 0;
  for (const action of executable) {
    ordinal++;
    options.onProgress?.({
      current: ordinal,
      total: executable.length,
      relPath: action.filePath,
    });
    if (action.kind === "delete_missing") {
      const vectorOk = await deleteVectorFile(vectorStore, action, result);
      if (!vectorOk) vectorHadError = true;
      deleteChunksForFile(db, action.sourceRoot, action.filePath);
      markRagFileDeleted(db, {
        sourceRoot: action.sourceRoot,
        filePath: action.filePath,
        vectorStatus: vectorOk ? "deleted" : "error",
        deletedAt: nowIso(),
        lastError: vectorOk ? null : "vector delete failed",
      });
      result.filesDeleted++;
      if (!vectorOk) result.filesPartial++;
      continue;
    }

    const indexed = await indexFileAction(db, plan, action, result);
    if (indexed.vectorError) vectorHadError = true;
    if (indexed.embeddingDim != null) vectorEmbeddingDim = indexed.embeddingDim;
  }

  const provider = vectorProviderForPlan(plan);
  markVectorSync(db, {
    provider,
    path: vectorPathForPlan(plan),
    embeddingModel: plan.effectiveConfig.embedding?.model ?? null,
    embeddingDim: vectorEmbeddingDim ?? previousVectorSync.embeddingDim ?? null,
    status:
      provider === "none"
        ? "none"
        : !plan.effectiveConfig.embedding?.enabled
          ? "stale"
          : vectorHadError
            ? "partial"
            : "fresh",
    error:
      provider !== "none" && !plan.effectiveConfig.embedding?.enabled
        ? "vector store is enabled but embedding is disabled"
        : vectorHadError
          ? "one or more vector index operations failed"
          : null,
  });
  return result;
}

async function deleteVectorFile(
  vectorStore: ReturnType<typeof createVectorStore>,
  action: RagIngestPlanAction,
  result: IngestResult
): Promise<boolean> {
  if (vectorStore.provider === "none") return true;
  try {
    await vectorStore.deleteFile(action.sourceRoot, action.filePath);
    return true;
  } catch (e) {
    result.errors.push(
      `vector delete failed for ${action.filePath}: ${e instanceof Error ? e.message : String(e)}`
    );
    return false;
  }
}

async function indexFileAction(
  db: Database.Database,
  plan: RagIngestPlan,
  action: RagIngestPlanAction,
  result: IngestResult
): Promise<{ vectorError: boolean; embeddingDim: number | null }> {
  if (!action.file) {
    result.errors.push(`${action.filePath}: cannot index without file metadata`);
    return { vectorError: false, embeddingDim: null };
  }
  const read = readFileLimited(
    action.file.absPath,
    action.file.relPath,
    action.file.mtimeMs,
    plan.effectiveConfig.maxFileBytes
  );
  if (!read.ok) {
    result.errors.push(read.error);
    upsertRagFileManifest(db, errorManifest(plan, action, read.error));
    return { vectorError: false, embeddingDim: null };
  }

  const body = read.data.body;
  const fileSha256 = action.fileSha256 ?? sha256Hex(body);
  const chunks = chunkText(body);
  const vectorStore = createVectorStore(plan.effectiveConfig);
  let embBatch: { dim: number; vector: Float32Array }[] = [];
  let embeddingError: string | null = null;
  if (plan.effectiveConfig.embedding?.enabled && chunks.length > 0) {
    try {
      embBatch = await fetchEmbeddingsBatch(chunks, plan.effectiveConfig);
    } catch (e) {
      embeddingError = e instanceof Error ? e.message : String(e);
      result.errors.push(`embed failed for ${action.filePath}: ${embeddingError}`);
    }
  }
  if (embBatch.length > 0 && embBatch.length !== chunks.length) {
    embeddingError = `embed count mismatch: expected ${chunks.length}, got ${embBatch.length}`;
    result.errors.push(`embed count mismatch for ${action.filePath}: expected ${chunks.length}, got ${embBatch.length}`);
    embBatch = [];
  }

  let vectorDeleteOk = true;
  if (vectorStore.provider !== "none") {
    vectorDeleteOk = await deleteVectorFile(vectorStore, action, result);
  }

  try {
    const vectorRows = replaceSqliteChunks(
      db,
      action,
      chunks,
      embBatch
    );
    result.chunksInserted += chunks.length;
    result.filesIndexed++;

    let vectorStatus: RagFileVectorStatus = vectorUnavailableStatus(plan);
    let vectorError: string | null = null;
    let embeddingDim: number | null = embBatch[0]?.dim ?? null;
    if (vectorStore.provider === "lancedb") {
      if (embeddingError) {
        vectorStatus = "error";
        vectorError = embeddingError;
      } else if (!vectorDeleteOk) {
        vectorStatus = "error";
        vectorError = "vector delete failed";
      } else if (vectorRows.length > 0) {
        try {
          await vectorStore.upsertChunks(vectorRows);
          vectorStatus = "indexed";
        } catch (e) {
          vectorStatus = "error";
          vectorError = e instanceof Error ? e.message : String(e);
          result.errors.push(`vector upsert failed for ${action.filePath}: ${vectorError}`);
        }
      } else {
        vectorStatus = "indexed";
      }
    }

    const ftsStatus: RagFileFtsStatus = chunks.length > 0 ? "indexed" : "none";
    const partial = vectorStatus === "error";
    if (partial) result.filesPartial++;
    upsertRagFileManifest(db, {
      sourceRoot: action.sourceRoot,
      filePath: action.filePath,
      mtimeMs: read.data.mtimeMs,
      sizeBytes: read.data.sizeBytes,
      fileSha256,
      status: partial ? "partial" : "indexed",
      ftsStatus,
      vectorStatus,
      chunkCount: chunks.length,
      embeddingModel: plan.effectiveConfig.embedding?.model ?? null,
      embeddingDim,
      vectorProvider: vectorProviderForPlan(plan),
      lastIndexedAt: nowIso(),
      deletedAt: null,
      lastError: vectorError,
    });
    return { vectorError: partial, embeddingDim };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    result.errors.push(`sqlite index failed for ${action.filePath}: ${msg}`);
    upsertRagFileManifest(db, errorManifest(plan, action, msg));
    return { vectorError: false, embeddingDim: null };
  }
}

function replaceSqliteChunks(
  db: Database.Database,
  action: RagIngestPlanAction,
  chunks: string[],
  embBatch: { dim: number; vector: Float32Array }[]
): RagVectorChunk[] {
  const insertNoEmb = db.prepare(`
    INSERT INTO rag_chunks (source_root, file_path, chunk_index, content, mtime_ms, content_sha256, embedding_dim, embedding)
    VALUES (?, ?, ?, ?, ?, ?, NULL, NULL)
  `);
  const insertWithEmb = db.prepare(`
    INSERT INTO rag_chunks (source_root, file_path, chunk_index, content, mtime_ms, content_sha256, embedding_dim, embedding)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertFts = db.prepare(`
    INSERT INTO rag_chunks_fts (chunk_id, source_root, file_path, content)
    VALUES (?, ?, ?, ?)
  `);
  const rows: RagVectorChunk[] = [];
  db.transaction(() => {
    deleteChunksForFile(db, action.sourceRoot, action.filePath);
    for (let i = 0; i < chunks.length; i++) {
      const content = chunks[i]!;
      const sha = sha256Hex(content);
      const em = embBatch[i];
      const info = em
        ? insertWithEmb.run(
            action.sourceRoot,
            action.filePath,
            i,
            content,
            action.file!.mtimeMs,
            sha,
            em.dim,
            float32ToBlob(em.vector)
          )
        : insertNoEmb.run(
            action.sourceRoot,
            action.filePath,
            i,
            content,
            action.file!.mtimeMs,
            sha
          );
      const chunkId = Number(info.lastInsertRowid);
      insertFts.run(chunkId, action.sourceRoot, action.filePath, content);
      if (em) {
        rows.push({
          chunkId,
          sourceRoot: action.sourceRoot,
          filePath: action.filePath,
          chunkIndex: i,
          contentSha256: sha,
          embedding: em.vector,
        });
      }
    }
  })();
  return rows;
}

function errorManifest(
  plan: RagIngestPlan,
  action: RagIngestPlanAction,
  message: string
) {
  return {
    sourceRoot: action.sourceRoot,
    filePath: action.filePath,
    mtimeMs: action.file?.mtimeMs ?? action.manifest?.mtimeMs ?? 0,
    sizeBytes: action.file?.sizeBytes ?? action.manifest?.sizeBytes ?? 0,
    fileSha256: action.fileSha256 ?? action.manifest?.fileSha256 ?? null,
    status: "error" as const,
    ftsStatus: "error" as const,
    vectorStatus: "error" as const,
    chunkCount: action.manifest?.chunkCount ?? 0,
    embeddingModel: plan.effectiveConfig.embedding?.model ?? action.manifest?.embeddingModel ?? null,
    embeddingDim: action.manifest?.embeddingDim ?? null,
    vectorProvider: vectorProviderForPlan(plan),
    lastIndexedAt: action.manifest?.lastIndexedAt ?? null,
    deletedAt: null,
    lastError: message,
  };
}
