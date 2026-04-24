import { mkdirSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { listChromeHistoryForDay } from "../src/chromeHistory/queries.js";
import { syncChromeHistory } from "../src/chromeHistory/sync.js";
import { calendarDayLocalFromChromeUs } from "../src/chromeHistory/time.js";
import { openDatabase } from "../src/store/open.js";

function createChromeHistory(path: string, rows: { id: number; url: string; visitUs: number }[]) {
  const db = new Database(path);
  db.exec(`
    CREATE TABLE urls (
      id INTEGER PRIMARY KEY,
      url LONGVARCHAR NOT NULL,
      title LONGVARCHAR,
      visit_count INTEGER DEFAULT 0 NOT NULL,
      typed_count INTEGER DEFAULT 0 NOT NULL,
      last_visit_time INTEGER DEFAULT 0 NOT NULL,
      hidden INTEGER DEFAULT 0 NOT NULL
    );
    CREATE TABLE visits (
      id INTEGER PRIMARY KEY,
      url INTEGER NOT NULL,
      visit_time INTEGER NOT NULL,
      from_visit INTEGER,
      transition INTEGER DEFAULT 0 NOT NULL,
      segment_id INTEGER,
      visit_duration INTEGER DEFAULT 0 NOT NULL
    );
    CREATE TABLE downloads (
      id INTEGER PRIMARY KEY,
      guid VARCHAR,
      current_path LONGVARCHAR,
      target_path LONGVARCHAR,
      start_time INTEGER NOT NULL,
      end_time INTEGER,
      received_bytes INTEGER,
      total_bytes INTEGER,
      state INTEGER,
      danger_type INTEGER,
      interrupt_reason INTEGER,
      mime_type VARCHAR,
      referrer VARCHAR,
      site_url LONGVARCHAR,
      tab_url LONGVARCHAR,
      tab_referrer_url LONGVARCHAR
    );
  `);

  const insUrl = db.prepare(
    `INSERT INTO urls (id, url, title, visit_count, typed_count, last_visit_time, hidden)
     VALUES (?, ?, ?, 1, 0, ?, 0)`
  );
  const insVisit = db.prepare(
    `INSERT INTO visits (id, url, visit_time, from_visit, transition, segment_id, visit_duration)
     VALUES (?, ?, ?, NULL, 805306368, NULL, 0)`
  );

  for (const row of rows) {
    insUrl.run(row.id, row.url, row.url, row.visitUs);
    insVisit.run(row.id, row.id, row.visitUs);
  }
  db.close();
}

describe("chrome history sync", () => {
  it("starts a new source_id when Chrome History ids reset", () => {
    const base = join(tmpdir(), `ai2nao-chrome-reset-${Date.now()}`);
    mkdirSync(base, { recursive: true });
    const historyPath = join(base, "History");
    const indexPath = join(base, "index.db");
    const profile = "Default";
    const webkitEpochMs = Date.UTC(1601, 0, 1);
    const firstUs = Math.round((Date.UTC(2026, 0, 9, 1) - webkitEpochMs) * 1000);
    const secondUs = Math.round((Date.UTC(2026, 3, 24, 9) - webkitEpochMs) * 1000);

    createChromeHistory(historyPath, [
      { id: 100, url: "https://example.com/old", visitUs: firstUs },
    ]);

    const db = openDatabase(indexPath);
    try {
      const first = syncChromeHistory(db, historyPath, profile, { verbose: true });
      expect(first.insertedVisits).toBe(1);
      expect(first.debug?.sourceResetDetected).toBe(false);

      unlinkSync(historyPath);
      createChromeHistory(historyPath, [
        { id: 1, url: "https://example.com/new", visitUs: secondUs },
      ]);

      const second = syncChromeHistory(db, historyPath, profile, { verbose: true });
      expect(second.insertedVisits).toBe(1);
      expect(second.debug?.sourceResetDetected).toBe(true);
      expect(second.debug?.currentSourceId).not.toBe("legacy");

      const full = syncChromeHistory(db, historyPath, profile, {
        full: true,
        verbose: true,
      });
      expect(full.insertedVisits).toBe(0);
      expect(full.skippedVisits).toBe(1);

      const oldRows = listChromeHistoryForDay(
        db,
        calendarDayLocalFromChromeUs(firstUs),
        profile
      );
      const newRows = listChromeHistoryForDay(
        db,
        calendarDayLocalFromChromeUs(secondUs),
        profile
      );

      expect(oldRows.some((r) => r.url === "https://example.com/old")).toBe(true);
      expect(newRows.some((r) => r.url === "https://example.com/new")).toBe(true);
    } finally {
      db.close();
    }
  });
});
