import type Database from "better-sqlite3";

export type ChromeHistoryMonthDay = { day: string; count: number };

export type ChromeHistoryDayRow = {
  visit_id: number;
  source_id: string;
  url_id: number;
  url: string;
  title: string | null;
  visit_time: number;
  transition: number | null;
  calendar_day: string;
  inserted_at: string;
};

export function listChromeHistoryMonthCounts(
  db: Database.Database,
  year: number,
  month: number,
  profile: string
): ChromeHistoryMonthDay[] {
  const prefix = `${year}-${String(month).padStart(2, "0")}-`;
  const rows = db
    .prepare(
      `SELECT calendar_day AS day, COUNT(*) AS count
       FROM chrome_history_visits
       WHERE profile = ? AND calendar_day LIKE ?
       GROUP BY calendar_day
       ORDER BY calendar_day`
    )
    .all(profile, `${prefix}%`) as { day: string; count: number }[];
  return rows.map((r) => ({ day: r.day, count: r.count }));
}

export function listChromeHistoryForDay(
  db: Database.Database,
  date: string,
  profile: string
): ChromeHistoryDayRow[] {
  return db
    .prepare(
      `SELECT v.id AS visit_id, v.url_id AS url_id, u.url AS url, u.title AS title,
              v.source_id AS source_id, v.visit_time AS visit_time, v.transition AS transition,
              v.calendar_day AS calendar_day, v.inserted_at AS inserted_at
       FROM chrome_history_visits v
       INNER JOIN chrome_history_urls u
         ON u.profile = v.profile AND u.source_id = v.source_id AND u.id = v.url_id
       WHERE v.profile = ? AND v.calendar_day = ?
       ORDER BY v.visit_time DESC`
    )
    .all(profile, date) as ChromeHistoryDayRow[];
}

export function maxMirroredVisitId(
  db: Database.Database,
  profile: string,
  sourceId: string
): number {
  const row = db
    .prepare(
      `SELECT COALESCE(MAX(id), 0) AS m
       FROM chrome_history_visits
       WHERE profile = ? AND source_id = ?`
    )
    .get(profile, sourceId) as { m: number };
  return row.m;
}

export function maxMirroredVisitIdForProfile(
  db: Database.Database,
  profile: string
): number {
  const row = db
    .prepare(
      `SELECT COALESCE(MAX(id), 0) AS m
       FROM chrome_history_visits
       WHERE profile = ?`
    )
    .get(profile) as { m: number };
  return row.m;
}

export type ChromeDownloadsMonthDay = { day: string; count: number };

export type ChromeDownloadDayRow = {
  download_id: number;
  source_id: string;
  guid: string | null;
  current_path: string | null;
  target_path: string | null;
  start_time: number;
  end_time: number | null;
  received_bytes: number | null;
  total_bytes: number | null;
  state: number | null;
  danger_type: number | null;
  interrupt_reason: number | null;
  mime_type: string | null;
  referrer: string | null;
  site_url: string | null;
  tab_url: string | null;
  tab_referrer_url: string | null;
  calendar_day: string;
  inserted_at: string;
};

export function listChromeDownloadsMonthCounts(
  db: Database.Database,
  year: number,
  month: number,
  profile: string
): ChromeDownloadsMonthDay[] {
  const prefix = `${year}-${String(month).padStart(2, "0")}-`;
  const rows = db
    .prepare(
      `SELECT calendar_day AS day, COUNT(*) AS count
       FROM chrome_downloads
       WHERE profile = ? AND calendar_day LIKE ?
       GROUP BY calendar_day
       ORDER BY calendar_day`
    )
    .all(profile, `${prefix}%`) as { day: string; count: number }[];
  return rows.map((r) => ({ day: r.day, count: r.count }));
}

export function listChromeDownloadsForDay(
  db: Database.Database,
  date: string,
  profile: string
): ChromeDownloadDayRow[] {
  return db
    .prepare(
      `SELECT id AS download_id, source_id, guid, current_path, target_path, start_time, end_time,
              received_bytes, total_bytes, state, danger_type, interrupt_reason,
              mime_type, referrer, site_url, tab_url, tab_referrer_url,
              calendar_day, inserted_at
       FROM chrome_downloads
       WHERE profile = ? AND calendar_day = ?
       ORDER BY
         CASE WHEN end_time IS NOT NULL AND end_time > 0 THEN end_time ELSE start_time END DESC`
    )
    .all(profile, date) as ChromeDownloadDayRow[];
}

export function maxMirroredDownloadId(
  db: Database.Database,
  profile: string,
  sourceId: string
): number {
  const row = db
    .prepare(
      `SELECT COALESCE(MAX(id), 0) AS m
       FROM chrome_downloads
       WHERE profile = ? AND source_id = ?`
    )
    .get(profile, sourceId) as { m: number };
  return row.m;
}
