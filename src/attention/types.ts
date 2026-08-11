import type { AttentionRuntime } from "./paths.js";

/**
 * Why the attention source is or isn't readable.
 *
 * SQLite reports at least four distinct causes as the same
 * `unable to open database file`, so `read.ts` probes actively rather than
 * mapping every failure to "not authorized". Getting this wrong is expensive in
 * a specific way: a user who is told to grant Full Disk Access, grants it, and
 * still sees an empty page has paid a real privacy cost for nothing.
 */
export type AttentionSourceStatus =
  | "ok"
  | "source_missing"
  | "not_authorized"
  | "open_failed"
  | "schema_mismatch";

export type AttentionSourceProbe = {
  status: AttentionSourceStatus;
  sourcePath: string;
  /** Present for every non-ok status. Raw text, safe to show in diagnostics. */
  detail?: string;
  /** Underlying error message when one exists, for `open_failed` triage. */
  rawError?: string;
  /**
   * On `not_authorized`, the `.app` macOS attributes this process to — the one
   * that must actually receive the grant. Absent when the chain holds no app.
   */
  responsibleApp?: string;
  /**
   * On `ok`, which candidate stream this machine actually carries. Resolved at
   * runtime because CoreDuet's stream names differ across macOS versions.
   */
  focusStream?: string;
};

/** One `ZOBJECT.ZSTREAMNAME` and what the source holds for it. */
export type StreamSummary = {
  stream: string;
  rows: number;
  /** Unix ms. Null when the stream has no usable ZSTARTDATE. */
  earliestMs: number | null;
  latestMs: number | null;
  /** Whole days between earliest and latest. The Phase 0 gate reads this. */
  spanDays: number | null;
};

/**
 * Whether `/app/inFocus` rows carry a usable end time.
 *
 * If they do not, a focus span's end can only be inferred from the *next* row's
 * start — and there is no next row across sleep, lock, or shutdown, which would
 * manufacture one fake overnight span every single night.
 */
export type EndDateReliability = {
  sampled: number;
  /**
   * Rows with no ZENDDATE at all. These are the only ones that force a span to
   * be closed from some other stream — the verdict keys off this, not off
   * duration.
   */
  nullEnd: number;
  /**
   * Rows where ZENDDATE equals ZSTARTDATE: an app took focus and lost it inside
   * the same instant. Legitimate data, not a gap — measured at 153/10343 on the
   * machine this was designed against. Filtered by a minimum-duration threshold,
   * never patched by closing logic.
   */
  zeroDuration: number;
  /** Rows where ZENDDATE > ZSTARTDATE. */
  usable: number;
  /**
   * Longest ZENDDATE - ZSTARTDATE seen, in ms. A value near a full night is the
   * signature of spans that run through sleep; measured max here was 49.7 min,
   * which is what ruled closing logic out.
   */
  maxDurationMs: number | null;
  verdict: "reliable" | "partial" | "unusable" | "unknown";
};

export type AttentionProbeReport = {
  probedAt: string;
  runtime: AttentionRuntime;
  /**
   * True only for the packaged .app. The `probe` command still runs everywhere;
   * this flag reports whether the *feature* would be enabled here.
   */
  featureWouldBeEnabled: boolean;
  source: AttentionSourceProbe;
  /**
   * Every stream in ZOBJECT. Populated whenever the database opened at all —
   * including `schema_mismatch`, where the inventory is the whole point.
   */
  streams: StreamSummary[];
  /** Which candidate stream this machine carries, or null if none. */
  focusStream: string | null;
  focusStreamPresent: boolean;
  endDate: EndDateReliability | null;
  /** Phase 0 gate: the design requires >= 14 days of /app/inFocus history. */
  gate: {
    requiredDays: number;
    actualDays: number | null;
    passed: boolean;
    reason: string;
  };
};
