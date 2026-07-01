import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/store/open.js";

/**
 * T1 regression: schema v27 creates the three cosmos tables with the right
 * shape, the CHECK constraints reject invalid enums, and the FK from
 * embeddings → points cascades on delete.
 */
describe("schema v27 — work_cosmos_* tables", () => {
  function fresh() {
    const dir = mkdtempSync(join(tmpdir(), "ai2nao-cosmos-mig-"));
    return openDatabase(join(dir, "test.db"));
  }

  it("migrates meta_schema to 27 and creates points / embeddings / state", () => {
    const db = fresh();
    const version = (db.prepare(
      "SELECT version FROM meta_schema WHERE id = 1"
    ).get() as { version: number }).version;
    // fresh DB migrates to the latest version; v27 created the cosmos tables
    expect(version).toBe(39);

    const tables = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='table'
         AND name IN ('work_cosmos_points', 'work_cosmos_embeddings', 'work_cosmos_state')
         ORDER BY name`
      )
      .all() as { name: string }[];
    expect(tables.map((t) => t.name)).toEqual([
      "work_cosmos_embeddings",
      "work_cosmos_points",
      "work_cosmos_state",
    ]);
  });

  it("rejects unknown source value", () => {
    const db = fresh();
    expect(() =>
      db
        .prepare(
          `INSERT INTO work_cosmos_points
             (session_id, source, source_path, source_mtime_ms, source_size_bytes,
              project_key, project_path, total_tokens,
              token_status, embedding_status, source_seen_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          "s1",
          "cursor", // not in ('claude', 'codex')
          "/tmp/s1",
          0,
          0,
          "pk",
          "/tmp",
          0,
          "full",
          "pending",
          "now",
          "now"
        )
    ).toThrow(/CHECK constraint/);
  });

  it("rejects unknown embedding_status value", () => {
    const db = fresh();
    expect(() =>
      db
        .prepare(
          `INSERT INTO work_cosmos_points
             (session_id, source, source_path, source_mtime_ms, source_size_bytes,
              project_key, project_path, total_tokens,
              token_status, embedding_status, source_seen_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          "s1",
          "claude",
          "/tmp/s1",
          0,
          0,
          "pk",
          "/tmp",
          0,
          "full",
          "bogus",
          "now",
          "now"
        )
    ).toThrow(/CHECK constraint/);
  });

  it("cascade-deletes embeddings when a point is deleted", () => {
    const db = fresh();
    db.prepare(
      `INSERT INTO work_cosmos_points
         (session_id, source, source_path, source_mtime_ms, source_size_bytes,
          project_key, project_path, total_tokens,
          token_status, embedding_status, source_seen_at, updated_at)
       VALUES (?, 'claude', ?, 0, 0, 'pk', '/tmp', 0, 'full', 'ok', 'now', 'now')`
    ).run("s1", "/tmp/s1");

    db.prepare(
      `INSERT INTO work_cosmos_embeddings
         (session_id, embedding_dim, vector, summary, updated_at)
       VALUES (?, ?, ?, ?, ?)`
    ).run("s1", 4, Buffer.alloc(16), "summary text", "now");

    expect(
      (db.prepare("SELECT COUNT(*) AS c FROM work_cosmos_embeddings").get() as {
        c: number;
      }).c
    ).toBe(1);

    db.prepare("DELETE FROM work_cosmos_points WHERE session_id = 's1'").run();

    expect(
      (db.prepare("SELECT COUNT(*) AS c FROM work_cosmos_embeddings").get() as {
        c: number;
      }).c
    ).toBe(0);
  });

  it("state table is singleton (id=1 only)", () => {
    const db = fresh();
    db.prepare(
      `INSERT INTO work_cosmos_state
         (id, rule_version, source_session_count, indexed_session_count,
          embedded_session_count, no_summary_session_count, error_session_count,
          skipped_unchanged_count, projection_method, projected_session_count,
          updated_at)
       VALUES (1, 1, 0, 0, 0, 0, 0, 0, 'none', 0, 'now')`
    ).run();
    expect(() =>
      db
        .prepare(
          `INSERT INTO work_cosmos_state
             (id, rule_version, source_session_count, indexed_session_count,
              embedded_session_count, no_summary_session_count, error_session_count,
              skipped_unchanged_count, projection_method, projected_session_count,
              updated_at)
           VALUES (2, 1, 0, 0, 0, 0, 0, 0, 'none', 0, 'now')`
        )
        .run()
    ).toThrow(/CHECK constraint/);
  });
});
