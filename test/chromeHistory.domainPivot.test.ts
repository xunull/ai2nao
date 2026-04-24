import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import {
  getChromeHistoryDomainStatus,
  getChromeHistoryDomainSummary,
  getChromeHistoryDomainTimeline,
  listChromeHistoryDomainVisits,
  rebuildChromeHistoryVisitDomains,
} from "../src/chromeHistory/domainPivot.js";
import { openDatabase } from "../src/store/open.js";

function freshDb(): Database.Database {
  const base = join(tmpdir(), `ai2nao-domain-${Date.now()}-${Math.random()}`);
  mkdirSync(base, { recursive: true });
  return openDatabase(join(base, "idx.db"));
}

function insertVisit(
  db: Database.Database,
  row: {
    id: number;
    sourceId?: string;
    profile?: string;
    url: string;
    title?: string;
    visitTime?: number;
    day: string;
  }
): void {
  const profile = row.profile ?? "Default";
  const sourceId = row.sourceId ?? "legacy";
  const visitTime = row.visitTime ?? row.id;
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
    ) VALUES (?, ?, ?, ?, ?, ?, NULL, 0, NULL, 0, ?, ?)`
  ).run(
    row.id,
    profile,
    sourceId,
    `${sourceId}:${row.id}:${row.url}`,
    row.id,
    visitTime,
    row.day,
    "now"
  );
}

describe("Chrome History domain pivot", () => {
  it("rebuilds derived rows, defaults analytics to web URLs, and reports fresh", () => {
    const db = freshDb();
    try {
      insertVisit(db, {
        id: 1,
        url: "https://www.example.com/a",
        title: "Example A",
        day: "2026-04-01",
      });
      insertVisit(db, {
        id: 2,
        url: "chrome://history",
        title: "Chrome History",
        day: "2026-04-01",
      });
      const result = rebuildChromeHistoryVisitDomains(db, "Default");
      expect(result).toMatchObject({ ok: true, sourceVisitCount: 2, derivedVisitCount: 2 });

      const summary = getChromeHistoryDomainSummary(db, { profile: "Default" });
      expect(summary).toEqual({
        unique_domains: 1,
        total_visits: 1,
        top_domain: { domain: "example.com", count: 1 },
      });

      const status = getChromeHistoryDomainStatus(db, "Default");
      expect(status.fresh).toBe(true);
      expect(status.staleReasons).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("marks the projection stale when source visit counts change", () => {
    const db = freshDb();
    try {
      insertVisit(db, { id: 1, url: "https://a.test", day: "2026-04-01" });
      rebuildChromeHistoryVisitDomains(db, "Default");
      insertVisit(db, { id: 2, url: "https://b.test", day: "2026-04-02" });

      const status = getChromeHistoryDomainStatus(db, "Default");
      expect(status.fresh).toBe(false);
      expect(status.staleReasons).toContain("source_count_changed");
      expect(status.staleReasons).toContain("source_derived_count_mismatch");
    } finally {
      db.close();
    }
  });

  it("uses half-open date ranges and dense timeline cells", () => {
    const db = freshDb();
    try {
      insertVisit(db, { id: 1, url: "https://a.test/1", day: "2026-04-01" });
      insertVisit(db, { id: 2, url: "https://a.test/2", day: "2026-04-02" });
      insertVisit(db, { id: 3, url: "https://b.test/1", day: "2026-04-02" });
      insertVisit(db, { id: 4, url: "https://b.test/2", day: "2026-04-03" });
      rebuildChromeHistoryVisitDomains(db, "Default");

      const timeline = getChromeHistoryDomainTimeline(db, {
        profile: "Default",
        from: "2026-04-01",
        to: "2026-04-03",
        domains: ["a.test", "b.test"],
      });
      expect(timeline.xs).toEqual(["2026-04-01", "2026-04-02"]);
      expect(timeline.ys).toEqual(["a.test", "b.test"]);
      expect(timeline.cells).toEqual([
        [1, 1],
        [0, 1],
      ]);

      const visits = listChromeHistoryDomainVisits(db, {
        profile: "Default",
        from: "2026-04-02",
        to: "2026-04-03",
        domain: "b.test",
      });
      expect(visits.items).toHaveLength(1);
      expect(visits.items[0].url).toBe("https://b.test/1");
    } finally {
      db.close();
    }
  });

  it("records rebuild errors in state without requiring raw data rollback", () => {
    const db = freshDb();
    try {
      insertVisit(db, { id: 1, url: "https://a.test", day: "2026-04-01" });
      db.exec("DROP TABLE chrome_history_visit_domains");

      const result = rebuildChromeHistoryVisitDomains(db, "Default");
      expect(result.ok).toBe(false);
      const state = db
        .prepare("SELECT last_error FROM chrome_history_domain_state WHERE profile = ?")
        .get("Default") as { last_error: string };
      expect(state.last_error).toContain("chrome_history_visit_domains");
    } finally {
      db.close();
    }
  });
});
