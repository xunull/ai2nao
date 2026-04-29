import type Database from "better-sqlite3";
import {
  finishInventorySyncRun,
  startInventorySyncRun,
} from "../localInventory/syncRuns.js";
import { setInventorySyncStateValue } from "../localInventory/state.js";
import type { InventoryWarning, SyncCounts } from "../localInventory/types.js";
import { resolveHuggingfaceHubCacheRoot } from "./roots.js";
import {
  scanHuggingfaceCache,
  type HuggingfaceModelScan,
  type ScanHuggingfaceCacheResult,
} from "./scan.js";

export type SyncHuggingfaceOptions = {
  root?: string;
  now?: () => Date;
  env?: NodeJS.ProcessEnv;
};

export type SyncHuggingfaceResult = SyncCounts & {
  ok: boolean;
  status: "success" | "partial" | "failed";
  cacheRoot: string;
  rootSource: string;
  warnings: InventoryWarning[];
  errorSummary: string | null;
  runId: number;
};

export function syncHuggingfaceModels(
  db: Database.Database,
  opts: SyncHuggingfaceOptions = {}
): SyncHuggingfaceResult {
  const now = opts.now ?? (() => new Date());
  const resolved = resolveHuggingfaceHubCacheRoot(opts.root, opts.env);
  const runId = startInventorySyncRun(
    db,
    "huggingface",
    { cacheRoot: resolved.cacheRoot, rootSource: resolved.source },
    now()
  );

  let scanned: ScanHuggingfaceCacheResult;
  try {
    scanned = scanHuggingfaceCache(resolved.cacheRoot);
  } catch (e) {
    return fail(
      db,
      runId,
      resolved.cacheRoot,
      resolved.source,
      e instanceof Error ? e.message : String(e),
      now
    );
  }

  const warnings = [
    ...scanned.warnings,
    ...scanned.models.flatMap((m) => [
      ...m.warnings,
      ...m.revisions.flatMap((r) => r.warnings),
    ]),
  ];
  const counts = upsertHuggingfaceModels(db, scanned, now().toISOString());
  const status = warnings.length > 0 ? "partial" : "success";
  const errorSummary = warnings.slice(0, 5).map((w) => w.message).join("\n") || null;
  finishInventorySyncRun(db, runId, {
    status,
    ...counts,
    warningsCount: warnings.length,
    errorSummary,
    metadata: { cacheRoot: scanned.cacheRoot, rootSource: resolved.source },
    now: now(),
  });
  setInventorySyncStateValue(db, "huggingface.last_sync_at", now().toISOString());
  setInventorySyncStateValue(
    db,
    "huggingface.last_sync_error",
    status === "partial" ? errorSummary : null
  );
  setInventorySyncStateValue(db, "huggingface.cache_root", scanned.cacheRoot);
  return {
    ok: true,
    status,
    cacheRoot: scanned.cacheRoot,
    rootSource: resolved.source,
    warnings,
    errorSummary,
    runId,
    ...counts,
  };
}

function upsertHuggingfaceModels(
  db: Database.Database,
  scanned: ScanHuggingfaceCacheResult,
  nowIso: string
): SyncCounts {
  const tx = db.transaction(() => {
    let inserted = 0;
    let updated = 0;
    const existing = db.prepare(
      "SELECT id FROM huggingface_models WHERE cache_root = ? AND repo_type = ? AND repo_id = ?"
    );
    const upsert = db.prepare(
      `INSERT INTO huggingface_models (
        repo_type, repo_id, cache_root, cache_dir, refs_json, snapshot_count,
        blob_count, size_bytes, warnings_json, first_seen_at, last_seen_at,
        missing_since, inserted_at, updated_at
      ) VALUES (
        @repoType, @repoId, @cacheRoot, @cacheDir, @refsJson, @snapshotCount,
        @blobCount, @sizeBytes, @warningsJson, @now, @now, NULL, @now, @now
      )
      ON CONFLICT(cache_root, repo_type, repo_id) DO UPDATE SET
        cache_dir = excluded.cache_dir,
        refs_json = excluded.refs_json,
        snapshot_count = excluded.snapshot_count,
        blob_count = excluded.blob_count,
        size_bytes = excluded.size_bytes,
        warnings_json = excluded.warnings_json,
        last_seen_at = excluded.last_seen_at,
        missing_since = NULL,
        updated_at = excluded.updated_at`
    );
    const deleteRevisions = db.prepare("DELETE FROM huggingface_model_revisions WHERE model_id = ?");
    const insertRevision = db.prepare(
      `INSERT INTO huggingface_model_revisions (
        model_id, revision, snapshot_path, refs_json, file_count, last_modified_ms,
        warnings_json, inserted_at, updated_at
      ) VALUES (
        @modelId, @revision, @snapshotPath, @refsJson, @fileCount, @lastModifiedMs,
        @warningsJson, @now, @now
      )`
    );

    for (const model of scanned.models) {
      const wasExisting = existing.get(scanned.cacheRoot, model.repoType, model.repoId) != null;
      upsert.run(modelParams(model, nowIso));
      if (wasExisting) updated++;
      else inserted++;
      const row = existing.get(scanned.cacheRoot, model.repoType, model.repoId) as { id: number };
      deleteRevisions.run(row.id);
      for (const revision of model.revisions) {
        insertRevision.run({
          modelId: row.id,
          revision: revision.revision,
          snapshotPath: revision.snapshotPath,
          refsJson: JSON.stringify(revision.refs),
          fileCount: revision.fileCount,
          lastModifiedMs: revision.lastModifiedMs,
          warningsJson: JSON.stringify(revision.warnings),
          now: nowIso,
        });
      }
    }

    const seen = new Set(scanned.models.map((m) => `${m.repoType}\0${m.repoId}`));
    const rows = db
      .prepare(
        `SELECT id, repo_type, repo_id FROM huggingface_models
         WHERE cache_root = ? AND missing_since IS NULL`
      )
      .all(scanned.cacheRoot) as { id: number; repo_type: string; repo_id: string }[];
    const markMissing = db.prepare(
      "UPDATE huggingface_models SET missing_since = ?, updated_at = ? WHERE id = ?"
    );
    let markedMissing = 0;
    for (const row of rows) {
      if (seen.has(`${row.repo_type}\0${row.repo_id}`)) continue;
      markedMissing += markMissing.run(nowIso, nowIso, row.id).changes;
    }

    return { inserted, updated, markedMissing };
  });
  return tx();
}

function modelParams(model: HuggingfaceModelScan, now: string) {
  return {
    repoType: model.repoType,
    repoId: model.repoId,
    cacheRoot: model.cacheRoot,
    cacheDir: model.cacheDir,
    refsJson: JSON.stringify(model.refs),
    snapshotCount: model.snapshotCount,
    blobCount: model.blobCount,
    sizeBytes: model.sizeBytes,
    warningsJson: JSON.stringify(model.warnings),
    now,
  };
}

function fail(
  db: Database.Database,
  runId: number,
  cacheRoot: string,
  rootSource: string,
  message: string,
  now: () => Date
): SyncHuggingfaceResult {
  finishInventorySyncRun(db, runId, {
    status: "failed",
    inserted: 0,
    updated: 0,
    markedMissing: 0,
    warningsCount: 0,
    errorSummary: message,
    metadata: { cacheRoot, rootSource },
    now: now(),
  });
  setInventorySyncStateValue(db, "huggingface.last_sync_error", message);
  return {
    ok: false,
    status: "failed",
    cacheRoot,
    rootSource,
    warnings: [],
    errorSummary: message,
    runId,
    inserted: 0,
    updated: 0,
    markedMissing: 0,
  };
}
