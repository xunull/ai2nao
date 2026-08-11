/** One `/app/usage` row as read from knowledgeC, already converted to Unix ms. */
export type SourceRow = {
  rowId: number;
  bundleId: string;
  startMs: number;
  endMs: number;
  tzOffsetS: number | null;
};

/** One row destined for `attention_focus_spans`. */
export type SpanRow = {
  sourceRowId: number;
  partIndex: number;
  bundleId: string;
  startMs: number;
  endMs: number;
  durationMs: number;
  tzOffsetS: number | null;
  localDay: string;
};

export type SpanOptions = {
  /**
   * Rows at or below this duration are dropped. Default 0, which drops only the
   * zero-length flickers (an app taking focus and losing it in the same
   * instant — 153 of 10343 rows measured on the design machine) and nothing
   * that actually lasted.
   *
   * Deliberately not set higher by default: "two seconds is too short to be
   * attention" is a product judgement, and this layer's job is to land the
   * source faithfully. Aggregation can filter; ingestion should not silently
   * decide what counted.
   */
  minDurationMs?: number;
  /** When present, only these bundle ids are kept. */
  allowBundles?: ReadonlySet<string>;
};

/**
 * Local calendar day, matching `src/chromeHistory/time.ts`'s convention and the
 * 2026-07-28 decision that the server timezone is authoritative. The source's
 * own `ZSECONDSFROMGMT` is carried through untouched for diagnostics and is
 * never consulted here.
 */
export function localDayOf(ms: number): string {
  const d = new Date(ms);
  const y = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${mo}-${day}`;
}

/** First instant of the local day after the one containing `ms`. */
function nextLocalMidnight(ms: number): number {
  const d = new Date(ms);
  return new Date(
    d.getFullYear(),
    d.getMonth(),
    d.getDate() + 1,
    0,
    0,
    0,
    0
  ).getTime();
}

/**
 * Cut a span at every local midnight it crosses.
 *
 * Without this, a span that starts at 23:40 and ends at 01:20 belongs to
 * whichever day you happen to pick, and the daily total stops agreeing with the
 * weekly total. Splitting at write time means every `GROUP BY local_day` is
 * correct with no special casing downstream.
 *
 * Uses the local-time Date constructor rather than fixed 86_400_000 arithmetic,
 * so a DST boundary produces a 23- or 25-hour day rather than drifting.
 */
export function splitAtLocalMidnight(
  startMs: number,
  endMs: number
): { startMs: number; endMs: number }[] {
  if (endMs <= startMs) return [{ startMs, endMs }];
  const parts: { startMs: number; endMs: number }[] = [];
  let cursor = startMs;
  // Bounded: a span longer than a year is corrupt input, not a real session.
  for (let i = 0; i < 400; i++) {
    const boundary = nextLocalMidnight(cursor);
    if (endMs <= boundary) {
      parts.push({ startMs: cursor, endMs });
      return parts;
    }
    parts.push({ startMs: cursor, endMs: boundary });
    cursor = boundary;
  }
  parts.push({ startMs: cursor, endMs });
  return parts;
}

/**
 * Turn source rows into span rows: drop what is not attention, keep what is,
 * and cut anything that crosses midnight.
 *
 * `partIndex` exists because a single source row can legitimately become
 * several stored rows. The uniqueness key is (source, instance, row id, part),
 * so without it the second half of an overnight span collides with the first
 * and is silently dropped by `INSERT OR IGNORE`.
 */
export function toSpans(
  rows: readonly SourceRow[],
  opts: SpanOptions = {}
): SpanRow[] {
  const minDurationMs = opts.minDurationMs ?? 0;
  const out: SpanRow[] = [];

  for (const row of rows) {
    if (!Number.isFinite(row.startMs) || !Number.isFinite(row.endMs)) continue;
    if (row.endMs - row.startMs <= minDurationMs) continue;
    if (opts.allowBundles && !opts.allowBundles.has(row.bundleId)) continue;

    const parts = splitAtLocalMidnight(row.startMs, row.endMs);
    parts.forEach((p, i) => {
      out.push({
        sourceRowId: row.rowId,
        partIndex: i,
        bundleId: row.bundleId,
        startMs: p.startMs,
        endMs: p.endMs,
        durationMs: p.endMs - p.startMs,
        tzOffsetS: row.tzOffsetS,
        localDay: localDayOf(p.startMs),
      });
    });
  }

  return out;
}
