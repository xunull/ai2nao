import { copyFileSync, existsSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import DatabaseCtor from "better-sqlite3";
import { maxMirroredVisitId } from "./queries.js";
import { calendarDayLocalFromChromeUs } from "./time.js";

export type SyncChromeHistoryResult = {
  profile: string;
  sourcePath: string;
  tempPath: string | null;
  insertedUrls: number;
  insertedVisits: number;
  skippedVisits: number;
  errors: string[];
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

/**
 * Copy Chrome `History` to a temp file, open read-only, and INSERT OR IGNORE new visits (+ urls).
 * Does not delete rows in the mirror DB.
 */
export function syncChromeHistory(
  db: Database.Database,
  sourceHistoryPath: string,
  profile: string
): SyncChromeHistoryResult {
  const errors: string[] = [];
  let tempPath: string | null = null;
  let insertedUrls = 0;
  let insertedVisits = 0;
  let skippedVisits = 0;

  if (!existsSync(sourceHistoryPath)) {
    errors.push(`Chrome History not found: ${sourceHistoryPath}`);
    return {
      profile,
      sourcePath: sourceHistoryPath,
      tempPath: null,
      insertedUrls: 0,
      insertedVisits: 0,
      skippedVisits: 0,
      errors,
    };
  }

  tempPath = join(tmpdir(), `ai2nao-chrome-history-${randomUUID()}.sqlite`);
  try {
    copyFileSync(sourceHistoryPath, tempPath);
  } catch (e) {
    errors.push(`copy History failed: ${String(e)}`);
    return {
      profile,
      sourcePath: sourceHistoryPath,
      tempPath,
      insertedUrls: 0,
      insertedVisits: 0,
      skippedVisits: 0,
      errors,
    };
  }

  let sourceDb: Database.Database | undefined;
  try {
    sourceDb = new DatabaseCtor(tempPath, { readonly: true, fileMustExist: true });
  } catch (e) {
    errors.push(`open temp History failed: ${String(e)}`);
    try {
      unlinkSync(tempPath);
    } catch {
      /* ignore */
    }
    return {
      profile,
      sourcePath: sourceHistoryPath,
      tempPath,
      insertedUrls: 0,
      insertedVisits: 0,
      skippedVisits: 0,
      errors,
    };
  }

  const afterId = maxMirroredVisitId(db, profile);

  let rows: SourceVisitRow[];
  try {
    rows = sourceDb
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
      .all(afterId) as SourceVisitRow[];
  } catch (e) {
    errors.push(`read Chrome visits failed: ${String(e)}`);
    sourceDb.close();
    try {
      unlinkSync(tempPath);
    } catch {
      /* ignore */
    }
    return {
      profile,
      sourcePath: sourceHistoryPath,
      tempPath,
      insertedUrls: 0,
      insertedVisits: 0,
      skippedVisits: 0,
      errors,
    };
  }

  const nowIso = new Date().toISOString();
  const insUrl = db.prepare(
    `INSERT OR IGNORE INTO chrome_history_urls (
      id, profile, url, title, visit_count, typed_count, last_visit_time, hidden, inserted_at
    ) VALUES (
      @id, @profile, @url, @title, @visit_count, @typed_count, @last_visit_time, @hidden, @inserted_at
    )`
  );
  const insVisit = db.prepare(
    `INSERT OR IGNORE INTO chrome_history_visits (
      id, profile, url_id, visit_time, from_visit, transition, segment_id, visit_duration,
      calendar_day, inserted_at
    ) VALUES (
      @id, @profile, @url_id, @visit_time, @from_visit, @transition, @segment_id, @visit_duration,
      @calendar_day, @inserted_at
    )`
  );

  const run = db.transaction(() => {
    for (const r of rows) {
      const urlInfo = insUrl.run({
        id: r.url_id,
        profile,
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
  });

  try {
    run();
  } catch (e) {
    errors.push(`mirror insert failed: ${String(e)}`);
  } finally {
    sourceDb.close();
    try {
      unlinkSync(tempPath);
    } catch {
      /* ignore */
    }
  }

  return {
    profile,
    sourcePath: sourceHistoryPath,
    tempPath: null,
    insertedUrls,
    insertedVisits,
    skippedVisits,
    errors,
  };
}
