import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { openDatabase } from "../src/store/open.js";
import { registerWorkCosmosRoutes } from "../src/workCosmos/routes.js";
import { float32ToBlob } from "../src/rag/embeddings.js";
import { rowToDto, toPointsResponse } from "../src/workCosmos/json.js";

/**
 * ★ CRITICAL sanitize gate (Section 3 of eng review).
 *
 * The whole point of the D3 schema decision was that summary text NEVER
 * leaks into an API payload. These tests verify that property at both the
 * pure-JSON layer (rowToDto / toPointsResponse) and the HTTP boundary
 * (GET /api/work-cosmos/points), so a future regression that adds
 * "convenience" fields to either layer gets caught.
 */

const FORBIDDEN_SUBSTRINGS = [
  "SECRET-USER-MESSAGE",
  "private-thought-text",
  "sensitive workspace path",
];

function fresh() {
  const dir = mkdtempSync(join(tmpdir(), "ai2nao-cosmos-sanitize-"));
  return openDatabase(join(dir, "test.db"));
}

describe("Cosmos JSON sanitize — internal layer", () => {
  it("rowToDto drops source_path / source_mtime_ms / source_size_bytes", () => {
    const apiSafe = {
      session_id: "s1",
      source: "claude" as const,
      project_key: "/tmp/test",
      project_path: "/tmp/test",
      total_tokens: 100,
      x: 1.5,
      y: -2.0,
      cluster_id: null,
      token_status: "full" as const,
      embedding_status: "ok" as const,
      missing_since: null,
      source_seen_at: "now",
      updated_at: "now",
    };
    const dto = rowToDto(apiSafe);
    expect(Object.keys(dto)).toEqual([
      "sessionId",
      "source",
      "projectKey",
      "projectPath",
      "totalTokens",
      "x",
      "y",
      "clusterId",
    ]);
  });

  it("toPointsResponse emits a stable structural shape", () => {
    const apiSafe = [
      {
        session_id: "s1",
        source: "claude" as const,
        project_key: "/tmp/test",
        project_path: "/tmp/test",
        total_tokens: 100,
        x: 1.5,
        y: -2.0,
        cluster_id: null,
        token_status: "full" as const,
        embedding_status: "ok" as const,
        missing_since: null,
        source_seen_at: "now",
        updated_at: "now",
      },
    ];
    const resp = toPointsResponse({
      rows: apiSafe,
      projectionMethod: "umap",
      embeddingModel: "text-embedding-v4",
    });
    expect(resp.ok).toBe(true);
    expect(resp.pointCount).toBe(1);
    expect(resp.projectionMethod).toBe("umap");
    expect(resp.embeddingModel).toBe("text-embedding-v4");
    expect(resp.points[0]!.sessionId).toBe("s1");
  });
});

describe("Cosmos sanitize gate — HTTP boundary", () => {
  it("GET /api/work-cosmos/points NEVER returns summary text from embeddings table", async () => {
    const db = fresh();
    // seed a point with everything filled in
    db.prepare(
      `INSERT INTO work_cosmos_points
         (session_id, source, source_path, source_mtime_ms, source_size_bytes,
          project_key, project_path, total_tokens, x, y, cluster_id,
          token_status, embedding_status, source_seen_at, updated_at)
       VALUES ('s1', 'claude', '/tmp/SECRET-USER-MESSAGE.jsonl', 0, 0,
               'pk', '/tmp', 100, 1.0, 2.0, NULL,
               'full', 'ok', 'now', 'now')`
    ).run();
    // critically, the embeddings table holds the summary
    db.prepare(
      `INSERT INTO work_cosmos_embeddings
         (session_id, embedding_dim, vector, summary, updated_at)
       VALUES ('s1', 4, ?, ?, 'now')`
    ).run(
      float32ToBlob(new Float32Array([1, 2, 3, 4])),
      "SECRET-USER-MESSAGE — private-thought-text — sensitive workspace path"
    );

    const app = new Hono();
    registerWorkCosmosRoutes(app, db, undefined);
    const res = await app.request("http://x/api/work-cosmos/points");
    expect(res.status).toBe(200);
    const bodyText = await res.text();

    for (const forbidden of FORBIDDEN_SUBSTRINGS) {
      expect(bodyText).not.toContain(forbidden);
    }
    // also no internal source_path / mtime / size leak
    expect(bodyText).not.toContain("source_path");
    expect(bodyText).not.toContain("source_mtime_ms");
    expect(bodyText).not.toContain("source_size_bytes");
    expect(bodyText).not.toContain("/tmp/SECRET");
  });

  it("excludes missing rows and pending/error embedding states", async () => {
    const db = fresh();
    // missing — should be excluded
    db.prepare(
      `INSERT INTO work_cosmos_points
         (session_id, source, source_path, source_mtime_ms, source_size_bytes,
          project_key, project_path, total_tokens, x, y, cluster_id,
          token_status, embedding_status, missing_since,
          source_seen_at, updated_at)
       VALUES ('missing', 'claude', '/tmp/x', 0, 0, 'p', '/tmp', 0,
               1, 1, NULL, 'full', 'ok', 'yesterday', 'now', 'now')`
    ).run();
    // pending — excluded by embedding_status filter
    db.prepare(
      `INSERT INTO work_cosmos_points
         (session_id, source, source_path, source_mtime_ms, source_size_bytes,
          project_key, project_path, total_tokens, x, y, cluster_id,
          token_status, embedding_status,
          source_seen_at, updated_at)
       VALUES ('pending', 'claude', '/tmp/x', 0, 0, 'p', '/tmp', 0,
               1, 1, NULL, 'full', 'pending', 'now', 'now')`
    ).run();
    // ok with no projection — excluded by x IS NOT NULL
    db.prepare(
      `INSERT INTO work_cosmos_points
         (session_id, source, source_path, source_mtime_ms, source_size_bytes,
          project_key, project_path, total_tokens, x, y, cluster_id,
          token_status, embedding_status,
          source_seen_at, updated_at)
       VALUES ('noproj', 'claude', '/tmp/x', 0, 0, 'p', '/tmp', 0,
               NULL, NULL, NULL, 'full', 'ok', 'now', 'now')`
    ).run();
    // ok with projection — should appear
    db.prepare(
      `INSERT INTO work_cosmos_points
         (session_id, source, source_path, source_mtime_ms, source_size_bytes,
          project_key, project_path, total_tokens, x, y, cluster_id,
          token_status, embedding_status,
          source_seen_at, updated_at)
       VALUES ('good', 'claude', '/tmp/x', 0, 0, 'p', '/tmp', 0,
               1, 1, NULL, 'full', 'ok', 'now', 'now')`
    ).run();

    const app = new Hono();
    registerWorkCosmosRoutes(app, db, undefined);
    const res = await app.request("http://x/api/work-cosmos/points");
    const body = (await res.json()) as { points: { sessionId: string }[] };
    expect(body.points.map((p) => p.sessionId)).toEqual(["good"]);
  });
});
