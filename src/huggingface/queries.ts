import type Database from "better-sqlite3";
import { getLatestInventorySyncRun } from "../localInventory/syncRuns.js";
import type { PageResult } from "../software/types.js";
import { resolveHuggingfaceHubCacheRoot } from "./roots.js";

export type HuggingfaceModelRow = {
  id: number;
  repo_type: "model";
  repo_id: string;
  cache_root: string;
  cache_dir: string;
  refs_json: string;
  snapshot_count: number;
  blob_count: number;
  size_bytes: number;
  warnings_json: string;
  last_seen_at: string;
  missing_since: string | null;
  updated_at: string;
  revisions: {
    revision: string;
    refs: string[];
    file_count: number;
    last_modified_ms: number | null;
    warnings: unknown[];
  }[];
};

export type HuggingfaceListOptions = {
  q?: string;
  includeMissing?: boolean;
  cacheRoot?: string;
  limit: number;
  offset: number;
};

export function getHuggingfaceStatus(db: Database.Database, root?: string) {
  const resolved = resolveHuggingfaceHubCacheRoot(root);
  const counts = db
    .prepare(
      `SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN missing_since IS NULL THEN 1 ELSE 0 END) AS active,
        SUM(CASE WHEN missing_since IS NOT NULL THEN 1 ELSE 0 END) AS missing,
        COALESCE(SUM(CASE WHEN missing_since IS NULL THEN size_bytes ELSE 0 END), 0) AS total_size_bytes,
        COALESCE(MAX(CASE WHEN missing_since IS NULL THEN size_bytes ELSE 0 END), 0) AS largest_size_bytes
       FROM huggingface_models
       WHERE cache_root = ? AND repo_type = 'model'`
    )
    .get(resolved.cacheRoot) as {
    total: number;
    active: number | null;
    missing: number | null;
    total_size_bytes: number | null;
    largest_size_bytes: number | null;
  };
  const largest = db
    .prepare(
      `SELECT repo_id, size_bytes FROM huggingface_models
       WHERE cache_root = ? AND repo_type = 'model' AND missing_since IS NULL
       ORDER BY size_bytes DESC, repo_id COLLATE NOCASE
       LIMIT 1`
    )
    .get(resolved.cacheRoot) as { repo_id: string; size_bytes: number } | undefined;
  return {
    cacheRoot: resolved.cacheRoot,
    rootSource: resolved.source,
    counts: {
      total: counts.total,
      active: counts.active ?? 0,
      missing: counts.missing ?? 0,
      totalSizeBytes: counts.total_size_bytes ?? 0,
      largestSizeBytes: counts.largest_size_bytes ?? 0,
      largestModel: largest?.repo_id ?? null,
    },
    lastRun: getLatestInventorySyncRun(db, "huggingface"),
  };
}

export function listHuggingfaceModels(
  db: Database.Database,
  opts: HuggingfaceListOptions
): PageResult<HuggingfaceModelRow> {
  const where = ["repo_type = 'model'"];
  const params: unknown[] = [];
  if (!opts.includeMissing) where.push("missing_since IS NULL");
  if (opts.cacheRoot) {
    where.push("cache_root = ?");
    params.push(opts.cacheRoot);
  }
  if (opts.q) {
    where.push("repo_id LIKE ?");
    params.push(`%${opts.q}%`);
  }
  const clause = `WHERE ${where.join(" AND ")}`;
  const total = (
    db.prepare(`SELECT COUNT(*) AS n FROM huggingface_models ${clause}`).get(...params) as {
      n: number;
    }
  ).n;
  const rows = db
    .prepare(
      `SELECT id, repo_type, repo_id, cache_root, cache_dir, refs_json,
              snapshot_count, blob_count, size_bytes, warnings_json,
              last_seen_at, missing_since, updated_at
       FROM huggingface_models
       ${clause}
       ORDER BY missing_since IS NOT NULL, size_bytes DESC, repo_id COLLATE NOCASE
       LIMIT ? OFFSET ?`
    )
    .all(...params, opts.limit, opts.offset) as Omit<HuggingfaceModelRow, "revisions">[];
  const revisions = db.prepare(
    `SELECT revision, refs_json, file_count, last_modified_ms, warnings_json
     FROM huggingface_model_revisions
     WHERE model_id = ?
     ORDER BY refs_json DESC, revision`
  );
  return {
    rows: rows.map((row) => ({
      ...row,
      repo_type: "model",
      revisions: (revisions.all(row.id) as {
        revision: string;
        refs_json: string;
        file_count: number;
        last_modified_ms: number | null;
        warnings_json: string;
      }[]).map((r) => ({
        revision: r.revision,
        refs: safeJsonStringArray(r.refs_json),
        file_count: r.file_count,
        last_modified_ms: r.last_modified_ms,
        warnings: safeJsonArray(r.warnings_json),
      })),
    })),
    total,
    limit: opts.limit,
    offset: opts.offset,
  };
}

function safeJsonArray(raw: string): unknown[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function safeJsonStringArray(raw: string): string[] {
  return safeJsonArray(raw).filter((x): x is string => typeof x === "string");
}
