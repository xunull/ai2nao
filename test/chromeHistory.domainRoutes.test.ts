import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/serve/app.js";
import { openDatabase } from "../src/store/open.js";

function freshDb(): Database.Database {
  const base = join(tmpdir(), `ai2nao-domain-routes-${Date.now()}-${Math.random()}`);
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

describe("Chrome History domain API", () => {
  it("rebuilds and serves summary, timeline, and drilldown visits", async () => {
    const db = freshDb();
    try {
      insertVisit(db, 1, "https://www.example.com/a", "2026-04-01");
      insertVisit(db, 2, "https://example.com/b", "2026-04-02");
      insertVisit(db, 3, "chrome://history", "2026-04-02");
      const app = createApp({ db });

      const rebuild = await app.request("http://x/api/chrome-history/domains/rebuild", {
        method: "POST",
        body: JSON.stringify({ profile: "Default" }),
        headers: { "content-type": "application/json" },
      });
      expect(rebuild.status).toBe(200);
      const rebuildJson = (await rebuild.json()) as { ok: boolean };
      expect(rebuildJson.ok).toBe(true);

      const summary = await app.request(
        "http://x/api/chrome-history/domains/summary?from=2026-04-01&to=2026-04-03"
      );
      expect(summary.status).toBe(200);
      const summaryJson = (await summary.json()) as {
        unique_domains: number;
        total_visits: number;
      };
      expect(summaryJson).toMatchObject({ unique_domains: 1, total_visits: 2 });

      const timeline = await app.request(
        "http://x/api/chrome-history/domains/timeline?domains=example.com&from=2026-04-01&to=2026-04-03"
      );
      expect(timeline.status).toBe(200);
      const timelineJson = (await timeline.json()) as {
        xs: string[];
        ys: string[];
        cells: number[][];
      };
      expect(timelineJson.xs).toEqual(["2026-04-01", "2026-04-02"]);
      expect(timelineJson.ys).toEqual(["example.com"]);
      expect(timelineJson.cells).toEqual([[1, 1]]);

      const visits = await app.request(
        "http://x/api/chrome-history/domains/visits?domain=example.com&date=2026-04-02"
      );
      expect(visits.status).toBe(200);
      const visitsJson = (await visits.json()) as {
        items: { url: string; visit_time_unix_ms: number }[];
      };
      expect(visitsJson.items).toHaveLength(1);
      expect(visitsJson.items[0].url).toBe("https://example.com/b");
      expect(typeof visitsJson.items[0].visit_time_unix_ms).toBe("number");
    } finally {
      db.close();
    }
  });

  it("serves WeChat article visits with literal q matching", async () => {
    const db = freshDb();
    try {
      insertVisit(
        db,
        1,
        "https://mp.weixin.qq.com/s?__biz=abc&mid=1",
        "2026-04-02"
      );
      insertVisit(
        db,
        2,
        "https://mp.weixin.qq.com/s?xxbiz=abc&mid=2",
        "2026-04-02"
      );
      const app = createApp({ db });

      const rebuild = await app.request("http://x/api/chrome-history/domains/rebuild", {
        method: "POST",
        body: JSON.stringify({ profile: "Default" }),
        headers: { "content-type": "application/json" },
      });
      expect(rebuild.status).toBe(200);

      const visits = await app.request(
        "http://x/api/chrome-history/domains/visits?domain=mp.weixin.qq.com&q=__biz&from=2026-04-01&to=2026-04-03"
      );
      expect(visits.status).toBe(200);
      const visitsJson = (await visits.json()) as {
        items: { url: string }[];
      };
      expect(visitsJson.items.map((item) => item.url)).toEqual([
        "https://mp.weixin.qq.com/s?__biz=abc&mid=1",
      ]);
    } finally {
      db.close();
    }
  });
});
