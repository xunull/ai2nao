import type Database from "better-sqlite3";
import { orderByClause, type SortDir, type SortCol } from "../serve/orderBy.js";

/** Sortable columns for the local repos table (server-side sort allowlist). */
export const REPO_SORT_ALLOWED: Record<string, SortCol> = {
  path: { expr: "path_canonical COLLATE NOCASE", defaultDir: "asc" },
  origin: { expr: "origin_url", defaultDir: "asc", nulls: "last" },
  scanned: { expr: "COALESCE(last_scanned_at, first_seen_at)", defaultDir: "desc" },
};

export type RepoRow = {
  id: number;
  path_canonical: string;
  origin_url: string | null;
  first_seen_at: string;
  last_scanned_at: string | null;
  last_job_id: number | null;
};

export type ManifestListRow = {
  id: number;
  rel_path: string;
  mtime_ms: number | null;
  size_bytes: number | null;
  sha256_hex: string | null;
};

export type ManifestBodyRow = {
  rel_path: string;
  mtime_ms: number | null;
  size_bytes: number | null;
  body: string;
};

export type RepoMatchRow = {
  id: number;
  path_canonical: string;
};

export type ListReposOptions = {
  limit: number;
  offset: number;
  q?: string;
  sort?: string;
  dir?: SortDir;
  /** Include soft-deleted (missing) repos. Default false: only present repos. */
  includeMissing?: boolean;
};

export function listRepos(
  db: Database.Database,
  opts: ListReposOptions
): { rows: RepoRow[]; total: number } {
  const where: string[] = [];
  const params: unknown[] = [];
  if (!opts.includeMissing) where.push("missing_since IS NULL");
  if (opts.q) {
    // Substring match on path + origin. The `q` value is bound, never interpolated.
    where.push("(path_canonical LIKE ? OR origin_url LIKE ?)");
    params.push(`%${opts.q}%`, `%${opts.q}%`);
  }
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const orderBy = orderByClause({
    sort: opts.sort,
    dir: opts.dir,
    allowed: REPO_SORT_ALLOWED,
    defaultSortKey: "scanned",
    defaultDir: "desc",
    tiebreaker: "id DESC",
  });
  const total = (
    db.prepare(`SELECT COUNT(*) AS c FROM repos ${clause}`).get(...params) as { c: number }
  ).c;
  const rows = db
    .prepare(
      `
      SELECT id, path_canonical, origin_url, first_seen_at, last_scanned_at, last_job_id
      FROM repos
      ${clause}
      ${orderBy}
      LIMIT ? OFFSET ?
    `
    )
    .all(...params, opts.limit, opts.offset) as RepoRow[];
  return { rows, total };
}

export function getRepoById(
  db: Database.Database,
  id: number
): RepoRow | null {
  const row = db
    .prepare(
      `
      SELECT id, path_canonical, origin_url, first_seen_at, last_scanned_at, last_job_id
      FROM repos WHERE id = ?
    `
    )
    .get(id) as RepoRow | undefined;
  return row ?? null;
}

export function listRepoMatches(db: Database.Database): RepoMatchRow[] {
  return db
    .prepare(
      `
      SELECT id, path_canonical
      FROM repos
      WHERE missing_since IS NULL
      ORDER BY LENGTH(path_canonical) DESC, path_canonical ASC
    `
    )
    .all() as RepoMatchRow[];
}

export function listManifestsForRepo(
  db: Database.Database,
  repoId: number
): ManifestListRow[] {
  return db
    .prepare(
      `
      SELECT id, rel_path, mtime_ms, size_bytes, sha256_hex
      FROM manifest_files
      WHERE repo_id = ?
      ORDER BY rel_path ASC
    `
    )
    .all(repoId) as ManifestListRow[];
}

export function getManifestByRepoAndRelPath(
  db: Database.Database,
  repoId: number,
  relPath: string
): ManifestBodyRow | null {
  const row = db
    .prepare(
      `
      SELECT rel_path, mtime_ms, size_bytes, body
      FROM manifest_files
      WHERE repo_id = ? AND rel_path = ?
    `
    )
    .get(repoId, relPath) as ManifestBodyRow | undefined;
  return row ?? null;
}
