/**
 * Day 2 投影：把 1024-dim DashScope embedding 降到 2D 给 ScatterChart 用。
 *
 * 主路径：UMAP-js（n_neighbors=10, min_dist=0.05，per P3 调参）。
 * 失败回退：Johnson-Lindenstrauss 随机高斯投影（保距、O(N×d)、永远不崩）。
 *
 * 触发回退判据（P3 + 工程兜底）：
 *   1. UMAP 抛错（包括稀疏图警告、内存错误等）
 *   2. UMAP 输出含 NaN/Inf
 *   3. UMAP 输出全部坐标方差 < 1e-6（退化到一点）
 *
 * 写回路径：listCosmosVectorsForProjection → fit → updateCosmosPointProjection
 * 单次性能预算（M-class CPU, 200 点）：UMAP < 2s, 投影 < 50ms。
 */
import type Database from "better-sqlite3";
import { UMAP } from "umap-js";
import {
  listCosmosVectorsForProjection,
  updateCosmosPointProjection,
} from "./queries.js";
import { blobToFloat32 } from "../rag/embeddings.js";

export type ProjectionMethod = "umap" | "pca";

export type ProjectionResult = {
  method: ProjectionMethod | "none";
  count: number;
  /**
   * Reason UMAP was abandoned, if it was. Useful in `state.last_error`.
   * Empty string when UMAP succeeded.
   */
  fallbackReason: string;
  durationMs: number;
};

/** ai2nao 不依赖 Math.random 的可复现性，但 fallback 需要稳定座位。 */
function seededRandom(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

function vectorVariance(coords: number[][]): number {
  if (coords.length < 2) return 0;
  let sumX = 0;
  let sumY = 0;
  for (const [x, y] of coords) {
    sumX += x!;
    sumY += y!;
  }
  const meanX = sumX / coords.length;
  const meanY = sumY / coords.length;
  let v = 0;
  for (const [x, y] of coords) {
    v += (x! - meanX) ** 2 + (y! - meanY) ** 2;
  }
  return v / coords.length;
}

function hasNonFinite(coords: number[][]): boolean {
  for (const [x, y] of coords) {
    if (!Number.isFinite(x!) || !Number.isFinite(y!)) return true;
  }
  return false;
}

/**
 * Johnson-Lindenstrauss random projection. Generates two random unit
 * vectors in R^d (Gaussian then normalised) and projects every input
 * point onto them. Distances are statistically preserved (JL lemma) so
 * clusters that exist in the full embedding stay visible-ish in 2D —
 * cheaper and lower-quality than UMAP, but never crashes.
 */
function runRandomProjection(vectors: Float32Array[]): number[][] {
  if (vectors.length === 0) return [];
  const dim = vectors[0]!.length;
  const rand = seededRandom(0xc05a1d /* "cosmid" */);
  const gauss = (): number => {
    // Box-Muller; one sample per call (ignore the paired one)
    const u1 = Math.max(rand(), 1e-12);
    const u2 = rand();
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  };
  const axisA = new Float32Array(dim);
  const axisB = new Float32Array(dim);
  for (let i = 0; i < dim; i++) {
    axisA[i] = gauss();
    axisB[i] = gauss();
  }
  const normA = Math.sqrt(axisA.reduce((s, v) => s + v * v, 0));
  const normB = Math.sqrt(axisB.reduce((s, v) => s + v * v, 0));
  for (let i = 0; i < dim; i++) {
    axisA[i] = axisA[i]! / normA;
    axisB[i] = axisB[i]! / normB;
  }
  return vectors.map((v) => {
    let x = 0;
    let y = 0;
    for (let i = 0; i < dim; i++) {
      x += v[i]! * axisA[i]!;
      y += v[i]! * axisB[i]!;
    }
    return [x, y];
  });
}

function runUmap(vectors: Float32Array[]): {
  coords: number[][];
  fallbackReason: string;
} {
  if (vectors.length < 4) {
    // UMAP 在 <4 点上不稳定（n_neighbors 都比样本多）
    return { coords: [], fallbackReason: "too_few_points" };
  }
  // UMAP-js 吃 number[][]
  const X = vectors.map((v) => Array.from(v));
  const params = {
    nComponents: 2,
    nNeighbors: Math.min(10, vectors.length - 1),
    minDist: 0.05,
    nEpochs: 200,
    random: seededRandom(0xc05a1d),
  };
  try {
    const umap = new UMAP(params);
    const coords = umap.fit(X);
    if (hasNonFinite(coords)) {
      return { coords: [], fallbackReason: "umap_nonfinite_output" };
    }
    if (vectorVariance(coords) < 1e-6) {
      return { coords: [], fallbackReason: "umap_degenerate_collapse" };
    }
    return { coords, fallbackReason: "" };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { coords: [], fallbackReason: `umap_threw:${msg.slice(0, 80)}` };
  }
}

export function projectCosmosTo2D(db: Database.Database): ProjectionResult {
  const started = Date.now();
  const rows = listCosmosVectorsForProjection(db);
  if (rows.length === 0) {
    return {
      method: "none",
      count: 0,
      fallbackReason: "no_vectors",
      durationMs: Date.now() - started,
    };
  }

  const vectors = rows.map((r) => blobToFloat32(r.vector));
  const { coords: umapCoords, fallbackReason } = runUmap(vectors);
  let coords: number[][];
  let method: ProjectionMethod;
  let actualFallbackReason = fallbackReason;

  if (umapCoords.length === vectors.length) {
    coords = umapCoords;
    method = "umap";
    actualFallbackReason = "";
  } else {
    coords = runRandomProjection(vectors);
    method = "pca"; // schema enum: we use "pca" for any non-UMAP fallback
  }

  const updatedAt = new Date().toISOString();
  const writeTx = db.transaction(() => {
    for (let i = 0; i < rows.length; i++) {
      const [x, y] = coords[i]!;
      updateCosmosPointProjection(db, rows[i]!.session_id, x!, y!, updatedAt);
    }
  });
  writeTx();

  return {
    method,
    count: rows.length,
    fallbackReason: actualFallbackReason,
    durationMs: Date.now() - started,
  };
}
