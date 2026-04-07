import type Database from "better-sqlite3";

export type AtuinDayCount = { day: string; count: number };

export type AtuinEntry = {
  id: string;
  timestamp_ns: number;
  duration: number;
  exit: number;
  command: string;
  cwd: string;
  hostname: string;
  session: string;
};

/** 本地日历日界 [startNs, endNs)，`dateStr` 为 `YYYY-MM-DD`（与 `serve` 进程时区一致）。 */
export function localDayBoundsNs(dateStr: string): [number, number] {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
  if (!m) throw new Error("invalid date");
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const start = new Date(y, mo - 1, d, 0, 0, 0, 0);
  const end = new Date(y, mo - 1, d + 1, 0, 0, 0, 0);
  return [start.getTime() * 1_000_000, end.getTime() * 1_000_000];
}

function localMonthBoundsNs(year: number, month: number): [number, number] {
  const start = new Date(year, month - 1, 1, 0, 0, 0, 0);
  const end = new Date(year, month, 1, 0, 0, 0, 0);
  return [start.getTime() * 1_000_000, end.getTime() * 1_000_000];
}

/** 指定本地月份内，按本地日历日聚合条数（不含已删除）。 */
export function listAtuinHistoryMonthCounts(
  db: Database.Database,
  year: number,
  month: number
): AtuinDayCount[] {
  if (month < 1 || month > 12) throw new Error("month out of range");
  const [startNs, endNs] = localMonthBoundsNs(year, month);
  const rows = db
    .prepare(
      `
      SELECT strftime('%Y-%m-%d', timestamp / 1000000000, 'unixepoch', 'localtime') AS day, COUNT(*) AS n
      FROM history
      WHERE deleted_at IS NULL
        AND timestamp >= ? AND timestamp < ?
      GROUP BY day
    `
    )
    .all(startNs, endNs) as { day: string; n: number }[];
  return rows.map((r) => ({ day: r.day, count: Number(r.n) }));
}

const DAY_LIST_LIMIT = 10_000;

/** 某一本地日内的历史记录，新到旧。 */
export function listAtuinHistoryForDay(
  db: Database.Database,
  dateStr: string
): AtuinEntry[] {
  const [startNs, endNs] = localDayBoundsNs(dateStr);
  const rows = db
    .prepare(
      `
      SELECT id, timestamp AS timestamp_ns, duration, exit, command, cwd, hostname, session
      FROM history
      WHERE deleted_at IS NULL
        AND timestamp >= ? AND timestamp < ?
      ORDER BY timestamp DESC
      LIMIT ?
    `
    )
    .all(startNs, endNs, DAY_LIST_LIMIT) as AtuinEntry[];
  return rows;
}
