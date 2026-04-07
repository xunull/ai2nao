import type Database from "better-sqlite3";
import { openDatabase } from "../store/open.js";
import type { DailySummaryPayload } from "./types.js";

export function openDailySummaryCacheDatabase(dbPath: string): Database.Database {
  const db = openDatabase(dbPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS daily_summary_cache (
      cache_key TEXT PRIMARY KEY,
      date TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS daily_summary_cache_date_idx
      ON daily_summary_cache(date, updated_at DESC);
  `);
  return db;
}

export function getCachedDailySummary(
  db: Database.Database,
  cacheKey: string
): DailySummaryPayload | null {
  const row = db
    .prepare(
      `
      SELECT payload_json
      FROM daily_summary_cache
      WHERE cache_key = ?
    `
    )
    .get(cacheKey) as { payload_json: string } | undefined;
  if (!row) return null;
  try {
    return JSON.parse(row.payload_json) as DailySummaryPayload;
  } catch {
    return null;
  }
}

export function putCachedDailySummary(
  db: Database.Database,
  date: string,
  cacheKey: string,
  payload: DailySummaryPayload
): void {
  db.prepare(
    `
    INSERT INTO daily_summary_cache (cache_key, date, payload_json, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(cache_key) DO UPDATE SET
      payload_json = excluded.payload_json,
      updated_at = excluded.updated_at
  `
  ).run(cacheKey, date, JSON.stringify(payload), new Date().toISOString());
}

