import type Database from "better-sqlite3";
import {
  WORK_RECAP_RETENTION_PER_WINDOW,
  type WorkRecapFacts,
  type WorkRecapInference,
  type WorkRecapRun,
  type WorkRecapWindow,
} from "./types.js";

export type InsertRecapInput = {
  windowKey: WorkRecapWindow;
  generatedAt: Date;
  model: string;
  promptVersion: string;
  facts: WorkRecapFacts;
  inference: WorkRecapInference;
};

type WorkRecapRow = {
  id: number;
  window_key: WorkRecapWindow;
  generated_at: string;
  model: string;
  prompt_version: string;
  facts_json: string;
  inference_json: string;
  degraded: number;
  degrade_reason: string | null;
};

function rowToRun(row: WorkRecapRow): WorkRecapRun {
  return {
    id: row.id,
    windowKey: row.window_key,
    generatedAt: new Date(row.generated_at),
    model: row.model,
    promptVersion: row.prompt_version,
    facts: JSON.parse(row.facts_json) as WorkRecapFacts,
    inference: JSON.parse(row.inference_json) as WorkRecapInference,
  };
}

export function insertRecapRun(
  db: Database.Database,
  input: InsertRecapInput
): WorkRecapRun {
  const result = db
    .prepare(
      `INSERT INTO work_recap_runs
         (window_key, generated_at, model, prompt_version,
          facts_json, inference_json, degraded, degrade_reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      input.windowKey,
      input.generatedAt.toISOString(),
      input.model,
      input.promptVersion,
      JSON.stringify(input.facts),
      JSON.stringify(input.inference),
      input.inference.degraded ? 1 : 0,
      input.inference.degradeReason
    );
  return {
    id: Number(result.lastInsertRowid),
    windowKey: input.windowKey,
    generatedAt: input.generatedAt,
    model: input.model,
    promptVersion: input.promptVersion,
    facts: input.facts,
    inference: input.inference,
  };
}

export function getLatestRecapRunByWindow(
  db: Database.Database,
  windowKey: WorkRecapWindow
): WorkRecapRun | null {
  const row = db
    .prepare(
      `SELECT id, window_key, generated_at, model, prompt_version,
              facts_json, inference_json, degraded, degrade_reason
         FROM work_recap_runs
        WHERE window_key = ?
        ORDER BY generated_at DESC
        LIMIT 1`
    )
    .get(windowKey) as WorkRecapRow | undefined;
  return row ? rowToRun(row) : null;
}

export type ListRecapOptions = {
  /** Max rows to return; default 50, hard cap 200. */
  limit?: number;
};

export function listRecapRunsByWindow(
  db: Database.Database,
  windowKey: WorkRecapWindow,
  options: ListRecapOptions = {}
): WorkRecapRun[] {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
  const rows = db
    .prepare(
      `SELECT id, window_key, generated_at, model, prompt_version,
              facts_json, inference_json, degraded, degrade_reason
         FROM work_recap_runs
        WHERE window_key = ?
        ORDER BY generated_at DESC
        LIMIT ?`
    )
    .all(windowKey, limit) as WorkRecapRow[];
  return rows.map(rowToRun);
}

/**
 * Remove recaps older than the newest `keep` per window. Returns the number
 * of rows deleted. Application-level retention (cheap append-only writes,
 * occasional cleanup) avoids a trigger that would fire on every insert.
 */
export function cleanupRetention(
  db: Database.Database,
  windowKey: WorkRecapWindow,
  keep: number = WORK_RECAP_RETENTION_PER_WINDOW
): number {
  if (keep < 1) keep = 1;
  const result = db
    .prepare(
      `DELETE FROM work_recap_runs
        WHERE window_key = ?
          AND id NOT IN (
            SELECT id FROM work_recap_runs
             WHERE window_key = ?
             ORDER BY generated_at DESC, id DESC
             LIMIT ?
          )`
    )
    .run(windowKey, windowKey, keep);
  return result.changes;
}

export function countRecapRunsByWindow(
  db: Database.Database,
  windowKey: WorkRecapWindow
): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM work_recap_runs WHERE window_key = ?`
    )
    .get(windowKey) as { n: number };
  return row.n;
}

/** Load all known `repos.path_canonical` for scanning. */
export function listIndexedRepoPaths(db: Database.Database): string[] {
  const rows = db
    .prepare(`SELECT path_canonical FROM repos ORDER BY first_seen_at ASC`)
    .all() as Array<{ path_canonical: string }>;
  return rows.map((r) => r.path_canonical);
}
