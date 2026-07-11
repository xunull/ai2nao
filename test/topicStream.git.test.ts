import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../src/store/open.js";
import { getTopicStreamDrilldown } from "../src/topicStream/queries.js";
import {
  GIT_SOURCE,
  getTopicStreamStatus,
  rebuildGitTopicStream,
} from "../src/topicStream/rebuild.js";

const GIT_PROFILE = "-";

function freshDb(): Database.Database {
  const base = join(tmpdir(), `ai2nao-topicgit-${Date.now()}-${Math.random()}`);
  mkdirSync(base, { recursive: true });
  return openDatabase(join(base, "idx.db"));
}

function insertCommit(
  db: Database.Database,
  repo: string,
  hash: string,
  iso: string,
  subject?: string
): void {
  db.prepare(
    `INSERT INTO git_commits (repo_key, commit_hash, author_date_utc, subject, ingested_at)
     VALUES (?, ?, ?, ?, 'now')`
  ).run(repo, hash, iso, subject ?? null);
}

function categoryOf(db: Database.Database): Record<string, number> {
  const rows = db
    .prepare(
      `SELECT category, COUNT(*) AS c FROM topic_stream
       WHERE source = ? AND profile = ? GROUP BY category`
    )
    .all(GIT_SOURCE, GIT_PROFILE) as { category: string; c: number }[];
  return Object.fromEntries(rows.map((r) => [r.category, r.c]));
}

describe("topicStream git adapter", () => {
  it("bands commits by repo, one event per commit, source=git profile=-", () => {
    const db = freshDb();
    try {
      insertCommit(db, "ai2nao", "h1", "2026-04-15T12:00:00Z", "feat x");
      insertCommit(db, "ai2nao", "h2", "2026-04-16T12:00:00Z", "fix y");
      insertCommit(db, "wtf", "h3", "2026-04-15T12:00:00Z", "init");
      const r = rebuildGitTopicStream(db);
      expect(r).toMatchObject({ ok: true, source: "git", profile: "-", derivedCount: 3 });
      expect(categoryOf(db)).toEqual({ ai2nao: 2, wtf: 1 });

      const row = db
        .prepare(`SELECT session_id, event_time FROM topic_stream WHERE source='git' LIMIT 1`)
        .get() as { session_id: string | null; event_time: number };
      expect(row.session_id).toBeNull(); // git has no sessions
      expect(row.event_time).toBe(Date.parse("2026-04-15T12:00:00Z")); // Unix ms
    } finally {
      db.close();
    }
  });

  it("folds repos beyond Top-N into 其他", () => {
    const db = freshDb();
    try {
      // ai2nao gets 5 commits; r1..r14 get 1 each => 15 repos total.
      for (let i = 0; i < 5; i++) {
        insertCommit(db, "ai2nao", `a${i}`, "2026-04-15T12:00:00Z");
      }
      for (let i = 1; i <= 14; i++) {
        insertCommit(db, `r${i}`, `c${i}`, "2026-04-15T12:00:00Z");
      }
      rebuildGitTopicStream(db);
      const cats = categoryOf(db);
      // 12 top bands (ai2nao + 11 single-commit repos) + 其他.
      expect(Object.keys(cats)).toHaveLength(13);
      expect(cats["ai2nao"]).toBe(5);
      // 3 repos folded (14 - 11) => 其他 = 3.
      expect(cats["其他"]).toBe(3);
    } finally {
      db.close();
    }
  });

  it("drills a repo × bucket down to its commits", () => {
    const db = freshDb();
    try {
      insertCommit(db, "ai2nao", "h1", "2026-04-15T12:00:00Z", "feat topic river");
      insertCommit(db, "wtf", "h2", "2026-04-15T12:00:00Z", "init");
      rebuildGitTopicStream(db);
      const res = getTopicStreamDrilldown(db, {
        source: GIT_SOURCE,
        profile: GIT_PROFILE,
        category: "ai2nao",
        bucket: "2026-04",
        grain: "month",
      });
      expect(res.items).toHaveLength(1);
      expect(res.items[0].title).toBe("feat topic river"); // subject in payload
      expect(res.items[0].host).toBe("ai2nao"); // payload.host — n/a for git, but repo carried in payload

      const status = getTopicStreamStatus(db, GIT_SOURCE, GIT_PROFILE);
      expect(status.fresh).toBe(true);
    } finally {
      db.close();
    }
  });
});
