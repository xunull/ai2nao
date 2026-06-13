import type Database from "better-sqlite3";
import { bucketExpr } from "./bucket.js";
import type {
  BucketGranularity,
  MonthRange,
  WorkTokensTrendBucket,
  WorkTokensTrendCoverage,
  WorkTokensTrendTotals,
} from "./types.js";

type Source = "claude" | "codex";

const TABLE: Record<Source, string> = {
  claude: "claude_session_token_usage",
  codex: "codex_session_token_usage",
};

type RawBucketRow = {
  bucket_key: string;
  total_tokens: number;
  session_count: number;
  full_count: number;
  unknown_count: number;
  error_count: number;
};

/**
 * Per-source aggregate for a single `[from, to)` range bucketed by `granularity`.
 *
 * Returns one row per bucket that has at least one session. The caller
 * (`mergeAndZeroFill`) is responsible for filling in zero buckets via
 * `iterateBuckets()` so the response shape is contiguous.
 *
 * Filter rules (P11, single predicate for both SUM and count):
 *   - `last_updated_at` BETWEEN from AND to (half-open: < to)
 *   - `missing_since IS NULL` (exclude vanished sessions)
 *
 * **Token sum uses `token_status='full'` ONLY.** Sessions whose status is
 * `unknown` / `error` contribute to session counts (for coverage badge) but
 * NOT to the token sum. This is the ai2nao "real tokens only, never estimate"
 * convention — same as `buildWorkTokenRanking()`.
 */
export function queryBucketsBySource(
  db: Database.Database,
  source: Source,
  from: Date,
  to: Date,
  granularity: BucketGranularity
): RawBucketRow[] {
  const sql = `
    SELECT
      ${bucketExpr(granularity)} AS bucket_key,
      COALESCE(SUM(CASE WHEN token_status = 'full' THEN total_tokens ELSE 0 END), 0) AS total_tokens,
      COUNT(*) AS session_count,
      SUM(CASE WHEN token_status = 'full' THEN 1 ELSE 0 END) AS full_count,
      SUM(CASE WHEN token_status = 'unknown' THEN 1 ELSE 0 END) AS unknown_count,
      SUM(CASE WHEN token_status = 'error' THEN 1 ELSE 0 END) AS error_count
    FROM ${TABLE[source]}
    WHERE last_updated_at >= ?
      AND last_updated_at < ?
      AND missing_since IS NULL
    GROUP BY bucket_key
    ORDER BY bucket_key ASC
  `;
  const fromIso = from.toISOString();
  const toIso = to.toISOString();
  return db.prepare(sql).all(fromIso, toIso) as RawBucketRow[];
}

/**
 * Zero-fill: take per-source raw rows + the enumerated continuous buckets,
 * and produce one `WorkTokensTrendBucket` per enumerated bucket. Buckets
 * with no row for a source default to 0 for every field of that source.
 */
export function mergeAndZeroFill(
  bucketKeys: { key: string; start: Date; end: Date }[],
  claudeRows: RawBucketRow[],
  codexRows: RawBucketRow[]
): WorkTokensTrendBucket[] {
  const claudeMap = new Map(claudeRows.map((r) => [r.bucket_key, r]));
  const codexMap = new Map(codexRows.map((r) => [r.bucket_key, r]));
  return bucketKeys.map((b) => {
    const c = claudeMap.get(b.key);
    const x = codexMap.get(b.key);
    return {
      bucketStart: b.start.toISOString(),
      bucketEnd: b.end.toISOString(),
      claudeTokens: c?.total_tokens ?? 0,
      codexTokens: x?.total_tokens ?? 0,
      claudeSessionCount: c?.session_count ?? 0,
      codexSessionCount: x?.session_count ?? 0,
      claudeCoveredSessionCount: c?.full_count ?? 0,
      codexCoveredSessionCount: x?.full_count ?? 0,
      claudeUnknownSessionCount: c?.unknown_count ?? 0,
      codexUnknownSessionCount: x?.unknown_count ?? 0,
      claudeErrorSessionCount: c?.error_count ?? 0,
      codexErrorSessionCount: x?.error_count ?? 0,
    };
  });
}

/**
 * Aggregate the per-bucket DTOs into the standalone Totals card.
 *
 * Coverage derivation (3-state, F2):
 *   - all sessions full (or zero sessions) → "full"
 *   - some full + some not  → "partial"
 *   - no full sessions       → "unknown"
 *
 * "error" sessions count as non-full for coverage purposes (they don't have
 * usable token numbers), but they're reported separately so the UI can
 * distinguish "we don't know" from "the parser broke".
 */
export function computeTotals(
  buckets: WorkTokensTrendBucket[]
): WorkTokensTrendTotals {
  let claudeTokens = 0;
  let codexTokens = 0;
  let coveredSessionCount = 0;
  let unknownSessionCount = 0;
  let errorSessionCount = 0;
  for (const b of buckets) {
    claudeTokens += b.claudeTokens;
    codexTokens += b.codexTokens;
    coveredSessionCount +=
      b.claudeCoveredSessionCount + b.codexCoveredSessionCount;
    unknownSessionCount +=
      b.claudeUnknownSessionCount + b.codexUnknownSessionCount;
    errorSessionCount +=
      b.claudeErrorSessionCount + b.codexErrorSessionCount;
  }
  const totalTokens = claudeTokens + codexTokens;
  const totalSessionCount =
    coveredSessionCount + unknownSessionCount + errorSessionCount;

  let coverage: WorkTokensTrendCoverage;
  if (totalSessionCount === 0) {
    coverage = "full"; // zero sessions = trivially fully accounted for
  } else if (coveredSessionCount === totalSessionCount) {
    coverage = "full";
  } else if (coveredSessionCount === 0) {
    coverage = "unknown";
  } else {
    coverage = "partial";
  }

  return {
    totalTokens,
    claudeTokens,
    codexTokens,
    claudeShare: totalTokens === 0 ? 0 : claudeTokens / totalTokens,
    codexShare: totalTokens === 0 ? 0 : codexTokens / totalTokens,
    coverage,
    coveredSessionCount,
    unknownSessionCount,
    errorSessionCount,
    totalSessionCount,
  };
}

/**
 * Strictly-preceding equal-length window total. Returns 0 (never null) when
 * the prior range has no qualifying sessions — design doc F2 / Open Questions.
 */
export function computePreviousWindowTotal(
  db: Database.Database,
  from: Date,
  to: Date
): number {
  const span = to.getTime() - from.getTime();
  const prevFrom = new Date(from.getTime() - span);
  const prevTo = new Date(from.getTime());

  const sql = `
    SELECT COALESCE(SUM(total_tokens), 0) AS total
    FROM (
      SELECT total_tokens FROM claude_session_token_usage
       WHERE last_updated_at >= ?
         AND last_updated_at < ?
         AND missing_since IS NULL
         AND token_status = 'full'
      UNION ALL
      SELECT total_tokens FROM codex_session_token_usage
       WHERE last_updated_at >= ?
         AND last_updated_at < ?
         AND missing_since IS NULL
         AND token_status = 'full'
    )
  `;
  const fromIso = prevFrom.toISOString();
  const toIso = prevTo.toISOString();
  const row = db.prepare(sql).get(fromIso, toIso, fromIso, toIso) as {
    total: number;
  };
  return row.total;
}

/**
 * MIN / MAX of `last_updated_at` across both token tables, projected to local
 * YYYY-MM strings. When both tables are empty, fall back to the current local
 * month so the picker still has a usable lower bound.
 */
export function computeMonthRange(
  db: Database.Database,
  now: Date = new Date()
): MonthRange {
  const sql = `
    SELECT
      MIN(local_month) AS earliest,
      MAX(local_month) AS latest
    FROM (
      SELECT strftime('%Y-%m', last_updated_at, 'localtime') AS local_month
        FROM claude_session_token_usage
       WHERE missing_since IS NULL
      UNION ALL
      SELECT strftime('%Y-%m', last_updated_at, 'localtime') AS local_month
        FROM codex_session_token_usage
       WHERE missing_since IS NULL
    )
  `;
  const row = db.prepare(sql).get() as {
    earliest: string | null;
    latest: string | null;
  };
  if (row.earliest && row.latest) {
    return { earliest: row.earliest, latest: row.latest };
  }
  const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  return { earliest: currentMonth, latest: currentMonth };
}
