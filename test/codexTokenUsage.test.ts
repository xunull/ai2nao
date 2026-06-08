import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { refreshCodexTokenUsage } from "../src/codexTokenUsage/refresh.js";
import {
  getCodexTokenUsageStatus,
  listCodexProjectTokenUsage,
} from "../src/codexTokenUsage/queries.js";
import { openDatabase } from "../src/store/open.js";

function makeFixture() {
  const base = join(tmpdir(), `ai2nao-codex-token-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const codexRoot = join(base, "codex");
  const sessions = join(codexRoot, "sessions", "2026", "04", "26");
  mkdirSync(sessions, { recursive: true });
  const indexDb = openDatabase(join(base, "index.db"));
  return { base, codexRoot, sessions, indexDb };
}

function transcript(input: number, output: number, cwd = "/work/app") {
  return [
    JSON.stringify({ type: "session_meta", timestamp: "2026-04-26T00:00:00.000Z", payload: { cwd } }),
    JSON.stringify({ type: "event_msg", timestamp: "2026-04-26T00:00:01.000Z", payload: { type: "user_message", message: "hello" } }),
    JSON.stringify({ type: "event_msg", timestamp: "2026-04-26T00:00:02.000Z", payload: { type: "token_count", input_tokens: input, output_tokens: output } }),
  ].join("\n");
}

function createStateDb(codexRoot: string, rows: { id: string; rolloutPath: string; cwd?: string }[]) {
  const db = new Database(join(codexRoot, "state_5.sqlite"));
  db.exec(`
    CREATE TABLE threads (
      id TEXT PRIMARY KEY,
      rollout_path TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      cwd TEXT NOT NULL,
      title TEXT NOT NULL,
      archived INTEGER NOT NULL DEFAULT 0,
      git_branch TEXT,
      model TEXT,
      first_user_message TEXT NOT NULL DEFAULT '',
      created_at_ms INTEGER,
      updated_at_ms INTEGER
    );
  `);
  const stmt = db.prepare(`
    INSERT INTO threads (
      id, rollout_path, created_at, updated_at, cwd, title, archived,
      git_branch, model, first_user_message, created_at_ms, updated_at_ms
    ) VALUES (?, ?, 1, 2, ?, ?, 0, 'main', 'gpt-5', 'hello', ?, ?)
  `);
  for (const row of rows) {
    stmt.run(
      row.id,
      row.rolloutPath,
      row.cwd ?? "/work/app",
      row.id,
      Date.parse("2026-04-26T00:00:00.000Z"),
      Date.parse("2026-04-26T00:00:02.000Z")
    );
  }
  db.close();
}

describe("codex token usage refresh", () => {
  it("indexes all SQLite threads and aggregates token usage by project", async () => {
    const { codexRoot, sessions, indexDb } = makeFixture();
    try {
      const id1 = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
      const id2 = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
      const path1 = join(sessions, `rollout-2026-04-26T00-00-00-${id1}.jsonl`);
      const path2 = join(sessions, `rollout-2026-04-26T00-00-01-${id2}.jsonl`);
      writeFileSync(path1, transcript(10, 5), "utf8");
      writeFileSync(path2, transcript(20, 7), "utf8");
      createStateDb(codexRoot, [
        { id: id1, rolloutPath: path1 },
        { id: id2, rolloutPath: path2 },
      ]);

      const result = await refreshCodexTokenUsage(indexDb, { codexRoot });
      expect(result).toMatchObject({
        status: "success",
        source: "sqlite",
        sourceSessionCount: 2,
        indexedSessionCount: 2,
        tokenKnownSessionCount: 2,
      });
      const usage = listCodexProjectTokenUsage(indexDb, {
        projectKeys: ["/work/app"],
        from: null,
      }).get("/work/app");
      expect(usage).toMatchObject({
        inputTokens: 30,
        outputTokens: 12,
        totalTokens: 42,
        coveredSessions: 2,
        totalSessions: 2,
        coverage: "full",
      });
      expect(getCodexTokenUsageStatus(indexDb).fresh).toBe(true);
    } finally {
      indexDb.close();
    }
  });

  it("skips unchanged transcripts and reparses changed files", async () => {
    const { codexRoot, sessions, indexDb } = makeFixture();
    try {
      const id = "cccccccc-cccc-cccc-cccc-cccccccccccc";
      const path = join(sessions, `rollout-2026-04-26T00-00-00-${id}.jsonl`);
      writeFileSync(path, transcript(10, 5), "utf8");
      createStateDb(codexRoot, [{ id, rolloutPath: path }]);

      await refreshCodexTokenUsage(indexDb, { codexRoot });
      const skipped = await refreshCodexTokenUsage(indexDb, { codexRoot });
      expect(skipped.skippedUnchangedCount).toBe(1);

      writeFileSync(path, transcript(30, 9) + "\n", "utf8");
      const reparsed = await refreshCodexTokenUsage(indexDb, { codexRoot });
      expect(reparsed.skippedUnchangedCount).toBe(0);
      const usage = listCodexProjectTokenUsage(indexDb, {
        projectKeys: ["/work/app"],
        from: null,
      }).get("/work/app");
      expect(usage).toMatchObject({ inputTokens: 30, outputTokens: 9 });
    } finally {
      indexDb.close();
    }
  });

  it("marks sessions without token_count as unknown instead of estimating", async () => {
    const { codexRoot, sessions, indexDb } = makeFixture();
    try {
      const id = "dddddddd-dddd-dddd-dddd-dddddddddddd";
      const path = join(sessions, `rollout-2026-04-26T00-00-00-${id}.jsonl`);
      writeFileSync(
        path,
        [
          JSON.stringify({ type: "session_meta", timestamp: "2026-04-26T00:00:00.000Z", payload: { cwd: "/work/app" } }),
          JSON.stringify({ type: "event_msg", timestamp: "2026-04-26T00:00:01.000Z", payload: { type: "user_message", message: "hello" } }),
        ].join("\n"),
        "utf8"
      );
      createStateDb(codexRoot, [{ id, rolloutPath: path }]);

      await refreshCodexTokenUsage(indexDb, { codexRoot });
      const usage = listCodexProjectTokenUsage(indexDb, {
        projectKeys: ["/work/app"],
        from: null,
      }).get("/work/app");
      expect(usage).toMatchObject({
        inputTokens: 0,
        outputTokens: 0,
        coveredSessions: 0,
        totalSessions: 1,
        coverage: "unknown",
      });
    } finally {
      indexDb.close();
    }
  });
});
