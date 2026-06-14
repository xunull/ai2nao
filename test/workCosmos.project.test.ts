import { describe, expect, it, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { openDatabase } from "../src/store/open.js";
import { projectCosmosTo2D } from "../src/workCosmos/project.js";
import { float32ToBlob } from "../src/rag/embeddings.js";

function fresh() {
  const base = mkdtempSync(join(tmpdir(), "ai2nao-cosmos-proj-"));
  return openDatabase(join(base, "test.db"));
}

function seedPointAndVector(
  db: Database.Database,
  sessionId: string,
  vector: Float32Array
): void {
  db.prepare(
    `INSERT INTO work_cosmos_points
       (session_id, source, source_path, source_mtime_ms, source_size_bytes,
        project_key, project_path, total_tokens,
        token_status, embedding_status, source_seen_at, updated_at)
     VALUES (?, 'claude', '/tmp/x', 0, 0, 'pk', '/tmp', 100, 'full', 'ok', 'now', 'now')`
  ).run(sessionId);
  db.prepare(
    `INSERT INTO work_cosmos_embeddings
       (session_id, embedding_dim, vector, summary, updated_at)
     VALUES (?, ?, ?, ?, 'now')`
  ).run(sessionId, vector.length, float32ToBlob(vector), "summary");
}

function randomVector(seed: number, dim = 32): Float32Array {
  let s = seed >>> 0;
  const v = new Float32Array(dim);
  for (let i = 0; i < dim; i++) {
    s = (s * 1664525 + 1013904223) >>> 0;
    v[i] = (s / 0x100000000) * 2 - 1;
  }
  return v;
}

describe("projectCosmosTo2D", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = fresh();
  });

  it("returns method='none' when no embeddings exist", () => {
    const result = projectCosmosTo2D(db);
    expect(result.method).toBe("none");
    expect(result.count).toBe(0);
  });

  it("UMAP succeeds on 20 random vectors and writes finite x/y", () => {
    for (let i = 0; i < 20; i++) {
      seedPointAndVector(db, `s${i}`, randomVector(i + 1, 32));
    }
    const result = projectCosmosTo2D(db);
    expect(result.method).toBe("umap");
    expect(result.count).toBe(20);

    const rows = db
      .prepare("SELECT x, y FROM work_cosmos_points WHERE x IS NOT NULL")
      .all() as { x: number; y: number }[];
    expect(rows).toHaveLength(20);
    for (const r of rows) {
      expect(Number.isFinite(r.x)).toBe(true);
      expect(Number.isFinite(r.y)).toBe(true);
    }
  });

  it("falls back to random projection when there are too few points (< 4)", () => {
    for (let i = 0; i < 2; i++) {
      seedPointAndVector(db, `s${i}`, randomVector(i + 1, 32));
    }
    const result = projectCosmosTo2D(db);
    expect(result.method).toBe("pca");
    expect(result.count).toBe(2);

    const rows = db
      .prepare("SELECT x, y FROM work_cosmos_points WHERE x IS NOT NULL")
      .all() as { x: number; y: number }[];
    expect(rows).toHaveLength(2);
    expect(rows[0]!.x).not.toBe(rows[1]!.x); // should produce distinct coords
  });

  it("UMAP output spreads across canvas (variance > 1e-6)", () => {
    for (let i = 0; i < 30; i++) {
      seedPointAndVector(db, `s${i}`, randomVector(i + 1, 32));
    }
    projectCosmosTo2D(db);
    const rows = db
      .prepare("SELECT x, y FROM work_cosmos_points")
      .all() as { x: number; y: number }[];

    let sumX = 0;
    let sumY = 0;
    for (const r of rows) {
      sumX += r.x;
      sumY += r.y;
    }
    const mx = sumX / rows.length;
    const my = sumY / rows.length;
    let variance = 0;
    for (const r of rows) {
      variance += (r.x - mx) ** 2 + (r.y - my) ** 2;
    }
    variance /= rows.length;
    expect(variance).toBeGreaterThan(1e-6);
  });

  it("skips embeddings whose points are marked missing", () => {
    for (let i = 0; i < 10; i++) {
      seedPointAndVector(db, `s${i}`, randomVector(i + 1, 32));
    }
    db.prepare(
      "UPDATE work_cosmos_points SET missing_since = 'now' WHERE session_id = 's0'"
    ).run();

    const result = projectCosmosTo2D(db);
    expect(result.count).toBe(9);
    const projected = db
      .prepare(
        "SELECT COUNT(*) AS c FROM work_cosmos_points WHERE x IS NOT NULL"
      )
      .get() as { c: number };
    expect(projected.c).toBe(9);
  });

  it("skips embeddings whose points have embedding_status != 'ok'", () => {
    for (let i = 0; i < 5; i++) {
      seedPointAndVector(db, `s${i}`, randomVector(i + 1, 32));
    }
    db.prepare(
      "UPDATE work_cosmos_points SET embedding_status = 'rate_limited' WHERE session_id = 's0'"
    ).run();

    const result = projectCosmosTo2D(db);
    expect(result.count).toBe(4);
  });
});
