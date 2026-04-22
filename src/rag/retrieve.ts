import type Database from "better-sqlite3";
import { fts5FromUserQuery } from "./ftsQuery.js";
import {
  blobToFloat32,
  cosineSimilarity,
  fetchEmbedding,
} from "./embeddings.js";
import type { RagConfigV1 } from "./types.js";

export type RagHit = {
  id: number;
  sourceRoot: string;
  filePath: string;
  content: string;
  ftsRank: number;
  cosine?: number;
};

export function searchFts(
  db: Database.Database,
  userQuery: string,
  limit: number
): RagHit[] {
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
  return stmt.all(q, limit) as RagHit[];
}

const RRF_K = 60;

function rrfScore(ftsPos: number, vecPos: number | null): number {
  const a = 1 / (RRF_K + ftsPos);
  if (vecPos == null) return a;
  return a + 1 / (RRF_K + vecPos);
}

/**
 * FTS then optional vector rerank via reciprocal rank fusion with cosine ordering.
 */
export async function searchHybrid(
  db: Database.Database,
  userQuery: string,
  topK: number,
  cfg: RagConfigV1 | null
): Promise<RagHit[]> {
  const ftsLimit = Math.min(80, Math.max(topK * 3, 20));
  const ftsHits = searchFts(db, userQuery, ftsLimit);
  if (ftsHits.length === 0) return [];
  if (!cfg?.embedding?.enabled) {
    return ftsHits.slice(0, topK);
  }

  let qVec: Float32Array;
  try {
    const em = await fetchEmbedding(userQuery, cfg);
    qVec = em.vector;
  } catch {
    return ftsHits.slice(0, topK);
  }

  const loadEmb = db.prepare(
    "SELECT embedding FROM rag_chunks WHERE id = ?"
  );

  type CosRow = { id: number; cos: number };
  const withCos: CosRow[] = [];
  for (const h of ftsHits) {
    const row = loadEmb.get(h.id) as { embedding: Buffer | null } | undefined;
    if (!row?.embedding) continue;
    const v = blobToFloat32(row.embedding);
    if (v.length !== qVec.length) continue;
    withCos.push({ id: h.id, cos: cosineSimilarity(qVec, v) });
  }
  withCos.sort((a, b) => b.cos - a.cos);
  const vecPosById = new Map<number, number>();
  withCos.forEach((r, i) => vecPosById.set(r.id, i + 1));
  const cosById = new Map<number, number>();
  for (const r of withCos) cosById.set(r.id, r.cos);

  const combined: { hit: RagHit; score: number }[] = [];
  for (let i = 0; i < ftsHits.length; i++) {
    const h = ftsHits[i]!;
    const ftsPos = i + 1;
    const vPos = vecPosById.get(h.id) ?? null;
    const score = rrfScore(ftsPos, vPos);
    const cos = cosById.get(h.id);
    combined.push({
      hit: { ...h, cosine: cos },
      score,
    });
  }
  combined.sort((a, b) => b.score - a.score);
  return combined.slice(0, topK).map((c) => c.hit);
}

export function countChunks(db: Database.Database): number {
  const row = db
    .prepare("SELECT COUNT(*) AS n FROM rag_chunks")
    .get() as { n: number };
  return row.n;
}
