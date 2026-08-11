/**
 * Apple absolute time: seconds since 2001-01-01T00:00:00Z, stored as a double.
 *
 * Parallel to `src/chromeHistory/time.ts`, which does the same job for Chrome's
 * WebKit epoch (microseconds since 1601). Each source keeps its own conversion
 * next to its own reader; the shared output contract is Unix ms, per the
 * 2026-07-10 decision that `event_time` is Unix ms everywhere.
 */
const APPLE_EPOCH_MS = Date.UTC(2001, 0, 1);

/** Seconds since the Apple epoch -> Unix ms. */
export function appleSecondsToUnixMs(seconds: number): number {
  return Math.round(seconds * 1000 + APPLE_EPOCH_MS);
}

/** Unix ms -> seconds since the Apple epoch. Used to build test fixtures. */
export function unixMsToAppleSeconds(ms: number): number {
  return (ms - APPLE_EPOCH_MS) / 1000;
}

/**
 * Whole days covered by a range, rounded down. The Phase 0 gate reads this to
 * decide whether knowledgeC actually retains enough history to justify the
 * Full Disk Access cost.
 */
export function spanDays(earliestMs: number, latestMs: number): number {
  if (!Number.isFinite(earliestMs) || !Number.isFinite(latestMs)) return 0;
  if (latestMs <= earliestMs) return 0;
  return Math.floor((latestMs - earliestMs) / 86_400_000);
}
