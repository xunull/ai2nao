import type Database from "better-sqlite3";
import { fts5FromUserQuery } from "./ftsQuery.js";
import { fetchEmbedding } from "./embeddings.js";
import type { RagConfigV1 } from "./types.js";
import {
  type RagEvidenceHit,
  type RagSearchMeta,
  type RagSearchResult,
  previewContent,
} from "./evidence.js";
import { readVectorSyncState } from "./meta.js";
import { createVectorStore } from "./vectorStore/factory.js";
import type { RagVectorHit, RagVectorStore } from "./vectorStore/types.js";

export type RagFtsHit = {
  id: number;
  sourceRoot: string;
  filePath: string;
  content: string;
  ftsRank: number;
};

type ChunkRow = {
  id: number;
  sourceRoot: string;
  filePath: string;
  content: string;
};

export type SearchHybridOptions = {
  vectorStore?: RagVectorStore;
  queryVector?: Float32Array;
  ftsLimit?: number;
  vectorLimit?: number;
};

export function searchFts(
  db: Database.Database,
  userQuery: string,
  limit: number
): RagFtsHit[] {
  const q = fts5FromUserQuery(userQuery);
  if (!q || q === '""') return [];
  const stmt = db.prepare(`
    SELECT
      c.id AS id,
      c.source_root AS sourceRoot,
      c.file_path AS filePath,
      c.content AS content,
      bm25(rag_chunks_fts) AS ftsRank
    FROM rag_chunks_fts
    JOIN rag_chunks c ON c.id = rag_chunks_fts.chunk_id
    WHERE rag_chunks_fts MATCH ?
    ORDER BY ftsRank
    LIMIT ?
  `);
  return stmt.all(q, limit) as RagFtsHit[];
}

const RRF_K = 60;

function rrfScore(ftsPos: number | null, vecPos: number | null): number {
  const fts = ftsPos == null ? 0 : 1 / (RRF_K + ftsPos);
  const vec = vecPos == null ? 0 : 1 / (RRF_K + vecPos);
  return fts + vec;
}

function hydrateChunksById(db: Database.Database, ids: number[]): Map<number, ChunkRow> {
  const unique = [...new Set(ids)];
  const byId = new Map<number, ChunkRow>();
  if (unique.length === 0) return byId;
  const stmt = db.prepare(`
    SELECT
      id AS id,
      source_root AS sourceRoot,
      file_path AS filePath,
      content AS content
    FROM rag_chunks
    WHERE id = ?
  `);
  for (const id of unique) {
    const row = stmt.get(id) as ChunkRow | undefined;
    if (row) byId.set(id, row);
  }
  return byId;
}

function toEvidenceHit(args: {
  chunk: ChunkRow;
  ftsRank?: number;
  ftsPos?: number;
  vectorScore?: number;
  vectorPos?: number;
  hybridPos: number;
}): RagEvidenceHit {
  const { contentPreview, truncated } = previewContent(args.chunk.content);
  const score = rrfScore(args.ftsPos ?? null, args.vectorPos ?? null);
  return {
    chunkId: args.chunk.id,
    sourceRoot: args.chunk.sourceRoot,
    filePath: args.chunk.filePath,
    content: args.chunk.content,
    contentPreview,
    truncated,
    scores: {
      ...(args.ftsRank !== undefined ? { ftsRank: args.ftsRank } : {}),
      ...(args.vectorScore !== undefined ? { vectorScore: args.vectorScore } : {}),
      rrfScore: score,
    },
    ranks: {
      ...(args.ftsPos !== undefined ? { fts: args.ftsPos } : {}),
      ...(args.vectorPos !== undefined ? { vector: args.vectorPos } : {}),
      hybrid: args.hybridPos,
    },
    matchedBy: [
      ...(args.ftsPos !== undefined ? (["fts"] as const) : []),
      ...(args.vectorPos !== undefined ? (["vector"] as const) : []),
    ],
  };
}

async function searchVectorBranch(
  store: RagVectorStore,
  userQuery: string,
  topK: number,
  cfg: RagConfigV1 | null,
  db: Database.Database,
  meta: RagSearchMeta,
  options: SearchHybridOptions
): Promise<RagVectorHit[]> {
  if (store.provider === "none") return [];
  if (!cfg?.embedding?.enabled) {
    meta.vectorStaleReason = "embedding is disabled in rag config";
    return [];
  }
  const sync = readVectorSyncState(db);
  if (sync.status && sync.status !== "fresh" && sync.status !== "partial") {
    meta.vectorStaleReason = sync.error ?? `vector index status is ${sync.status}`;
  }

  let qVec: Float32Array;
  try {
    qVec = options.queryVector ?? (await fetchEmbedding(userQuery, cfg)).vector;
    meta.queryEmbeddingDim = qVec.length;
  } catch (e) {
    meta.errors.push({
      branch: "vector",
      message: e instanceof Error ? e.message : String(e),
    });
    meta.vectorStaleReason = "failed to embed query";
    return [];
  }

  if (sync.embeddingDim && sync.embeddingDim !== qVec.length) {
    meta.vectorStaleReason = `embedding dim mismatch: index=${sync.embeddingDim}, query=${qVec.length}`;
    return [];
  }

  try {
    const hits = await store.search(qVec, topK);
    meta.vectorAvailable = true;
    return hits;
  } catch (e) {
    meta.errors.push({
      branch: "vector",
      message: e instanceof Error ? e.message : String(e),
    });
    meta.vectorStaleReason = "vector search failed";
    return [];
  }
}

export async function searchHybridDetailed(
  db: Database.Database,
  userQuery: string,
  topK: number,
  cfg: RagConfigV1 | null,
  options: SearchHybridOptions = {}
): Promise<RagSearchResult> {
  const safeTopK = Math.max(1, Math.floor(topK));
  const ftsLimit = options.ftsLimit ?? Math.min(80, Math.max(safeTopK * 3, 20));
  const vectorLimit = options.vectorLimit ?? Math.min(80, Math.max(safeTopK * 3, 20));
  const store = options.vectorStore ?? createVectorStore(cfg);
  const meta: RagSearchMeta = {
    vectorProvider: store.provider,
    vectorAvailable: false,
    errors: [],
  };

  let ftsHits: RagFtsHit[] = [];
  try {
    ftsHits = searchFts(db, userQuery, ftsLimit);
  } catch (e) {
    meta.errors.push({
      branch: "fts",
      message: e instanceof Error ? e.message : String(e),
    });
  }

  const vectorHits = await searchVectorBranch(
    store,
    userQuery,
    vectorLimit,
    cfg,
    db,
    meta,
    options
  );

  const ftsPosById = new Map<number, number>();
  const ftsRankById = new Map<number, number>();
  ftsHits.forEach((hit, index) => {
    ftsPosById.set(hit.id, index + 1);
    ftsRankById.set(hit.id, hit.ftsRank);
  });

  const vectorPosById = new Map<number, number>();
  const vectorScoreById = new Map<number, number>();
  vectorHits.forEach((hit, index) => {
    vectorPosById.set(hit.chunkId, index + 1);
    vectorScoreById.set(hit.chunkId, hit.score);
  });

  const ftsChunkIds = ftsHits.map((hit) => hit.id);
  const vectorChunkIds = vectorHits.map((hit) => hit.chunkId);
  const chunks = hydrateChunksById(db, [...ftsChunkIds, ...vectorChunkIds]);

  const combinedIds = [...new Set([...ftsChunkIds, ...vectorChunkIds])];
  const scored = combinedIds
    .map((id) => {
      const chunk = chunks.get(id);
      if (!chunk) return null;
      const ftsPos = ftsPosById.get(id);
      const vectorPos = vectorPosById.get(id);
      return {
        chunk,
        score: rrfScore(ftsPos ?? null, vectorPos ?? null),
      };
    })
    .filter((row): row is { chunk: ChunkRow; score: number } => row !== null)
    .sort((a, b) => b.score - a.score)
    .slice(0, safeTopK);

  const hits = scored.map((row, index) =>
    toEvidenceHit({
      chunk: row.chunk,
      ftsRank: ftsRankById.get(row.chunk.id),
      ftsPos: ftsPosById.get(row.chunk.id),
      vectorScore: vectorScoreById.get(row.chunk.id),
      vectorPos: vectorPosById.get(row.chunk.id),
      hybridPos: index + 1,
    })
  );

  const fts = ftsHits
    .slice(0, safeTopK)
    .map((hit, index) => {
      const chunk = chunks.get(hit.id);
      if (!chunk) return null;
      return toEvidenceHit({
        chunk,
        ftsRank: hit.ftsRank,
        ftsPos: index + 1,
        vectorScore: vectorScoreById.get(hit.id),
        vectorPos: vectorPosById.get(hit.id),
        hybridPos: hits.find((item) => item.chunkId === hit.id)?.ranks.hybrid ?? index + 1,
      });
    })
    .filter((hit): hit is RagEvidenceHit => hit !== null);

  const vector = vectorHits
    .slice(0, safeTopK)
    .map((hit, index) => {
      const chunk = chunks.get(hit.chunkId);
      if (!chunk) return null;
      return toEvidenceHit({
        chunk,
        ftsRank: ftsRankById.get(hit.chunkId),
        ftsPos: ftsPosById.get(hit.chunkId),
        vectorScore: hit.score,
        vectorPos: index + 1,
        hybridPos: hits.find((item) => item.chunkId === hit.chunkId)?.ranks.hybrid ?? index + 1,
      });
    })
    .filter((hit): hit is RagEvidenceHit => hit !== null);

  return { query: userQuery, hits, fts, vector, meta };
}

export async function searchHybrid(
  db: Database.Database,
  userQuery: string,
  topK: number,
  cfg: RagConfigV1 | null
): Promise<RagEvidenceHit[]> {
  return (await searchHybridDetailed(db, userQuery, topK, cfg)).hits;
}

export function countChunks(db: Database.Database): number {
  const row = db
    .prepare("SELECT COUNT(*) AS n FROM rag_chunks")
    .get() as { n: number };
  return row.n;
}
