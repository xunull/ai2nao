/** Chrome / WebKit timestamp: microseconds since 1601-01-01T00:00:00.000Z. */
const WEBKIT_EPOCH_MS = Date.UTC(1601, 0, 1);

/**
 * Convert Chrome `visit_time` / `last_visit_time` (microseconds since WebKit epoch) to Unix ms.
 */
export function chromeWebkitUsToUnixMs(us: number): number {
  return us / 1000 + WEBKIT_EPOCH_MS;
}

/** Local calendar day `YYYY-MM-DD` matching `downloads` scan behavior. */
export function calendarDayLocalFromChromeUs(us: number): string {
  const ms = chromeWebkitUsToUnixMs(us);
  const d = new Date(ms);
  const y = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${mo}-${day}`;
}

/**
 * Chrome `downloads` row: use `end_time` when it is a positive WebKit microsecond timestamp;
 * otherwise fall back to `start_time` (e.g. in-progress downloads).
 */
export function calendarDayLocalFromChromeDownload(
  endTimeUs: number | null | undefined,
  startTimeUs: number
): string {
  const end = endTimeUs ?? 0;
  if (Number.isFinite(end) && end > 0) {
    return calendarDayLocalFromChromeUs(end);
  }
  return calendarDayLocalFromChromeUs(startTimeUs);
}

/** Prefer `end_time` for display when valid; else `start_time` (WebKit µs → Unix ms). */
export function chromeDownloadTimeUnixMs(
  endTimeUs: number | null | undefined,
  startTimeUs: number
): number {
  const end = endTimeUs ?? 0;
  if (Number.isFinite(end) && end > 0) {
    return chromeWebkitUsToUnixMs(end);
  }
  return chromeWebkitUsToUnixMs(startTimeUs);
}
