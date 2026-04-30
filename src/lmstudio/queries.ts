import type Database from "better-sqlite3";
import { getLatestInventorySyncRun } from "../localInventory/syncRuns.js";
import type { PageResult } from "../software/types.js";
import { resolveLmStudioModelsRoot, type LmStudioRootAlternative } from "./roots.js";
import type { LmStudioModelFormat } from "./scan.js";

export type LmStudioModelFileRow = {
  rel_path: string;
  file_kind: "weight" | "auxiliary";
  format: string;
  size_bytes: number;
  target_path: string | null;
  is_symlink: number;
  last_modified_ms: number | null;
  warnings: unknown[];
};

export type LmStudioModelRow = {
  id: number;
  publisher: string;
  model_name: string;
  model_key: string;
  models_root: string;
  model_dir: string;
  format: LmStudioModelFormat;
  weight_file_count: number;
  auxiliary_file_count: number;
  total_file_count: number;
  total_size_bytes: number;
  weight_size_bytes: number;
  primary_file: string | null;
  warnings_json: string;
  last_modified_ms: number | null;
  last_seen_at: string;
  missing_since: string | null;
  updated_at: string;
  files: LmStudioModelFileRow[];
};

export type LmStudioListOptions = {
  q?: string;
  format?: string;
  includeMissing?: boolean;
  modelsRoot?: string;
  limit: number;
  offset: number;
};

export function getLmStudioStatus(db: Database.Database, root?: string) {
  const resolved = resolveLmStudioModelsRoot(root);
  const counts = db
    .prepare(
      `SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN missing_since IS NULL THEN 1 ELSE 0 END) AS active,
        SUM(CASE WHEN missing_since IS NOT NULL THEN 1 ELSE 0 END) AS missing,
        COALESCE(SUM(CASE WHEN missing_since IS NULL THEN total_size_bytes ELSE 0 END), 0) AS total_size_bytes,
        COALESCE(MAX(CASE WHEN missing_since IS NULL THEN total_size_bytes ELSE 0 END), 0) AS largest_size_bytes
       FROM lmstudio_models
       WHERE models_root = ?`
    )
    .get(resolved.modelsRoot) as {
    total: number;
    active: number | null;
    missing: number | null;
    total_size_bytes: number | null;
    largest_size_bytes: number | null;
  };
  const largest = db
    .prepare(
      `SELECT model_key, total_size_bytes FROM lmstudio_models
       WHERE models_root = ? AND missing_since IS NULL
       ORDER BY total_size_bytes DESC, model_key COLLATE NOCASE
       LIMIT 1`
    )
    .get(resolved.modelsRoot) as { model_key: string; total_size_bytes: number } | undefined;
  return {
    modelsRoot: resolved.modelsRoot,
    rootSource: resolved.source,
    settingsPath: resolved.settingsPath,
    alternativeRoots: resolved.alternativeRoots,
    warnings: resolved.warnings,
    counts: {
      total: counts.total,
      active: counts.active ?? 0,
      missing: counts.missing ?? 0,
      totalSizeBytes: counts.total_size_bytes ?? 0,
      largestSizeBytes: counts.largest_size_bytes ?? 0,
      largestModel: largest?.model_key ?? null,
    },
    lastRun: getLatestInventorySyncRun(db, "lmstudio"),
  };
}

export function listLmStudioModels(db: Database.Database, opts: LmStudioListOptions): PageResult<LmStudioModelRow> {
  const where = ["1 = 1"];
  const params: unknown[] = [];
  if (!opts.includeMissing) where.push("missing_since IS NULL");
  if (opts.modelsRoot) {
    where.push("models_root = ?");
    params.push(opts.modelsRoot);
  }
  if (opts.q) {
    where.push("model_key LIKE ?");
    params.push(`%${opts.q}%`);
  }
  if (opts.format) {
    where.push("format = ?");
    params.push(opts.format);
  }
  const clause = `WHERE ${where.join(" AND ")}`;
  const total = (db.prepare(`SELECT COUNT(*) AS n FROM lmstudio_models ${clause}`).get(...params) as { n: number }).n;
  const rows = db
    .prepare(
      `SELECT id, publisher, model_name, model_key, models_root, model_dir,
              format, weight_file_count, auxiliary_file_count, total_file_count,
              total_size_bytes, weight_size_bytes, primary_file, warnings_json,
              last_modified_ms, last_seen_at, missing_since, updated_at
       FROM lmstudio_models
       ${clause}
       ORDER BY missing_since IS NOT NULL, total_size_bytes DESC, model_key COLLATE NOCASE
       LIMIT ? OFFSET ?`
    )
    .all(...params, opts.limit, opts.offset) as Omit<LmStudioModelRow, "files">[];
  const files = db.prepare(
    `SELECT rel_path, file_kind, format, size_bytes, target_path, is_symlink,
            last_modified_ms, warnings_json
     FROM lmstudio_model_files
     WHERE model_id = ?
     ORDER BY file_kind DESC, size_bytes DESC, rel_path COLLATE NOCASE`
  );
  return {
    rows: rows.map((row) => ({
      ...row,
      format: row.format as LmStudioModelFormat,
      files: (files.all(row.id) as {
        rel_path: string;
        file_kind: "weight" | "auxiliary";
        format: string;
        size_bytes: number;
        target_path: string | null;
        is_symlink: number;
        last_modified_ms: number | null;
        warnings_json: string;
      }[]).map((f) => ({
        rel_path: f.rel_path,
        file_kind: f.file_kind,
        format: f.format,
        size_bytes: f.size_bytes,
        target_path: f.target_path,
        is_symlink: f.is_symlink,
        last_modified_ms: f.last_modified_ms,
        warnings: safeJsonArray(f.warnings_json),
      })),
    })),
    total,
    limit: opts.limit,
    offset: opts.offset,
  };
}

export function parseLmStudioFormat(raw: string | undefined): LmStudioModelFormat | undefined {
  const t = (raw ?? "").trim();
  if (["gguf", "mlx_safetensors", "safetensors", "mixed", "unknown"].includes(t)) return t as LmStudioModelFormat;
  return undefined;
}

export type { LmStudioRootAlternative };

function safeJsonArray(raw: string): unknown[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
