import {
  MONTH_PICKER_MAX_DEPTH,
  isMonthKey,
  windowToGranularity,
  windowToDays,
  type BucketGranularity,
  type MonthKey,
  type WindowKey,
} from "./types.js";

/**
 * SQL bucket expression for SQLite. **F3: parameter MUST be enum**
 * (`BucketGranularity`), never `string` — granularity values are 4 hardcoded
 * SQL fragments, never user input, so SQL injection risk = 0. The TS type
 * guard is a fail-safe so a future refactor cannot let user-derived strings
 * leak in.
 *
 * All four expressions project an ISO-8601 UTC timestamp column to the user's
 * **local** time bucket (`'localtime'` modifier). The column defaults to
 * `last_updated_at` (per-session tables); callers pass `event_at` (per-event
 * timeline) so resumed multi-day sessions bucket by the day each event actually
 * happened.
 */
export function bucketExpr(
  granularity: BucketGranularity,
  col = "last_updated_at"
): string {
  switch (granularity) {
    case "hour":
      return `strftime('%Y-%m-%d %H:00:00', ${col}, 'localtime')`;
    case "3hour":
      // Floor local hour to nearest 3-hour boundary: 00:00 / 03:00 / 06:00 / ...
      return (
        `strftime('%Y-%m-%d ', ${col}, 'localtime') || ` +
        "printf('%02d:00:00', " +
        `  (CAST(strftime('%H', ${col}, 'localtime') AS INTEGER) / 3) * 3)`
      );
    case "day":
      return `strftime('%Y-%m-%d', ${col}, 'localtime')`;
    case "week":
      // ISO week start (Monday). %w gives 0=Sunday, so (w + 6) % 7 maps Mon → 0.
      // date() is calendar-aware (handles month / year rollover).
      return (
        `date(${col}, 'localtime', ` +
        `'-' || ((CAST(strftime('%w', ${col}, 'localtime') AS INTEGER) + 6) % 7) || ' days')`
      );
  }
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** YYYY-MM-DD HH:MM:SS in local time (matches SQLite strftime output). */
function fmtLocal(date: Date, granularity: BucketGranularity): string {
  const y = date.getFullYear();
  const m = pad2(date.getMonth() + 1);
  const d = pad2(date.getDate());
  switch (granularity) {
    case "hour":
      return `${y}-${m}-${d} ${pad2(date.getHours())}:00:00`;
    case "3hour":
      return `${y}-${m}-${d} ${pad2(Math.floor(date.getHours() / 3) * 3)}:00:00`;
    case "day":
    case "week":
      return `${y}-${m}-${d}`;
  }
}

/** Anchor a Date to the start of its bucket (local time). */
export function anchorBucketStart(d: Date, granularity: BucketGranularity): Date {
  const out = new Date(d);
  switch (granularity) {
    case "hour":
      out.setMinutes(0, 0, 0);
      return out;
    case "3hour":
      out.setHours(Math.floor(out.getHours() / 3) * 3, 0, 0, 0);
      return out;
    case "day":
      out.setHours(0, 0, 0, 0);
      return out;
    case "week": {
      // Shift to Monday of the same week (local).
      out.setHours(0, 0, 0, 0);
      const dayOfWeek = out.getDay(); // 0=Sun..6=Sat
      const shift = (dayOfWeek + 6) % 7; // Mon=0
      out.setDate(out.getDate() - shift);
      return out;
    }
  }
}

/**
 * 今天是哪天(本地),`YYYY-MM-DD`。
 *
 * 存在的理由是收敛:仓库里「今天」此前有四个各写各的实现 —— `gitChurn/collect.ts` 的
 * `localDay`、`workRecap/window.ts` 的 `localDayKey`、`topicStream/rebuild.ts` 的
 * `localDayFromIso`、`atuin/queries.ts` 的 `localDayBoundsNs`。新代码一律从这里取,
 * 别再添第五个。输出与 `bucketExpr("day")` 的 SQL 结果同格式,可以直接对上。
 */
export function todayLocalDay(now: Date = new Date()): string {
  return fmtLocal(anchorBucketStart(now, "day"), "day");
}

/**
 * 覆盖「以 `now` 所在本地日为结尾的 `days` 个本地日」的 **UTC 半开区间** `[fromIso, toIso)`。
 *
 * 这是给查询用的,不是给显示用的。**别写 `date(col,'localtime') = ?`** —— 那会对每一行的
 * 时间列求函数,索引直接失效,在 943MB 的库上就是全表扫。改成
 * `WHERE col >= ? AND col < ?` 喂本函数的两个值:ISO-8601 UTC 字符串按字典序就是时间序,
 * SQLite 能当范围扫走索引。
 *
 * 半开而非闭区间,是为了避开「当天最后一毫秒」这类边界:`< 次日零点` 永远正确,
 * 而 `<= 23:59:59.999` 会漏掉 `.9995`。
 *
 * days=1 → 今天一天;days=7 → 含今天在内的最近 7 个本地日。
 * 要「不含今天的前 7 天」就传一个昨天的 Date 进来,别在这里加参数。
 */
export function localDayRangeUtc(
  now: Date = new Date(),
  days = 1
): { fromIso: string; toIso: string } {
  // 先挡 NaN 再取 max —— Math.max(1, NaN) 是 NaN,不是 1,会一路传到 setDate
  // 把 Date 变成 Invalid Date,然后在 toISOString() 处才炸(离现场很远)。
  const span = Number.isFinite(days) ? Math.max(1, Math.floor(days)) : 1;
  const from = anchorBucketStart(now, "day");
  from.setDate(from.getDate() - (span - 1));
  const to = anchorBucketStart(now, "day");
  to.setDate(to.getDate() + 1);
  return { fromIso: from.toISOString(), toIso: to.toISOString() };
}

function advance(d: Date, granularity: BucketGranularity): Date {
  const out = new Date(d);
  switch (granularity) {
    case "hour":
      out.setHours(out.getHours() + 1);
      return out;
    case "3hour":
      out.setHours(out.getHours() + 3);
      return out;
    case "day":
      out.setDate(out.getDate() + 1);
      return out;
    case "week":
      out.setDate(out.getDate() + 7);
      return out;
  }
}

export type IteratedBucket = {
  start: Date;
  end: Date;
  /** Local-time key matching the SQL bucketExpr output (used to join rows). */
  key: string;
};

/**
 * Enumerate continuous half-open buckets `[start, end)` covering `[from, to)`.
 *
 * F4 policy: when the last bucket's `end > now`, **do not truncate** — keep
 * the full bucket so the UI shows "in-progress" partial counts as 0 fill past
 * now. Continuity > visual alignment with the right edge.
 *
 * Pitfall: this iterator is purely calendar-aware; daylight-saving transitions
 * still emit a 23-hour or 25-hour calendar day, but the bucketing semantics
 * stay correct because we round trip through `setHours` / `setDate`. Tests
 * pin TZ to Asia/Shanghai (UTC+8, no DST) to avoid CI flakes.
 *
 * NOTE (anchor policy): callers wanting a COMPLETE first bucket (no leading-edge
 * data dropped in a zero-fill join) must pass a `from` already aligned via
 * `anchorBucketStart`. An unaligned `from` makes the first emitted bucket the
 * NEXT full bucket (the partial first bucket is skipped), so rows in
 * [from, firstFullBucketStart) would have no bucket to attach to.
 */
export function iterateBuckets(
  from: Date,
  to: Date,
  granularity: BucketGranularity
): IteratedBucket[] {
  const out: IteratedBucket[] = [];
  let cursor = anchorBucketStart(from, granularity);
  // Guard: if anchored start is before `from` (always true unless `from` is
  // already aligned), skip ahead so the first emitted bucket isn't outside
  // the requested range.
  while (cursor.getTime() < from.getTime()) {
    cursor = advance(cursor, granularity);
  }
  while (cursor.getTime() < to.getTime()) {
    const next = advance(cursor, granularity);
    out.push({
      start: new Date(cursor),
      end: next,
      key: fmtLocal(cursor, granularity),
    });
    cursor = next;
  }
  return out;
}

/**
 * Translate a YYYY-MM month key into a half-open local-time range covering
 * the entire calendar month: [first day 00:00 local, next-month first day 00:00 local).
 */
export function monthToRange(monthKey: MonthKey): { from: Date; to: Date } {
  if (!isMonthKey(monthKey)) {
    throw new Error(`invalid month key: ${monthKey} (expected YYYY-MM)`);
  }
  const [yearStr, monthStr] = monthKey.split("-");
  const year = Number(yearStr);
  const month = Number(monthStr) - 1; // JS Date months: 0=Jan
  const from = new Date(year, month, 1, 0, 0, 0, 0);
  const to = new Date(year, month + 1, 1, 0, 0, 0, 0);
  return { from, to };
}

/**
 * Reject months older than `MONTH_PICKER_MAX_DEPTH` from now. Throws with a
 * 400-friendly message so route handlers can surface to the user.
 */
export function assertMonthInDepth(monthKey: MonthKey, now: Date = new Date()): void {
  const { from } = monthToRange(monthKey);
  const limit = new Date(now);
  limit.setMonth(limit.getMonth() - MONTH_PICKER_MAX_DEPTH);
  limit.setDate(1);
  limit.setHours(0, 0, 0, 0);
  if (from.getTime() < limit.getTime()) {
    throw new Error(
      `month ${monthKey} is older than ${MONTH_PICKER_MAX_DEPTH} months back`
    );
  }
}

/** Range of a window: `[now - windowDays, now)`. */
export function windowToRange(
  windowKey: WindowKey,
  now: Date = new Date()
): { from: Date; to: Date } {
  const days = windowToDays(windowKey);
  const from = new Date(now.getTime() - days * 86_400_000);
  return { from, to: new Date(now) };
}

/** The previous, strictly-preceding equal-length window of `[from, to)`. */
export function previousWindowRange(from: Date, to: Date): { from: Date; to: Date } {
  const span = to.getTime() - from.getTime();
  return {
    from: new Date(from.getTime() - span),
    to: new Date(from.getTime()),
  };
}

/** Re-exports for test consumers. */
export {
  bucketExpr as __bucketExpr,
  fmtLocal as __fmtLocal,
};

/** Convenience picker for the route layer. */
export function granularityFor(
  mode: "window" | "month",
  window?: WindowKey
): BucketGranularity {
  if (mode === "month") return "day";
  if (!window) throw new Error("granularityFor: window required in window mode");
  return windowToGranularity(window);
}
