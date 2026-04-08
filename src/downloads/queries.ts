import type Database from "better-sqlite3";

export type DownloadMonthDay = { day: string; count: number };

export type DownloadDayRow = {
  id: number;
  root_path: string;
  rel_path: string;
  file_birthtime_ms: number;
  file_mtime_ms: number | null;
  size_bytes: number | null;
  calendar_day: string;
  inserted_at: string;
};

export function listDownloadsMonthCounts(
  db: Database.Database,
  year: number,
  month: number
): DownloadMonthDay[] {
  const prefix = `${year}-${String(month).padStart(2, "0")}-`;
  const rows = db
    .prepare(
      `SELECT calendar_day AS day, COUNT(*) AS count
       FROM download_files
       WHERE calendar_day LIKE ?
       GROUP BY calendar_day
       ORDER BY calendar_day`
    )
    .all(`${prefix}%`) as { day: string; count: number }[];
  return rows.map((r) => ({ day: r.day, count: r.count }));
}

export function listDownloadsForDay(
  db: Database.Database,
  date: string
): DownloadDayRow[] {
  return db
    .prepare(
      `SELECT id, root_path, rel_path, file_birthtime_ms, file_mtime_ms, size_bytes,
              calendar_day, inserted_at
       FROM download_files
       WHERE calendar_day = ?
       ORDER BY root_path, rel_path`
    )
    .all(date) as DownloadDayRow[];
}

export function countDownloadFiles(db: Database.Database): number {
  const row = db
    .prepare("SELECT COUNT(*) AS n FROM download_files")
    .get() as { n: number };
  return row.n;
}
