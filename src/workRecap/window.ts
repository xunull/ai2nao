import { isCalendarWindow, windowToDays, type WorkRecapWindow } from "./types.js";

/**
 * Window resolution for work-recap.
 *
 * ALL boundaries are computed with the LOCAL date constructor (`new Date(y, m, d)`),
 * never by UTC arithmetic like `end - 86400000` — that breaks across DST.
 *
 * Every window is a HALF-OPEN interval `[start, end)`. `last-week` therefore ends
 * at 本周一 00:00 (which includes all of 上周日), not `23:59:59.999` — the `.999`
 * spelling silently drops the last millisecond and mismatches git's inclusive
 * `--until`.
 */
export type ResolvedWindow = { start: Date; end: Date };

/** Local midnight of the day `d` falls in. */
function startOfLocalDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/** Local midnight of the Monday of the week `d` falls in (ISO: week starts Monday). */
function startOfLocalWeek(d: Date): Date {
  const day = startOfLocalDay(d);
  // getDay(): 0=Sun..6=Sat → days since Monday
  const sinceMonday = (day.getDay() + 6) % 7;
  return new Date(day.getFullYear(), day.getMonth(), day.getDate() - sinceMonday);
}

export function resolveWindow(windowKey: WorkRecapWindow, now: Date): ResolvedWindow {
  switch (windowKey) {
    case "today":
      return { start: startOfLocalDay(now), end: now };
    case "last-week": {
      const thisMonday = startOfLocalWeek(now);
      const lastMonday = new Date(
        thisMonday.getFullYear(),
        thisMonday.getMonth(),
        thisMonday.getDate() - 7
      );
      // half-open: [上周一 00:00, 本周一 00:00) — includes all of 上周日
      return { start: lastMonday, end: thisMonday };
    }
    default: {
      // Rolling: last N×24h ending now (unchanged behaviour).
      const days = windowToDays(windowKey);
      return { start: new Date(now.getTime() - days * 86_400_000), end: now };
    }
  }
}

/** `YYYY-MM-DD` in local time (matches calendar_day / facts.dailyCounts semantics). */
export function localDayKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * ISO-8601 week key, e.g. `2026-W28`.
 *
 * The trap this exists to avoid: the ISO week-YEAR is not `getFullYear()`.
 * 2026-12-28 belongs to **2027-W01**, not 2026-W53. Using the calendar year
 * would collide keys across the year boundary (and the push log's PK is
 * (kind, period_key)).
 */
export function isoWeekKey(d: Date): string {
  // Shift to the Thursday of this ISO week: the ISO week-year is that Thursday's year.
  const day = startOfLocalDay(d);
  const sinceMonday = (day.getDay() + 6) % 7;
  const thursday = new Date(
    day.getFullYear(),
    day.getMonth(),
    day.getDate() - sinceMonday + 3
  );
  const isoYear = thursday.getFullYear();
  // Week 1 is the week containing Jan 4 (equivalently: the first Thursday).
  const jan4 = new Date(isoYear, 0, 4);
  const jan4Monday = startOfLocalWeek(jan4);
  const week = Math.round((thursday.getTime() - jan4Monday.getTime()) / (7 * 86_400_000)) + 1;
  return `${isoYear}-W${String(week).padStart(2, "0")}`;
}

/** True when this window's bounds come from the calendar, not `now - Nd`. */
export { isCalendarWindow };
