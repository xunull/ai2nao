import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../src/store/open.js";
import {
  CHROME_SOURCE,
  getTopicStreamStatus,
  rebuildChromeTopicStream,
} from "../src/topicStream/rebuild.js";

function freshDb(): Database.Database {
  const base = join(tmpdir(), `ai2nao-topic-${Date.now()}-${Math.random()}`);
  mkdirSync(base, { recursive: true });
  return openDatabase(join(base, "idx.db"));
}

function insertVisit(
  db: Database.Database,
  row: {
    id: number;
    profile?: string;
    sourceId?: string;
    url: string;
    title?: string;
    transition?: number;
    fromVisit?: number;
    day: string;
  }
): void {
  const profile = row.profile ?? "Default";
  const sourceId = row.sourceId ?? "legacy";
  const visitTime = row.id;
  db.prepare(
    `INSERT OR IGNORE INTO chrome_history_urls (
      id, profile, source_id, url, title, visit_count, typed_count,
      last_visit_time, hidden, inserted_at
    ) VALUES (?, ?, ?, ?, ?, 1, 0, ?, 0, ?)`
  ).run(row.id, profile, sourceId, row.url, row.title ?? row.url, visitTime, "now");
  db.prepare(
    `INSERT INTO chrome_history_visits (
      id, profile, source_id, content_key, url_id, visit_time, from_visit,
      transition, segment_id, visit_duration, calendar_day, inserted_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 0, ?, ?)`
  ).run(
    row.id,
    profile,
    sourceId,
    `${sourceId}:${row.id}:${row.url}`,
    row.id,
    visitTime,
    row.fromVisit ?? 0,
    row.transition ?? 0,
    row.day,
    "now"
  );
}

function categoryOf(db: Database.Database, profile: string): Record<string, number> {
  const rows = db
    .prepare(
      `SELECT category, COUNT(*) AS c FROM topic_stream
       WHERE source = ? AND profile = ? GROUP BY category`
    )
    .all(CHROME_SOURCE, profile) as { category: string; c: number }[];
  return Object.fromEntries(rows.map((r) => [r.category, r.c]));
}

describe("topicStream rebuild (chrome adapter, Stage 1)", () => {
  it("classifies web visits per-visit and reports a diagnostic", () => {
    const db = freshDb();
    try {
      insertVisit(db, { id: 1, url: "https://github.com/x", title: "x", day: "2026-04-01" });
      insertVisit(db, { id: 2, url: "https://huggingface.co/m", title: "m", day: "2026-04-01" });
      insertVisit(db, {
        id: 3,
        url: "https://random-corp.example/q",
        title: "quarterly",
        day: "2026-04-02",
      });
      const result = rebuildChromeTopicStream(db, "Default");
      expect(result.ok).toBe(true);
      expect(result.derivedCount).toBe(3);
      expect(categoryOf(db, "Default")).toEqual({ 社区: 1, "AI·ML": 1, 其他: 1 });
      expect(result.diagnostic?.other_share).toBeCloseTo(1 / 3, 5);
      expect(result.diagnostic?.top_unmatched_domains).toEqual([
        { domain: "random-corp.example", count: 1 },
      ]);
    } finally {
      db.close();
    }
  });

  it("labels a whole research session by its anchor category (sessionization)", () => {
    const db = freshDb();
    try {
      // A session: typed github search (社区) → clicked a random blog → stackoverflow.
      insertVisit(db, { id: 1, url: "https://github.com/search?q=x", transition: 1, fromVisit: 0, day: "2026-04-01" });
      insertVisit(db, { id: 2, url: "https://random-blog.example/post", transition: 0, fromVisit: 1, day: "2026-04-01" });
      insertVisit(db, { id: 3, url: "https://stackoverflow.com/q/1", transition: 0, fromVisit: 2, day: "2026-04-01" });
      const result = rebuildChromeTopicStream(db, "Default");
      expect(result.ok).toBe(true);
      // All three inherit the anchor (github, 社区) — including the blog that
      // alone would be 其他.
      expect(categoryOf(db, "Default")).toEqual({ 社区: 3 });
      const sessions = db
        .prepare(`SELECT DISTINCT session_id FROM topic_stream WHERE profile='Default'`)
        .all() as { session_id: string }[];
      expect(sessions).toHaveLength(1); // one session
    } finally {
      db.close();
    }
  });

  it("drops non-web url kinds and transition noise (RELOAD / FORWARD_BACK)", () => {
    const db = freshDb();
    try {
      insertVisit(db, { id: 1, url: "https://github.com/a", title: "a", day: "2026-04-01" });
      insertVisit(db, { id: 2, url: "chrome://history", title: "h", day: "2026-04-01" }); // non-web
      insertVisit(db, {
        id: 3,
        url: "https://github.com/b",
        title: "b",
        transition: 8, // RELOAD
        day: "2026-04-01",
      });
      insertVisit(db, {
        id: 4,
        url: "https://github.com/c",
        title: "c",
        transition: 0x01000000, // FORWARD_BACK
        day: "2026-04-01",
      });
      const result = rebuildChromeTopicStream(db, "Default");
      expect(result.sourceCount).toBe(4);
      expect(result.derivedCount).toBe(1); // only visit 1 kept
      expect(result.diagnostic?.filtered_non_web).toBe(1);
      expect(result.diagnostic?.filtered_transition).toEqual({ reload: 1, link: 1 });
    } finally {
      db.close();
    }
  });

  it("is idempotent: rebuilding twice yields identical rows", () => {
    const db = freshDb();
    try {
      insertVisit(db, { id: 1, url: "https://github.com/x", title: "x", day: "2026-04-01" });
      insertVisit(db, { id: 2, url: "https://vercel.com/y", title: "y", day: "2026-04-02" });
      const first = rebuildChromeTopicStream(db, "Default");
      const rowsA = db
        .prepare(`SELECT source_ref, category, calendar_day FROM topic_stream ORDER BY source_ref`)
        .all();
      const second = rebuildChromeTopicStream(db, "Default");
      const rowsB = db
        .prepare(`SELECT source_ref, category, calendar_day FROM topic_stream ORDER BY source_ref`)
        .all();
      expect(first.derivedCount).toBe(second.derivedCount);
      expect(rowsA).toEqual(rowsB);
    } finally {
      db.close();
    }
  });

  it("isolates profiles: rebuilding one profile does not touch another", () => {
    const db = freshDb();
    try {
      insertVisit(db, { id: 1, profile: "Default", url: "https://github.com/x", day: "2026-04-01" });
      insertVisit(db, { id: 1, profile: "Profile 1", url: "https://vercel.com/y", day: "2026-04-01" });
      rebuildChromeTopicStream(db, "Default");
      rebuildChromeTopicStream(db, "Profile 1");
      expect(categoryOf(db, "Default")).toEqual({ 社区: 1 });
      expect(categoryOf(db, "Profile 1")).toEqual({ "工具·云控制台": 1 });
      // Rebuilding Default again must leave Profile 1 rows intact.
      rebuildChromeTopicStream(db, "Default");
      expect(categoryOf(db, "Profile 1")).toEqual({ "工具·云控制台": 1 });
    } finally {
      db.close();
    }
  });

  it("reports fresh status right after a rebuild", () => {
    const db = freshDb();
    try {
      insertVisit(db, { id: 1, url: "https://github.com/x", day: "2026-04-01" });
      rebuildChromeTopicStream(db, "Default");
      const status = getTopicStreamStatus(db, CHROME_SOURCE, "Default");
      expect(status.fresh).toBe(true);
      expect(status.staleReasons).toEqual([]);
      expect(status.currentDerivedCount).toBe(1);
    } finally {
      db.close();
    }
  });
});
