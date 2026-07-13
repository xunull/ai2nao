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
    expect(version).toBe(48);

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

  // Regression (2026-07-02): the MiniMax history opt-in column was originally
  // folded into applyV40; a dev DB that reached v40 before the column was added
  // never got it (the `if (v < 40)` guard skips a re-run), so PATCH
  // /api/providers failed with "no column named history_enabled". Splitting it
  // into v41 makes the ALTER forward-only. Assert a fully-migrated DB has it.
  it("provider_config gains history_enabled after full migration (v41)", () => {
    const db = fresh();
    const cols = db
      .prepare("PRAGMA table_info(provider_config)")
      .all() as { name: string }[];
    expect(cols.map((c) => c.name)).toContain("history_enabled");
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

/**
 * v42 regression: agent 用户消息统一库 —— 建表、source CHECK、trigram FTS 命中、
 * AFTER DELETE 触发器清 fts。设计:docs/agent-user-messages-design.md。
 */
describe("schema v42 — agent_user_messages 用户消息统一库", () => {
  function fresh() {
    const dir = mkdtempSync(join(tmpdir(), "ai2nao-aum-mig-"));
    return openDatabase(join(dir, "test.db"));
  }

  function insertRow(
    db: ReturnType<typeof openDatabase>,
    o: { source: string; cleaned: string }
  ): number {
    const info = db
      .prepare(
        `INSERT INTO agent_user_messages
           (source, source_session_id, source_message_key, event_at_utc,
            raw_text, raw_payload_json, cleaned_text, is_human, char_len,
            cleaner_version, parser_version, source_seen_at, ingested_at, updated_at)
         VALUES (?, 's1', 'm1', '2026-07-03T00:00:00Z',
            ?, '[]', ?, 1, ?, 1, 1, 'now', 'now', 'now')`
      )
      .run(o.source, o.cleaned, o.cleaned, o.cleaned.length);
    return Number(info.lastInsertRowid);
  }

  it("creates agent_user_messages + fts + sync_state on full migration (v42)", () => {
    const db = fresh();
    const tables = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='table'
         AND name IN ('agent_user_messages','agent_user_messages_fts','agent_user_messages_sync_state')
         ORDER BY name`
      )
      .all() as { name: string }[];
    expect(tables.map((t) => t.name)).toEqual([
      "agent_user_messages",
      "agent_user_messages_fts",
      "agent_user_messages_sync_state",
    ]);
  });

  it("rejects unknown source value (CHECK)", () => {
    const db = fresh();
    expect(() => insertRow(db, { source: "cursor", cleaned: "x" })).toThrow(
      /CHECK constraint/
    );
  });

  it("trigram FTS matches a >=3-char CJK substring; AFTER DELETE clears fts", () => {
    const db = fresh();
    const id = insertRow(db, { source: "opencode", cleaned: "我们讨论一下这个功能" });
    db.prepare(
      "INSERT INTO agent_user_messages_fts(rowid, cleaned_text) VALUES (?, ?)"
    ).run(id, "我们讨论一下这个功能");
    const hit = (
      db
        .prepare(
          "SELECT COUNT(*) c FROM agent_user_messages_fts WHERE cleaned_text MATCH ?"
        )
        .get('"讨论一"') as { c: number }
    ).c;
    expect(hit).toBe(1);

    db.prepare("DELETE FROM agent_user_messages WHERE id = ?").run(id);
    const after = (
      db
        .prepare(
          "SELECT COUNT(*) c FROM agent_user_messages_fts WHERE cleaned_text MATCH ?"
        )
        .get('"讨论一"') as { c: number }
    ).c;
    expect(after).toBe(0);
  });
});
