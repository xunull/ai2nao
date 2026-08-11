import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { bundleFilterOf, readAttentionConfig, type AttentionConfig } from "./config.js";
import { knowledgeCPath } from "./paths.js";
import { openSource, probeSource, resolveFocusStream } from "./read.js";
import { toSpans, type SourceRow, type SpanOptions } from "./spans.js";
import { appleSecondsToUnixMs } from "./time.js";

/**
 * Rows whose decoded timestamp falls outside this window are refused.
 *
 * knowledgeC really does carry garbage: 29 rows in a sync-bookmark stream on
 * the design machine decode to the year 0000. Nothing downstream should have to
 * defend against a span in the year zero.
 */
const EARLIEST_PLAUSIBLE_MS = Date.UTC(2005, 0, 1);
const FUTURE_SLACK_MS = 86_400_000;

export type AttentionSyncResult = {
  ok: boolean;
  status: "ok" | "skipped" | "failed";
  /** Why it was skipped or failed. Mirrors the probe's status vocabulary. */
  reason?: string;
  focusStream?: string;
  sourceInstanceId?: string;
  rowsRead: number;
  rowsRejected: number;
  spansInserted: number;
  spansDuplicate: number;
  watermarkBefore: number;
  watermarkAfter: number;
  /** True when the source database was detected as reset and reingested. */
  reset: boolean;
  coverageFromMs: number | null;
  coverageToMs: number | null;
};

type SyncStateRow = {
  source_instance_id: string | null;
  focus_stream: string | null;
  watermark_row_id: number;
  anchor_row_id: number | null;
  anchor_start_ms: number | null;
  anchor_bundle_id: string | null;
};

export type AttentionSyncOptions = SpanOptions & {
  sourcePath?: string;
  /**
   * 显式传入就不读配置文件。测试用；生产路径一律走 `~/.ai2nao/config.json`，
   * 免得「代码里默认值」和「配置文件默认值」两套并存。
   */
  config?: AttentionConfig;
  /** Rows per batch. knowledgeC holds ~10k rows, so one pass is normal. */
  batchLimit?: number;
};

const SOURCE = "knowledgec";

/**
 * Pull new foreground rows from knowledgeC into `attention_focus_spans`.
 *
 * The watermark is a **row id**, not a timestamp. CoreDuet does not promise
 * that rows arrive in `ZSTARTDATE` order, and a timestamp watermark silently
 * skips any row written late with an earlier start — a failure that produces no
 * error, just quietly missing hours. `chrome_history_sync_state` uses
 * `max_visit_id` for the same reason.
 *
 * See also `src/chromeHistory/sync.ts`, which solves the same problem shape for
 * Chrome's live History (snapshot copy, source-id + anchor reset detection).
 * The two are deliberately parallel rather than shared: Chrome's state is keyed
 * per browser profile and this one is not, so a shared abstraction would carry
 * a dimension that means nothing here. Fix a bug in one, check the other.
 */
export function syncAttention(
  db: Database.Database,
  opts: AttentionSyncOptions = {}
): AttentionSyncResult {
  const sourcePath = opts.sourcePath ?? knowledgeCPath();
  const empty: AttentionSyncResult = {
    ok: false,
    status: "skipped",
    rowsRead: 0,
    rowsRejected: 0,
    spansInserted: 0,
    spansDuplicate: 0,
    watermarkBefore: 0,
    watermarkAfter: 0,
    reset: false,
    coverageFromMs: null,
    coverageToMs: null,
  };

  // 配置坏了就停，不回落到默认值。悄悄回落意味着一个拼错的键能把 allowlist
  // 变回全量采集 —— 对一个采「你在电脑前做的一切」的功能，那是最糟的失败方式。
  let config = opts.config;
  if (!config) {
    const read = readAttentionConfig();
    if (!read.ok) {
      return {
        ...empty,
        status: "failed",
        reason: `config_error: ${read.issues.map((i) => `${i.path} ${i.message}`).join("; ")}`,
      };
    }
    config = read.config;
  }

  const probe = probeSource(sourcePath);
  if (probe.status !== "ok") {
    return { ...empty, status: "skipped", reason: probe.status };
  }

  const src = openSource(sourcePath);
  try {
    const focusStream = resolveFocusStream(src);
    if (focusStream === null) {
      const hasAnyRow = src.prepare("SELECT 1 FROM ZOBJECT LIMIT 1").get();
      if (hasAnyRow) {
        // Rows exist but none of the known focus streams do: the schema moved.
        return { ...empty, status: "skipped", reason: "schema_mismatch" };
      }
      // Readable and genuinely empty. Record the successful look so the source
      // reads as healthy-and-idle rather than never-run — D4's four states
      // depend on `last_success_at`, not on whether any row arrived.
      const before = readState(db)?.watermark_row_id ?? 0;
      writeState(db, {
        source_instance_id: null,
        focus_stream: null,
        watermark_row_id: before,
        anchor_row_id: null,
        anchor_start_ms: null,
        anchor_bundle_id: null,
      });
      return {
        ...empty,
        ok: true,
        status: "ok",
        watermarkBefore: before,
        watermarkAfter: before,
      };
    }

    const anchor = readAnchor(src, focusStream);
    if (anchor === null) {
      // Opened, stream present, but no usable rows. Still a successful look:
      // record the baseline so the next run is not treated as a first run.
      const before = readState(db)?.watermark_row_id ?? 0;
      writeState(db, {
        source_instance_id: null,
        focus_stream: focusStream,
        watermark_row_id: 0,
        anchor_row_id: null,
        anchor_start_ms: null,
        anchor_bundle_id: null,
      });
      return {
        ...empty,
        ok: true,
        status: "ok",
        focusStream,
        watermarkBefore: before,
        watermarkAfter: 0,
      };
    }

    const instanceId = instanceIdOf(anchor);
    const prev = readState(db);
    const reset = prev !== null && prev.source_instance_id !== null
      ? prev.source_instance_id !== instanceId
      : false;
    const watermarkBefore = prev?.watermark_row_id ?? 0;
    // A reset means row ids restarted; anything we hold is from a different
    // database instance, so re-read from zero rather than sitting above a
    // watermark that will never be reached again.
    const readFrom = reset ? 0 : watermarkBefore;

    const raw = src
      .prepare(
        `SELECT Z_PK AS pk, ZVALUESTRING AS v, ZSTARTDATE AS s, ZENDDATE AS e,
                ZSECONDSFROMGMT AS tz
           FROM ZOBJECT
          WHERE ZSTREAMNAME = ?
            AND Z_PK > ?
            AND ZSTARTDATE IS NOT NULL
            AND ZENDDATE IS NOT NULL
            AND ZVALUESTRING IS NOT NULL
          ORDER BY Z_PK ASC
          LIMIT ?`
      )
      .all(focusStream, readFrom, opts.batchLimit ?? 50_000) as {
      pk: number;
      v: string;
      s: number;
      e: number;
      tz: number | null;
    }[];

    let rowsRejected = 0;
    const rows: SourceRow[] = [];
    let maxRowId = readFrom;
    for (const r of raw) {
      if (r.pk > maxRowId) maxRowId = r.pk;
      const startMs = appleSecondsToUnixMs(r.s);
      const endMs = appleSecondsToUnixMs(r.e);
      if (!plausible(startMs) || !plausible(endMs)) {
        rowsRejected += 1;
        continue;
      }
      rows.push({
        rowId: r.pk,
        bundleId: r.v,
        startMs,
        endMs,
        tzOffsetS: r.tz,
      });
    }

    // 显式 opts 覆盖配置（测试路径），否则按配置过滤。
    const spans = toSpans(rows, {
      minDurationMs: opts.minDurationMs ?? config.minDurationMs,
      allowBundles:
        opts.allowBundles ?? bundleFilterOf(config, rows.map((r) => r.bundleId)),
    });
    const { inserted, duplicate } = insertSpans(db, instanceId, spans);

    writeState(db, {
      source_instance_id: instanceId,
      focus_stream: focusStream,
      // Advance even when every row was rejected or filtered: the watermark
      // tracks what we have *looked at*, not what we chose to keep. Leaving it
      // behind would re-read the same rejects forever.
      watermark_row_id: Math.max(watermarkBefore, maxRowId),
      anchor_row_id: anchor.rowId,
      anchor_start_ms: anchor.startMs,
      anchor_bundle_id: anchor.bundleId,
    });

    const coverage = readCoverage(db);
    return {
      ok: true,
      status: "ok",
      focusStream,
      sourceInstanceId: instanceId,
      rowsRead: raw.length,
      rowsRejected,
      spansInserted: inserted,
      spansDuplicate: duplicate,
      watermarkBefore,
      watermarkAfter: Math.max(watermarkBefore, maxRowId),
      reset,
      coverageFromMs: coverage.fromMs,
      coverageToMs: coverage.toMs,
    };
  } finally {
    src.close();
  }
}

function plausible(ms: number): boolean {
  return (
    Number.isFinite(ms) &&
    ms >= EARLIEST_PLAUSIBLE_MS &&
    ms <= Date.now() + FUTURE_SLACK_MS
  );
}

type Anchor = { rowId: number; startMs: number; bundleId: string };

/**
 * The oldest surviving row, used as the fingerprint of this database instance.
 *
 * knowledgeC rolls old data off (19 days on the design machine), so the anchor
 * moves forward over time — that is expected and does not mean a reset. What
 * marks a reset is the row *id* space restarting, which changes the fingerprint
 * in a way rolling deletion does not.
 */
function readAnchor(
  src: Database.Database,
  focusStream: string
): Anchor | null {
  const r = src
    .prepare(
      `SELECT Z_PK AS pk, ZSTARTDATE AS s, ZVALUESTRING AS v
         FROM ZOBJECT
        WHERE ZSTREAMNAME = ? AND ZSTARTDATE IS NOT NULL AND ZVALUESTRING IS NOT NULL
        ORDER BY Z_PK ASC LIMIT 1`
    )
    .get(focusStream) as { pk: number; s: number; v: string } | undefined;
  if (!r) return null;
  return {
    rowId: r.pk,
    startMs: appleSecondsToUnixMs(r.s),
    bundleId: r.v,
  };
}

function instanceIdOf(a: Anchor): string {
  return createHash("sha1")
    .update(`${a.rowId}:${a.startMs}:${a.bundleId}`)
    .digest("hex")
    .slice(0, 16);
}

function readState(db: Database.Database): SyncStateRow | null {
  return (
    (db
      .prepare(
        `SELECT source_instance_id, focus_stream, watermark_row_id,
                anchor_row_id, anchor_start_ms, anchor_bundle_id
           FROM attention_sync_state WHERE source = ?`
      )
      .get(SOURCE) as SyncStateRow | undefined) ?? null
  );
}

function writeState(db: Database.Database, s: SyncStateRow): void {
  db.prepare(
    `INSERT INTO attention_sync_state
       (source, source_instance_id, focus_stream, watermark_row_id,
        anchor_row_id, anchor_start_ms, anchor_bundle_id, last_success_at, last_error)
     VALUES (@source, @inst, @stream, @wm, @aRow, @aStart, @aBundle, @at, NULL)
     ON CONFLICT(source) DO UPDATE SET
       source_instance_id = excluded.source_instance_id,
       focus_stream       = excluded.focus_stream,
       watermark_row_id   = excluded.watermark_row_id,
       anchor_row_id      = excluded.anchor_row_id,
       anchor_start_ms    = excluded.anchor_start_ms,
       anchor_bundle_id   = excluded.anchor_bundle_id,
       last_success_at    = excluded.last_success_at,
       last_error         = NULL`
  ).run({
    source: SOURCE,
    inst: s.source_instance_id,
    stream: s.focus_stream,
    wm: s.watermark_row_id,
    aRow: s.anchor_row_id,
    aStart: s.anchor_start_ms,
    aBundle: s.anchor_bundle_id,
    at: new Date().toISOString(),
  });
}

function insertSpans(
  db: Database.Database,
  instanceId: string,
  spans: ReturnType<typeof toSpans>
): { inserted: number; duplicate: number } {
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO attention_focus_spans
       (source, source_instance_id, source_row_id, part_index, bundle_id,
        start_ms, end_ms, duration_ms, tz_offset_s, local_day, inserted_at)
     VALUES (@source, @inst, @rowId, @part, @bundle, @start, @end, @dur, @tz, @day, @at)`
  );
  let inserted = 0;
  const at = new Date().toISOString();
  const run = db.transaction(() => {
    for (const s of spans) {
      const info = stmt.run({
        source: SOURCE,
        inst: instanceId,
        rowId: s.sourceRowId,
        part: s.partIndex,
        bundle: s.bundleId,
        start: s.startMs,
        end: s.endMs,
        dur: s.durationMs,
        tz: s.tzOffsetS,
        day: s.localDay,
        at,
      });
      if (info.changes > 0) inserted += 1;
    }
  });
  run();
  return { inserted, duplicate: spans.length - inserted };
}

function readCoverage(db: Database.Database): {
  fromMs: number | null;
  toMs: number | null;
} {
  const r = db
    .prepare(
      "SELECT MIN(start_ms) AS a, MAX(end_ms) AS b FROM attention_focus_spans WHERE source = ?"
    )
    .get(SOURCE) as { a: number | null; b: number | null };
  return { fromMs: r.a, toMs: r.b };
}
