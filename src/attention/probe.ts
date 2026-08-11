import { mkdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import DatabaseCtor from "better-sqlite3";
import type Database from "better-sqlite3";
import { detectAttentionRuntime, knowledgeCPath } from "./paths.js";
import {
  FOCUS_STREAM_CANDIDATES,
  listStreams,
  openSource,
  probeSource,
  resolveFocusStream,
} from "./read.js";
import { appleSecondsToUnixMs, spanDays, unixMsToAppleSeconds } from "./time.js";
import type {
  AttentionProbeReport,
  EndDateReliability,
  StreamSummary,
} from "./types.js";

/**
 * The design's Phase 0 gate. Below this, reading knowledgeC buys less history
 * than the zero-permission sampler would accumulate in two weeks, and the whole
 * Full Disk Access trade stops making sense.
 */
export const REQUIRED_HISTORY_DAYS = 14;

/** How many `/app/inFocus` rows to inspect when judging ZENDDATE. */
const END_DATE_SAMPLE = 500;

/**
 * Answer every Phase 0 question in one pass, without writing anything.
 *
 * This exists because the three questions the design gates on — which streams
 * exist, how far back they go, and whether rows carry a usable end time — are
 * not answerable from documentation. CoreDuet is a private database with no
 * compatibility promise, so they have to be measured on the actual machine.
 */
export function probeAttentionSource(
  sourcePath = knowledgeCPath()
): AttentionProbeReport {
  const runtime = detectAttentionRuntime();
  const source = probeSource(sourcePath);
  const base: AttentionProbeReport = {
    probedAt: new Date().toISOString(),
    runtime,
    featureWouldBeEnabled: runtime === "packaged-app",
    source,
    streams: [],
    focusStream: null,
    focusStreamPresent: false,
    endDate: null,
    gate: {
      requiredDays: REQUIRED_HISTORY_DAYS,
      actualDays: null,
      passed: false,
      reason: source.detail ?? "Source not readable.",
    },
  };

  // `schema_mismatch` means the database opened but carries no known focus
  // stream — which is exactly when the stream inventory is the thing you need
  // to see. Bailing out here would hide the only useful diagnostic.
  if (source.status !== "ok" && source.status !== "schema_mismatch") return base;

  const db = openSource(sourcePath);
  try {
    const streams = summarizeStreams(db);
    const focusName = resolveFocusStream(db);
    const focus =
      focusName === null
        ? null
        : (streams.find((s) => s.stream === focusName) ?? null);
    const endDate = focusName ? measureEndDate(db, focusName) : null;
    const actualDays = focus?.spanDays ?? null;
    const passed = actualDays !== null && actualDays >= REQUIRED_HISTORY_DAYS;

    return {
      ...base,
      streams,
      focusStream: focusName,
      focusStreamPresent: focus !== null,
      endDate,
      gate: {
        requiredDays: REQUIRED_HISTORY_DAYS,
        actualDays,
        passed,
        reason: !focus
          ? `None of ${FOCUS_STREAM_CANDIDATES.join(" / ")} is present, so there is nothing to build on.`
          : passed
            ? `${focusName} covers ${actualDays} days, at or above the ${REQUIRED_HISTORY_DAYS}-day floor.`
            : `${focusName} covers only ${actualDays} days, below the ${REQUIRED_HISTORY_DAYS}-day floor. The design says to revisit the approach rather than proceed.`,
      },
    };
  } finally {
    db.close();
  }
}

/** Row count and time coverage per stream. */
function summarizeStreams(db: Database.Database): StreamSummary[] {
  const names = listStreams(db);
  const stmt = db.prepare(
    `SELECT COUNT(*) AS rows,
            MIN(ZSTARTDATE) AS minStart,
            MAX(ZSTARTDATE) AS maxStart
       FROM ZOBJECT
      WHERE ZSTREAMNAME = ?`
  );
  return names.map((stream) => {
    const r = stmt.get(stream) as {
      rows: number;
      minStart: number | null;
      maxStart: number | null;
    };
    const earliestMs =
      r.minStart === null ? null : appleSecondsToUnixMs(r.minStart);
    const latestMs = r.maxStart === null ? null : appleSecondsToUnixMs(r.maxStart);
    return {
      stream,
      rows: r.rows,
      earliestMs,
      latestMs,
      spanDays:
        earliestMs === null || latestMs === null
          ? null
          : spanDays(earliestMs, latestMs),
    };
  });
}

/**
 * Judge whether `/app/inFocus` rows can supply their own end time.
 *
 * A span whose end is inferred from the next row's start runs straight through
 * sleep, lock, and shutdown, because there is no next row until you come back.
 * One such gap per night would poison every cross-reference and both of the
 * duration-based homepage probes.
 */
function measureEndDate(
  db: Database.Database,
  focusStream: string
): EndDateReliability {
  const rows = db
    .prepare(
      `SELECT ZSTARTDATE AS s, ZENDDATE AS e
         FROM ZOBJECT
        WHERE ZSTREAMNAME = ?
          AND ZSTARTDATE IS NOT NULL
        ORDER BY ZSTARTDATE DESC
        LIMIT ?`
    )
    .all(focusStream, END_DATE_SAMPLE) as { s: number; e: number | null }[];

  if (rows.length === 0) {
    return {
      sampled: 0,
      nullEnd: 0,
      zeroDuration: 0,
      usable: 0,
      maxDurationMs: null,
      verdict: "unknown",
    };
  }

  let nullEnd = 0;
  let zeroDuration = 0;
  let usable = 0;
  let maxDurationMs: number | null = null;
  for (const r of rows) {
    if (r.e === null) {
      nullEnd += 1;
      continue;
    }
    if (r.e <= r.s) {
      zeroDuration += 1;
      continue;
    }
    usable += 1;
    const ms = Math.round((r.e - r.s) * 1000);
    if (maxDurationMs === null || ms > maxDurationMs) maxDurationMs = ms;
  }

  // The verdict is about *missing* end times, not short ones. A zero-length row
  // is an app that flickered into focus and back out — real data that a
  // minimum-duration filter drops. Counting those as unreliable would send the
  // design chasing closing logic it does not need.
  const nullRatio = nullEnd / rows.length;
  return {
    sampled: rows.length,
    nullEnd,
    zeroDuration,
    usable,
    maxDurationMs,
    verdict:
      nullEnd === 0 ? "reliable" : nullRatio <= 0.5 ? "partial" : "unusable",
  };
}

export type FixtureExportResult = {
  outPath: string;
  rows: number;
  distinctBundles: number;
  /** Every timestamp is shifted so the newest row lands here. */
  rebasedToMs: number;
};

/**
 * Export a de-identified slice of `/app/inFocus` as a test fixture.
 *
 * Hand-built fixtures only prove the code matches our *assumptions* about
 * knowledgeC. A real slice proves it matches knowledgeC — it arrives carrying
 * the shapes nobody thinks to invent: null end times, overlapping rows,
 * sub-second flickers, spans crossing midnight.
 *
 * De-identification is not optional: this repo is public and app usage is
 * personal data. Bundle ids become stable placeholders (`com.example.app-N`, the
 * same input always mapping to the same output so merge logic stays testable)
 * and timestamps are shifted onto a fixed base so no real date survives.
 */
export function exportFixture(
  outPath: string,
  opts: { sourcePath?: string; limit?: number; rebaseTo?: number } = {}
): FixtureExportResult {
  const sourcePath = opts.sourcePath ?? knowledgeCPath();
  const limit = opts.limit ?? 2000;
  const rebasedToMs = opts.rebaseTo ?? Date.UTC(2020, 0, 15, 12, 0, 0);

  const src = openSource(sourcePath);
  let rows: { s: number; e: number | null; v: string | null; pk: number }[];
  let focusStream: string | null;
  try {
    focusStream = resolveFocusStream(src);
    if (focusStream === null) {
      throw new Error(
        `No focus stream (${FOCUS_STREAM_CANDIDATES.join(" / ")}) in ${sourcePath}`
      );
    }
    rows = src
      .prepare(
        `SELECT Z_PK AS pk, ZSTARTDATE AS s, ZENDDATE AS e, ZVALUESTRING AS v
           FROM ZOBJECT
          WHERE ZSTREAMNAME = ?
            AND ZSTARTDATE IS NOT NULL
          ORDER BY ZSTARTDATE DESC
          LIMIT ?`
      )
      .all(focusStream, limit) as typeof rows;
  } finally {
    src.close();
  }

  if (rows.length === 0) {
    throw new Error(`No ${focusStream} rows to export from ${sourcePath}`);
  }

  const newestStart = Math.max(...rows.map((r) => r.s));
  const shiftSeconds = unixMsToAppleSeconds(rebasedToMs) - newestStart;

  const bundleMap = new Map<string, string>();
  const anonymize = (v: string | null): string | null => {
    if (v === null) return null;
    let mapped = bundleMap.get(v);
    if (!mapped) {
      mapped = `com.example.app-${bundleMap.size + 1}`;
      bundleMap.set(v, mapped);
    }
    return mapped;
  };

  mkdirSync(dirname(outPath), { recursive: true });
  rmSync(outPath, { force: true });
  const out = new DatabaseCtor(outPath);
  try {
    out.exec(`
      CREATE TABLE ZOBJECT (
        Z_PK            INTEGER PRIMARY KEY,
        ZSTREAMNAME     TEXT,
        ZVALUESTRING    TEXT,
        ZSTARTDATE      REAL,
        ZENDDATE        REAL,
        ZSECONDSFROMGMT INTEGER
      );
    `);
    const ins = out.prepare(
      `INSERT INTO ZOBJECT (Z_PK, ZSTREAMNAME, ZVALUESTRING, ZSTARTDATE, ZENDDATE, ZSECONDSFROMGMT)
       VALUES (@pk, @stream, @v, @s, @e, NULL)`
    );
    const run = out.transaction(() => {
      for (const r of rows) {
        ins.run({
          pk: r.pk,
          stream: focusStream,
          v: anonymize(r.v),
          s: r.s + shiftSeconds,
          e: r.e === null ? null : r.e + shiftSeconds,
        });
      }
    });
    run();
  } finally {
    out.close();
  }

  return {
    outPath,
    rows: rows.length,
    distinctBundles: bundleMap.size,
    rebasedToMs,
  };
}
