import type Database from "better-sqlite3";
import { finishInventorySyncRun, startInventorySyncRun } from "../localInventory/syncRuns.js";
import { setInventorySyncStateValue } from "../localInventory/state.js";
import type { InventoryWarning, SyncCounts } from "../localInventory/types.js";
import { resolveLmStudioModelsRoot, type LmStudioRootAlternative } from "./roots.js";
import { scanLmStudioModels, type LmStudioModelScan, type ScanLmStudioModelsResult } from "./scan.js";

export type SyncLmStudioOptions = {
  root?: string;
  now?: () => Date;
  env?: NodeJS.ProcessEnv;
  paths?: { appSettingsPath?: string; homeSettingsPath?: string };
};

export type SyncLmStudioResult = SyncCounts & {
  ok: boolean;
  status: "success" | "partial" | "failed";
  modelsRoot: string;
  rootSource: string;
  settingsPath: string | null;
  alternativeRoots: LmStudioRootAlternative[];
  warnings: InventoryWarning[];
  errorSummary: string | null;
  runId: number;
};

export function syncLmStudioModels(db: Database.Database, opts: SyncLmStudioOptions = {}): SyncLmStudioResult {
  const now = opts.now ?? (() => new Date());
  const resolved = resolveLmStudioModelsRoot(opts.root, opts.env, opts.paths);
  const runId = startInventorySyncRun(
    db,
    "lmstudio",
    {
      modelsRoot: resolved.modelsRoot,
      rootSource: resolved.source,
      settingsPath: resolved.settingsPath,
      alternativeRoots: resolved.alternativeRoots,
    },
    now()
  );

  let scanned: ScanLmStudioModelsResult;
  try {
    scanned = scanLmStudioModels(resolved.modelsRoot);
  } catch (e) {
    return fail(db, runId, resolved, e instanceof Error ? e.message : String(e), now);
  }

  const warnings = [
    ...resolved.warnings.filter((w) => w.code !== "models_root_missing"),
    ...scanned.warnings,
    ...scanned.models.flatMap((m) => [...m.warnings, ...m.files.flatMap((f) => f.warnings)]),
  ];
  const counts = upsertLmStudioModels(db, scanned, now().toISOString());
  const status = warnings.length > 0 ? "partial" : "success";
  const errorSummary = warnings.slice(0, 5).map((w) => w.message).join("\n") || null;
  finishInventorySyncRun(db, runId, {
    status,
    ...counts,
    warningsCount: warnings.length,
    errorSummary,
    metadata: {
      modelsRoot: scanned.modelsRoot,
      rootSource: resolved.source,
      settingsPath: resolved.settingsPath,
      alternativeRoots: resolved.alternativeRoots,
    },
    now: now(),
  });
  setInventorySyncStateValue(db, "lmstudio.last_sync_at", now().toISOString());
  setInventorySyncStateValue(db, "lmstudio.last_sync_error", status === "partial" ? errorSummary : null);
  setInventorySyncStateValue(db, "lmstudio.models_root", scanned.modelsRoot);
  return {
    ok: true,
    status,
    modelsRoot: scanned.modelsRoot,
    rootSource: resolved.source,
    settingsPath: resolved.settingsPath,
    alternativeRoots: resolved.alternativeRoots,
    warnings,
    errorSummary,
    runId,
    ...counts,
  };
}

function upsertLmStudioModels(db: Database.Database, scanned: ScanLmStudioModelsResult, nowIso: string): SyncCounts {
  const tx = db.transaction(() => {
    let inserted = 0;
    let updated = 0;
    const existing = db.prepare("SELECT id FROM lmstudio_models WHERE models_root = ? AND model_key = ?");
    const upsert = db.prepare(
      `INSERT INTO lmstudio_models (
        publisher, model_name, model_key, models_root, model_dir, format,
        weight_file_count, auxiliary_file_count, total_file_count,
        total_size_bytes, weight_size_bytes, primary_file, config_json,
        warnings_json, metadata_json, last_modified_ms, first_seen_at,
        last_seen_at, missing_since, inserted_at, updated_at
      ) VALUES (
        @publisher, @modelName, @modelKey, @modelsRoot, @modelDir, @format,
        @weightFileCount, @auxiliaryFileCount, @totalFileCount,
        @totalSizeBytes, @weightSizeBytes, @primaryFile, @configJson,
        @warningsJson, @metadataJson, @lastModifiedMs, @now,
        @now, NULL, @now, @now
      )
      ON CONFLICT(models_root, model_key) DO UPDATE SET
        publisher = excluded.publisher,
        model_name = excluded.model_name,
        model_dir = excluded.model_dir,
        format = excluded.format,
        weight_file_count = excluded.weight_file_count,
        auxiliary_file_count = excluded.auxiliary_file_count,
        total_file_count = excluded.total_file_count,
        total_size_bytes = excluded.total_size_bytes,
        weight_size_bytes = excluded.weight_size_bytes,
        primary_file = excluded.primary_file,
        config_json = excluded.config_json,
        warnings_json = excluded.warnings_json,
        metadata_json = excluded.metadata_json,
        last_modified_ms = excluded.last_modified_ms,
        last_seen_at = excluded.last_seen_at,
        missing_since = NULL,
        updated_at = excluded.updated_at`
    );
    const deleteFiles = db.prepare("DELETE FROM lmstudio_model_files WHERE model_id = ?");
    const insertFile = db.prepare(
      `INSERT INTO lmstudio_model_files (
        model_id, rel_path, file_kind, format, size_bytes, target_path,
        is_symlink, last_modified_ms, warnings_json, inserted_at, updated_at
      ) VALUES (
        @modelId, @relPath, @fileKind, @format, @sizeBytes, @targetPath,
        @isSymlink, @lastModifiedMs, @warningsJson, @now, @now
      )`
    );

    for (const model of scanned.models) {
      const wasExisting = existing.get(scanned.modelsRoot, model.modelKey) != null;
      upsert.run(modelParams(model, nowIso));
      if (wasExisting) updated++;
      else inserted++;
      const row = existing.get(scanned.modelsRoot, model.modelKey) as { id: number };
      deleteFiles.run(row.id);
      for (const file of model.files) {
        insertFile.run({
          modelId: row.id,
          relPath: file.relPath,
          fileKind: file.fileKind,
          format: file.format,
          sizeBytes: file.sizeBytes,
          targetPath: file.targetPath,
          isSymlink: file.isSymlink ? 1 : 0,
          lastModifiedMs: file.lastModifiedMs,
          warningsJson: JSON.stringify(file.warnings),
          now: nowIso,
        });
      }
    }

    const seen = new Set(scanned.models.map((m) => m.modelKey));
    const rows = db
      .prepare("SELECT id, model_key FROM lmstudio_models WHERE models_root = ? AND missing_since IS NULL")
      .all(scanned.modelsRoot) as { id: number; model_key: string }[];
    const markMissing = db.prepare("UPDATE lmstudio_models SET missing_since = ?, updated_at = ? WHERE id = ?");
    let markedMissing = 0;
    for (const row of rows) {
      if (seen.has(row.model_key)) continue;
      markedMissing += markMissing.run(nowIso, nowIso, row.id).changes;
    }
    return { inserted, updated, markedMissing };
  });
  return tx();
}

function modelParams(model: LmStudioModelScan, now: string) {
  return {
    publisher: model.publisher,
    modelName: model.modelName,
    modelKey: model.modelKey,
    modelsRoot: model.modelsRoot,
    modelDir: model.modelDir,
    format: model.format,
    weightFileCount: model.weightFileCount,
    auxiliaryFileCount: model.auxiliaryFileCount,
    totalFileCount: model.totalFileCount,
    totalSizeBytes: model.totalSizeBytes,
    weightSizeBytes: model.weightSizeBytes,
    primaryFile: model.primaryFile,
    configJson: model.configJson,
    warningsJson: JSON.stringify(model.warnings),
    metadataJson: JSON.stringify({}),
    lastModifiedMs: model.lastModifiedMs,
    now,
  };
}

function fail(
  db: Database.Database,
  runId: number,
  resolved: ReturnType<typeof resolveLmStudioModelsRoot>,
  message: string,
  now: () => Date
): SyncLmStudioResult {
  finishInventorySyncRun(db, runId, {
    status: "failed",
    inserted: 0,
    updated: 0,
    markedMissing: 0,
    warningsCount: resolved.warnings.length,
    errorSummary: message,
    metadata: {
      modelsRoot: resolved.modelsRoot,
      rootSource: resolved.source,
      settingsPath: resolved.settingsPath,
      alternativeRoots: resolved.alternativeRoots,
    },
    now: now(),
  });
  setInventorySyncStateValue(db, "lmstudio.last_sync_error", message);
  return {
    ok: false,
    status: "failed",
    modelsRoot: resolved.modelsRoot,
    rootSource: resolved.source,
    settingsPath: resolved.settingsPath,
    alternativeRoots: resolved.alternativeRoots,
    warnings: resolved.warnings,
    errorSummary: message,
    runId,
    inserted: 0,
    updated: 0,
    markedMissing: 0,
  };
}
