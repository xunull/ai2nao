import {
  copyFileSync,
  existsSync,
  mkdirSync,
  rmSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import DatabaseCtor from "better-sqlite3";
import {
  maxMirroredDownloadId,
  maxMirroredVisitId,
  maxMirroredVisitIdForProfile,
} from "./queries.js";
import { chromeVisitContentKey } from "./contentKey.js";
import { calendarDayLocalFromChromeDownload, calendarDayLocalFromChromeUs } from "./time.js";

/** Extra diagnostics when `verbose: true` (CLI `--verbose`). */
export type SyncChromeHistoryDebug = {
  currentSourceId: string;
  sourceResetDetected: boolean;
  sourceVisitCount: number;
  sourceVisitMaxId: number;
  mirrorMaxVisitIdBeforeSync: number;
  walFileCopied: boolean;
  shmFileCopied: boolean;
  journalMode: string;
  walCheckpoint: { busy: number; log: number; checkpointed: number } | null;
  downloadsSelectSql: string;
  sourceDownloadCount: number;
  sourceDownloadMaxId: number;
  mirrorMaxDownloadIdBeforeSync: number;
  downloadRowsRead: number;
};

export type SyncChromeHistoryOptions = {
  full?: boolean;
  verbose?: boolean;
};

export type SyncChromeHistoryResult = {
  profile: string;
  sourcePath: string;
  tempPath: string | null;
  insertedUrls: number;
  insertedVisits: number;
  skippedVisits: number;
  insertedDownloads: number;
  skippedDownloads: number;
  errors: string[];
  debug?: SyncChromeHistoryDebug;
};

type SourceVisitRow = {
  id: number;
  url_id: number;
  visit_time: number;
  from_visit: number | null;
  transition: number | null;
  segment_id: number | null;
  visit_duration: number | null;
  url: string;
  title: string | null;
  visit_count: number | null;
  typed_count: number | null;
  last_visit_time: number | null;
  hidden: number | null;
};

type SourceVisitAnchor = {
  id: number;
  visit_time: number;
  url: string;
} | null;

type ChromeHistorySyncState = {
  current_source_id: string;
  max_visit_id: number;
  max_download_id: number;
  anchor_visit_id: number | null;
  anchor_visit_time: number | null;
  anchor_url: string | null;
} | null;

type SourceDownloadRow = {
  id: number;
  guid: string | null;
  current_path: string | null;
  target_path: string | null;
  start_time: number;
  end_time: number | null;
  received_bytes: number | null;
  total_bytes: number | null;
  state: number | null;
  danger_type: number | null;
  interrupt_reason: number | null;
  mime_type: string | null;
  referrer: string | null;
  site_url: string | null;
  tab_url: string | null;
  tab_referrer_url: string | null;
};

const DOWNLOAD_READ_COLUMNS = [
  "id",
  "guid",
  "current_path",
  "target_path",
  "start_time",
  "end_time",
  "received_bytes",
  "total_bytes",
  "state",
  "danger_type",
  "interrupt_reason",
  "mime_type",
  "referrer",
  "site_url",
  "tab_url",
  "tab_referrer_url",
] as const;

function emptyResult(
  profile: string,
  sourceHistoryPath: string,
  tempPath: string | null,
  errors: string[]
): SyncChromeHistoryResult {
  return {
    profile,
    sourcePath: sourceHistoryPath,
    tempPath,
    insertedUrls: 0,
    insertedVisits: 0,
    skippedVisits: 0,
    insertedDownloads: 0,
    skippedDownloads: 0,
    errors,
  };
}

function rmSnapshotDir(dir: string | null): void {
  if (!dir) return;
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

function downloadSelectList(sourceDb: Database.Database): string {
  const info = sourceDb
    .prepare("PRAGMA table_info(downloads)")
    .all() as { name: string }[];
  if (info.length === 0) {
    throw new Error("downloads table missing");
  }
  const names = new Set(info.map((r) => r.name));
  const parts: string[] = [];
  for (const c of DOWNLOAD_READ_COLUMNS) {
    if (names.has(c)) parts.push(c);
  }
  if (!parts.includes("id")) {
    throw new Error("downloads.id missing");
  }
  return parts.join(", ");
}

function mapDownloadRow(row: Record<string, unknown>): SourceDownloadRow {
  const num = (k: string): number | null => {
    const v = row[k];
    if (v == null) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const str = (k: string): string | null => {
    const v = row[k];
    if (v == null) return null;
    if (typeof v === "string") return v;
    if (Buffer.isBuffer(v)) return v.toString("utf8");
    return String(v);
  };
  return {
    id: Number(row.id),
    guid: str("guid"),
    current_path: str("current_path"),
    target_path: str("target_path"),
    start_time: num("start_time") ?? 0,
    end_time: num("end_time"),
    received_bytes: num("received_bytes"),
    total_bytes: num("total_bytes"),
    state: num("state"),
    danger_type: num("danger_type"),
    interrupt_reason: num("interrupt_reason"),
    mime_type: str("mime_type"),
    referrer: str("referrer"),
    site_url: str("site_url"),
    tab_url: str("tab_url"),
    tab_referrer_url: str("tab_referrer_url"),
  };
}

function readSyncState(
  db: Database.Database,
  profile: string,
  sourcePath: string
): ChromeHistorySyncState {
  return db
    .prepare(
      `SELECT current_source_id, max_visit_id, max_download_id,
              anchor_visit_id, anchor_visit_time, anchor_url
       FROM chrome_history_sync_state
       WHERE profile = ? AND source_path = ?`
    )
    .get(profile, sourcePath) as ChromeHistorySyncState;
}

function upsertSyncState(
  db: Database.Database,
  profile: string,
  sourcePath: string,
  sourceId: string,
  maxVisitId: number,
  maxDownloadId: number,
  anchor: SourceVisitAnchor,
  updatedAt: string
): void {
  db.prepare(
    `INSERT INTO chrome_history_sync_state (
       profile, source_path, current_source_id, max_visit_id, max_download_id,
       anchor_visit_id, anchor_visit_time, anchor_url, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(profile, source_path) DO UPDATE SET
       current_source_id = excluded.current_source_id,
       max_visit_id = excluded.max_visit_id,
       max_download_id = excluded.max_download_id,
       anchor_visit_id = excluded.anchor_visit_id,
       anchor_visit_time = excluded.anchor_visit_time,
       anchor_url = excluded.anchor_url,
       updated_at = excluded.updated_at`
  ).run(
    profile,
    sourcePath,
    sourceId,
    maxVisitId,
    maxDownloadId,
    anchor?.id ?? null,
    anchor?.visit_time ?? null,
    anchor?.url ?? null,
    updatedAt
  );
}

function sourceVisitStats(sourceDb: Database.Database): {
  count: number;
  maxId: number;
} {
  return sourceDb.prepare(
    "SELECT COUNT(*) AS count, COALESCE(MAX(id), 0) AS maxId FROM visits"
  ).get() as { count: number; maxId: number };
}

function sourceVisitAnchor(
  sourceDb: Database.Database,
  visitId: number
): SourceVisitAnchor {
  if (visitId <= 0) return null;
  const row = sourceDb
    .prepare(
      `SELECT v.id AS id, v.visit_time AS visit_time, u.url AS url
       FROM visits v
       INNER JOIN urls u ON u.id = v.url
       WHERE v.id = ?`
    )
    .get(visitId) as SourceVisitAnchor;
  return row ?? null;
}

function stateAnchorWasReused(
  sourceDb: Database.Database,
  state: NonNullable<ChromeHistorySyncState>
): boolean {
  if (!state.anchor_visit_id || !state.anchor_visit_time || !state.anchor_url) {
    return false;
  }
  const current = sourceVisitAnchor(sourceDb, state.anchor_visit_id);
  if (!current) return false;
  return (
    current.visit_time !== state.anchor_visit_time ||
    current.url !== state.anchor_url
  );
}

function newSourceId(): string {
  return `chrome-${randomUUID()}`;
}

/**
 * Chrome opens `History` with WAL. Copy `History`, `History-wal`, and `History-shm`
 * into one temp directory so SQLite can see recent rows.
 */
function copyChromeHistorySnapshot(
  sourceHistoryPath: string,
  errors: string[]
): {
  snapDir: string;
  snapHistoryPath: string;
  copiedWal: boolean;
  copiedShm: boolean;
} | null {
  const snapDir = join(tmpdir(), `ai2nao-chrome-snap-${randomUUID()}`);
  const snapHistoryPath = join(snapDir, "History");
  let copiedWal = false;
  let copiedShm = false;
  try {
    mkdirSync(snapDir, { recursive: true });
  } catch (e) {
    errors.push(`create temp dir for History snapshot failed: ${String(e)}`);
    return null;
  }

  try {
    copyFileSync(sourceHistoryPath, snapHistoryPath);
  } catch (e) {
    errors.push(`copy History failed: ${String(e)}`);
    rmSnapshotDir(snapDir);
    return null;
  }

  const sidecars: { src: string; label: string }[] = [
    { src: `${sourceHistoryPath}-wal`, label: "History-wal" },
    { src: `${sourceHistoryPath}-shm`, label: "History-shm" },
  ];
  for (const { src, label } of sidecars) {
    if (!existsSync(src)) continue;
    const dst = `${snapHistoryPath}${src.slice(sourceHistoryPath.length)}`;
    try {
      copyFileSync(src, dst);
      if (label === "History-wal") copiedWal = true;
      if (label === "History-shm") copiedShm = true;
    } catch (e) {
      errors.push(
        `copy ${label} failed (recent visits/downloads may be missing while Chrome is running): ${String(e)}`
      );
    }
  }

  return { snapDir, snapHistoryPath, copiedWal, copiedShm };
}

/**
 * Copy Chrome `History` (+ WAL sidecars) to a temp dir, open read-write to run
 * `wal_checkpoint(FULL)` on the snapshot, then read visits + downloads.
 */
export function syncChromeHistory(
  db: Database.Database,
  sourceHistoryPath: string,
  profile: string,
  options?: SyncChromeHistoryOptions
): SyncChromeHistoryResult {
  const full = options?.full === true;
  const verbose = options?.verbose === true;
  const errors: string[] = [];
  let insertedUrls = 0;
  let insertedVisits = 0;
  let skippedVisits = 0;
  let insertedDownloads = 0;
  let skippedDownloads = 0;
  let debug: SyncChromeHistoryDebug | undefined;

  if (!existsSync(sourceHistoryPath)) {
    errors.push(`Chrome History not found: ${sourceHistoryPath}`);
    return emptyResult(profile, sourceHistoryPath, null, errors);
  }

  const snap = copyChromeHistorySnapshot(sourceHistoryPath, errors);
  if (!snap) {
    return emptyResult(profile, sourceHistoryPath, null, errors);
  }

  const { snapDir, snapHistoryPath, copiedWal, copiedShm } = snap;
  let sourceDb: Database.Database;
  try {
    // Read-write on the *temp copy* so WAL can be checkpointed into the main db file.
    sourceDb = new DatabaseCtor(snapHistoryPath, { fileMustExist: true });
  } catch (e) {
    errors.push(`open temp History failed: ${String(e)}`);
    rmSnapshotDir(snapDir);
    return emptyResult(profile, sourceHistoryPath, snapHistoryPath, errors);
  }

  let walCheckpoint: { busy: number; log: number; checkpointed: number } | null =
    null;
  try {
    const row = sourceDb.prepare("PRAGMA wal_checkpoint(FULL)").get() as
      | { busy: number; log: number; checkpointed: number }
      | undefined;
    walCheckpoint = row ?? null;
  } catch (e) {
    errors.push(`wal_checkpoint(FULL) on snapshot failed: ${String(e)}`);
  }

  const journalMode = String(
    sourceDb.pragma("journal_mode", { simple: true }) ?? "?"
  );

  let sourceVisitCount = 0;
  let sourceVisitMaxId = 0;
  try {
    const stats = sourceVisitStats(sourceDb);
    sourceVisitCount = stats.count;
    sourceVisitMaxId = stats.maxId;
  } catch (e) {
    errors.push(`inspect Chrome visits table failed: ${String(e)}`);
  }

  const state = readSyncState(db, profile, sourceHistoryPath);
  const legacyMirrorMaxVisitId = maxMirroredVisitIdForProfile(db, profile);
  let currentSourceId = state?.current_source_id ?? "legacy";
  let sourceResetDetected = false;
  if (state) {
    sourceResetDetected =
      sourceVisitMaxId < state.max_visit_id ||
      stateAnchorWasReused(sourceDb, state);
    if (sourceResetDetected) currentSourceId = newSourceId();
  } else if (
    legacyMirrorMaxVisitId > 0 &&
    sourceVisitMaxId < legacyMirrorMaxVisitId
  ) {
    sourceResetDetected = true;
    currentSourceId = newSourceId();
  }

  const afterVisitId = full || sourceResetDetected
    ? 0
    : maxMirroredVisitId(db, profile, currentSourceId);
  const afterDownloadId = full || sourceResetDetected
    ? 0
    : maxMirroredDownloadId(db, profile, currentSourceId);

  let downloadsSelectSql = "";
  let sourceDownloadCount = 0;
  let sourceDownloadMaxId = 0;
  try {
    const sel = downloadSelectList(sourceDb);
    downloadsSelectSql = `SELECT ${sel} FROM downloads WHERE id > ? ORDER BY id`;
    sourceDownloadMaxId = (
      sourceDb
        .prepare("SELECT COALESCE(MAX(id), 0) AS m FROM downloads")
        .get() as { m: number }
    ).m;
    if (verbose) {
      sourceDownloadCount = (
        sourceDb.prepare("SELECT COUNT(*) AS c FROM downloads").get() as {
          c: number;
        }
      ).c;
    }
  } catch (e) {
    errors.push(`inspect Chrome downloads table failed: ${String(e)}`);
  }

  let visitRows: SourceVisitRow[] = [];
  try {
    visitRows = sourceDb
      .prepare(
        `SELECT v.id AS id, v.url AS url_id, v.visit_time AS visit_time,
                v.from_visit AS from_visit, v.transition AS transition,
                v.segment_id AS segment_id, v.visit_duration AS visit_duration,
                u.url AS url, u.title AS title, u.visit_count AS visit_count,
                u.typed_count AS typed_count, u.last_visit_time AS last_visit_time,
                u.hidden AS hidden
         FROM visits v
         INNER JOIN urls u ON u.id = v.url
         WHERE v.id > ?
         ORDER BY v.id`
      )
      .all(afterVisitId) as SourceVisitRow[];
  } catch (e) {
    errors.push(`read Chrome visits failed: ${String(e)}`);
  }

  let downloadRows: SourceDownloadRow[] = [];
  if (downloadsSelectSql) {
    try {
      const raw = sourceDb
        .prepare(downloadsSelectSql)
        .all(afterDownloadId) as Record<string, unknown>[];
      downloadRows = raw.map((r) => mapDownloadRow(r));
    } catch (e) {
      errors.push(`read Chrome downloads failed: ${String(e)}`);
    }
  }

  if (verbose) {
    debug = {
      currentSourceId,
      sourceResetDetected,
      sourceVisitCount,
      sourceVisitMaxId,
      mirrorMaxVisitIdBeforeSync: afterVisitId,
      walFileCopied: copiedWal,
      shmFileCopied: copiedShm,
      journalMode,
      walCheckpoint: walCheckpoint,
      downloadsSelectSql,
      sourceDownloadCount,
      sourceDownloadMaxId,
      mirrorMaxDownloadIdBeforeSync: afterDownloadId,
      downloadRowsRead: downloadRows.length,
    };
  }

  const nowIso = new Date().toISOString();
  const insUrl = db.prepare(
    `INSERT OR IGNORE INTO chrome_history_urls (
      id, profile, source_id, url, title, visit_count, typed_count, last_visit_time, hidden, inserted_at
    ) VALUES (
      @id, @profile, @source_id, @url, @title, @visit_count, @typed_count, @last_visit_time, @hidden, @inserted_at
    )`
  );
  const insVisit = db.prepare(
    `INSERT OR IGNORE INTO chrome_history_visits (
      id, profile, source_id, content_key, url_id, visit_time, from_visit, transition, segment_id, visit_duration,
      calendar_day, inserted_at
    ) VALUES (
      @id, @profile, @source_id, @content_key, @url_id, @visit_time, @from_visit, @transition, @segment_id, @visit_duration,
      @calendar_day, @inserted_at
    )`
  );
  const insDl = db.prepare(
    `INSERT OR IGNORE INTO chrome_downloads (
      id, profile, source_id, guid, current_path, target_path, start_time, end_time,
      received_bytes, total_bytes, state, danger_type, interrupt_reason,
      mime_type, referrer, site_url, tab_url, tab_referrer_url,
      calendar_day, inserted_at
    ) VALUES (
      @id, @profile, @source_id, @guid, @current_path, @target_path, @start_time, @end_time,
      @received_bytes, @total_bytes, @state, @danger_type, @interrupt_reason,
      @mime_type, @referrer, @site_url, @tab_url, @tab_referrer_url,
      @calendar_day, @inserted_at
    )`
  );

  const run = db.transaction(() => {
    for (const r of visitRows) {
      const urlInfo = insUrl.run({
        id: r.url_id,
        profile,
        source_id: currentSourceId,
        url: r.url,
        title: r.title,
        visit_count: r.visit_count ?? 0,
        typed_count: r.typed_count ?? 0,
        last_visit_time: r.last_visit_time ?? 0,
        hidden: r.hidden ?? 0,
        inserted_at: nowIso,
      });
      if (urlInfo.changes > 0) insertedUrls += 1;

      const cal = calendarDayLocalFromChromeUs(r.visit_time);
      const vInfo = insVisit.run({
        id: r.id,
        profile,
        source_id: currentSourceId,
        content_key: chromeVisitContentKey(r),
        url_id: r.url_id,
        visit_time: r.visit_time,
        from_visit: r.from_visit,
        transition: r.transition,
        segment_id: r.segment_id,
        visit_duration: r.visit_duration,
        calendar_day: cal,
        inserted_at: nowIso,
      });
      if (vInfo.changes > 0) insertedVisits += 1;
      else skippedVisits += 1;
    }

    for (const d of downloadRows) {
      const cal = calendarDayLocalFromChromeDownload(d.end_time, d.start_time);
      const dInfo = insDl.run({
        id: d.id,
        profile,
        source_id: currentSourceId,
        guid: d.guid,
        current_path: d.current_path,
        target_path: d.target_path,
        start_time: d.start_time,
        end_time: d.end_time,
        received_bytes: d.received_bytes,
        total_bytes: d.total_bytes,
        state: d.state,
        danger_type: d.danger_type,
        interrupt_reason: d.interrupt_reason,
        mime_type: d.mime_type,
        referrer: d.referrer,
        site_url: d.site_url,
        tab_url: d.tab_url,
        tab_referrer_url: d.tab_referrer_url,
        calendar_day: cal,
        inserted_at: nowIso,
      });
      if (dInfo.changes > 0) insertedDownloads += 1;
      else skippedDownloads += 1;
    }

    const newestVisit = sourceVisitAnchor(sourceDb, sourceVisitMaxId);
    upsertSyncState(
      db,
      profile,
      sourceHistoryPath,
      currentSourceId,
      Math.max(afterVisitId, sourceVisitMaxId),
      Math.max(afterDownloadId, sourceDownloadMaxId),
      newestVisit,
      nowIso
    );
  });

  try {
    run();
  } catch (e) {
    errors.push(`mirror insert failed: ${String(e)}`);
  } finally {
    sourceDb.close();
    rmSnapshotDir(snapDir);
  }

  const result: SyncChromeHistoryResult = {
    profile,
    sourcePath: sourceHistoryPath,
    tempPath: null,
    insertedUrls,
    insertedVisits,
    skippedVisits,
    insertedDownloads,
    skippedDownloads,
    errors,
  };
  if (debug) result.debug = debug;
  return result;
}
