import type Database from "better-sqlite3";
import type { LocalInventorySource, SyncRunStatus } from "./types.js";

export type FinishInventorySyncRunInput = {
  status: Exclude<SyncRunStatus, "running">;
  inserted: number;
  updated: number;
  markedMissing: number;
  warningsCount: number;
  errorSummary?: string | null;
  metadata?: Record<string, unknown>;
  now?: Date;
};

export type InventorySyncRunRow = {
  id: number;
  source: LocalInventorySource;
  started_at: string;
  finished_at: string | null;
  status: SyncRunStatus;
  inserted: number;
  updated: number;
  marked_missing: number;
  warnings_count: number;
  error_summary: string | null;
  metadata_json: string;
};

export function startInventorySyncRun(
  db: Database.Database,
  source: LocalInventorySource,
  metadata: Record<string, unknown> = {},
  now = new Date()
): number {
  const info = db
    .prepare(
      `INSERT INTO local_inventory_sync_runs (
        source, started_at, status, metadata_json
      ) VALUES (?, ?, 'running', ?)`
    )
    .run(source, now.toISOString(), JSON.stringify(metadata));
  return Number(info.lastInsertRowid);
}

export function finishInventorySyncRun(
  db: Database.Database,
  runId: number,
  input: FinishInventorySyncRunInput
): void {
  const existing = getInventorySyncRun(db, runId);
  const mergedMetadata = {
    ...(existing ? safeJsonObject(existing.metadata_json) : {}),
    ...(input.metadata ?? {}),
  };
  db.prepare(
    `UPDATE local_inventory_sync_runs
     SET finished_at = @finished_at,
         status = @status,
         inserted = @inserted,
         updated = @updated,
         marked_missing = @marked_missing,
         warnings_count = @warnings_count,
         error_summary = @error_summary,
         metadata_json = @metadata_json
     WHERE id = @id`
  ).run({
    id: runId,
    finished_at: (input.now ?? new Date()).toISOString(),
    status: input.status,
    inserted: input.inserted,
    updated: input.updated,
    marked_missing: input.markedMissing,
    warnings_count: input.warningsCount,
    error_summary: input.errorSummary ?? null,
    metadata_json: JSON.stringify(mergedMetadata),
  });
}

export function getLatestInventorySyncRun(
  db: Database.Database,
  source: LocalInventorySource
): InventorySyncRunRow | null {
  return (
    (db
      .prepare(
        `SELECT id, source, started_at, finished_at, status, inserted, updated,
                marked_missing, warnings_count, error_summary, metadata_json
         FROM local_inventory_sync_runs
         WHERE source = ?
         ORDER BY started_at DESC, id DESC
         LIMIT 1`
      )
      .get(source) as InventorySyncRunRow | undefined) ?? null
  );
}

function getInventorySyncRun(
  db: Database.Database,
  id: number
): InventorySyncRunRow | null {
  return (
    (db
      .prepare(
        `SELECT id, source, started_at, finished_at, status, inserted, updated,
                marked_missing, warnings_count, error_summary, metadata_json
         FROM local_inventory_sync_runs
         WHERE id = ?`
      )
      .get(id) as InventorySyncRunRow | undefined) ?? null
  );
}

function safeJsonObject(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    /* ignore corrupt historical metadata */
  }
  return {};
}
