import type Database from "better-sqlite3";

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

export function listRepos(
  db: Database.Database,
  page: number,
  pageSize: number
): { rows: RepoRow[]; total: number } {
  const total = (
    db.prepare(`SELECT COUNT(*) AS c FROM repos`).get() as { c: number }
  ).c;
  const safePage = Math.max(1, page);
  const safeSize = Math.min(100, Math.max(1, pageSize));
  const offset = (safePage - 1) * safeSize;
  const rows = db
    .prepare(
      `
      SELECT id, path_canonical, origin_url, first_seen_at, last_scanned_at, last_job_id
      FROM repos
      ORDER BY COALESCE(last_scanned_at, first_seen_at) DESC, id DESC
      LIMIT ? OFFSET ?
    `
    )
    .all(safeSize, offset) as RepoRow[];
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
