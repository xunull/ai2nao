import type Database from "better-sqlite3";

export type ChromeHistoryMonthDay = { day: string; count: number };

export type ChromeHistoryDayRow = {
  visit_id: number;
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
              v.visit_time AS visit_time, v.transition AS transition,
              v.calendar_day AS calendar_day, v.inserted_at AS inserted_at
       FROM chrome_history_visits v
       INNER JOIN chrome_history_urls u
         ON u.profile = v.profile AND u.id = v.url_id
       WHERE v.profile = ? AND v.calendar_day = ?
       ORDER BY v.visit_time DESC`
    )
    .all(profile, date) as ChromeHistoryDayRow[];
}

export function maxMirroredVisitId(
  db: Database.Database,
  profile: string
): number {
  const row = db
    .prepare(
      `SELECT COALESCE(MAX(id), 0) AS m FROM chrome_history_visits WHERE profile = ?`
    )
    .get(profile) as { m: number };
  return row.m;
}
