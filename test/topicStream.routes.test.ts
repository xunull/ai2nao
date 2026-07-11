import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/serve/app.js";
import { openDatabase } from "../src/store/open.js";
import { rebuildChromeTopicStream } from "../src/topicStream/rebuild.js";

function freshDb(): Database.Database {
  const base = join(tmpdir(), `ai2nao-topic-routes-${Date.now()}-${Math.random()}`);
  mkdirSync(base, { recursive: true });
  return openDatabase(join(base, "idx.db"));
}

function insertVisit(db: Database.Database, id: number, url: string, day: string): void {
  db.prepare(
    `INSERT INTO chrome_history_urls (
      id, profile, source_id, url, title, visit_count, typed_count,
      last_visit_time, hidden, inserted_at
    ) VALUES (?, 'Default', 'legacy', ?, ?, 1, 0, ?, 0, 'now')`
  ).run(id, url, url, id);
  db.prepare(
    `INSERT INTO chrome_history_visits (
      id, profile, source_id, content_key, url_id, visit_time, from_visit,
      transition, segment_id, visit_duration, calendar_day, inserted_at
    ) VALUES (?, 'Default', 'legacy', ?, ?, ?, NULL, 0, NULL, 0, ?, 'now')`
  ).run(id, `legacy:${id}:${url}`, id, id, day);
}

/** Sum a matrix into { [category]: total } to avoid asserting ys sort order. */
function totals(m: { ys: string[]; cells: number[][] }): Record<string, number> {
  const out: Record<string, number> = {};
  m.ys.forEach((y, i) => {
    out[y] = m.cells[i].reduce((a, b) => a + b, 0);
  });
  return out;
}

describe("topic stream API (Stage 1)", () => {
  it("serves a category x time matrix after a CLI-style rebuild", async () => {
    const db = freshDb();
    try {
      insertVisit(db, 1, "https://github.com/a", "2026-04-01");
      insertVisit(db, 2, "https://github.com/b", "2026-04-01");
      insertVisit(db, 3, "https://huggingface.co/m", "2026-04-01");
      insertVisit(db, 4, "https://vercel.com/y", "2026-04-02");
      rebuildChromeTopicStream(db, "Default");
      const app = createApp({ db });

      const res = await app.request(
        "http://x/api/topics/stream?source=chrome&from=2026-04-01&to=2026-04-03&grain=day"
      );
      expect(res.status).toBe(200);
      const json = (await res.json()) as {
        xs: string[];
        ys: string[];
        cells: number[][];
        status: { fresh: boolean };
      };
      expect(json.xs).toEqual(["2026-04-01", "2026-04-02"]);
      expect(totals(json)).toEqual({ 社区: 2, "AI·ML": 1, "工具·云控制台": 1 });
      expect(json.ys[0]).toBe("社区"); // highest total sorts first
      expect(json.status.fresh).toBe(true);
    } finally {
      db.close();
    }
  });

  it("drills a category × bucket down to the pages behind it", async () => {
    const db = freshDb();
    try {
      insertVisit(db, 1, "https://github.com/a", "2026-04-01");
      insertVisit(db, 2, "https://github.com/b", "2026-04-01");
      insertVisit(db, 3, "https://vercel.com/y", "2026-04-02");
      rebuildChromeTopicStream(db, "Default");
      const app = createApp({ db });

      const res = await app.request(
        "http://x/api/topics/stream/drilldown?source=chrome&category=" +
          encodeURIComponent("社区") +
          "&bucket=2026-04-01&grain=day"
      );
      expect(res.status).toBe(200);
      const json = (await res.json()) as {
        items: { url: string; category: string; event_time_unix_ms: number }[];
        next_cursor: string | null;
      };
      expect(json.items).toHaveLength(2);
      expect(json.items.every((i) => i.category === "社区")).toBe(true);
      expect(json.items.every((i) => i.url.startsWith("https://github.com/"))).toBe(true);
      expect(typeof json.items[0].event_time_unix_ms).toBe("number");

      // missing category → 400
      const bad = await app.request("http://x/api/topics/stream/drilldown?bucket=2026-04-01");
      expect(bad.status).toBe(400);
    } finally {
      db.close();
    }
  });

  it("returns an empty matrix (200) when a profile has no data", async () => {
    const db = freshDb();
    try {
      const app = createApp({ db });
      const res = await app.request("http://x/api/topics/stream?profile=Nobody");
      expect(res.status).toBe(200);
      const json = (await res.json()) as { xs: unknown[]; ys: unknown[]; cells: unknown[] };
      expect(json.xs).toEqual([]);
      expect(json.ys).toEqual([]);
      expect(json.cells).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("rejects an unknown source with 400", async () => {
    const db = freshDb();
    try {
      const app = createApp({ db });
      const res = await app.request("http://x/api/topics/stream?source=shell");
      expect(res.status).toBe(400);
    } finally {
      db.close();
    }
  });

  it("serves the taxonomy legend including the 其他 fallback", async () => {
    const db = freshDb();
    try {
      const app = createApp({ db });
      const res = await app.request("http://x/api/topics/categories");
      expect(res.status).toBe(200);
      const json = (await res.json()) as { categories: { name: string; color: string }[] };
      const names = json.categories.map((c) => c.name);
      expect(names).toContain("社区");
      expect(names).toContain("其他");
      expect(names[names.length - 1]).toBe("其他"); // fallback appended last
    } finally {
      db.close();
    }
  });
});
