import type Database from "better-sqlite3";
import { createHash } from "node:crypto";

export type JobStatus = "running" | "ok" | "error";

export function startJob(db: Database.Database, kind: string): number {
  const now = new Date().toISOString();
  const r = db
    .prepare(
      `INSERT INTO jobs (kind, started_at, status) VALUES (?, ?, 'running')`
    )
    .run(kind, now);
  return Number(r.lastInsertRowid);
}

export function finishJob(
  db: Database.Database,
  jobId: number,
  status: JobStatus,
  errorSummary: string | null
): void {
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE jobs SET finished_at = ?, status = ?, error_summary = ? WHERE id = ?`
  ).run(now, status, errorSummary, jobId);
}

export function upsertRepo(
  db: Database.Database,
  pathCanonical: string,
  originUrl: string | null,
  jobId: number
): number {
  const now = new Date().toISOString();
  const existing = db
    .prepare(`SELECT id FROM repos WHERE path_canonical = ?`)
    .get(pathCanonical) as { id: number } | undefined;
  if (existing) {
    // Found on disk -> clear any missing_since (came back / still present).
    db.prepare(
      `UPDATE repos SET origin_url = ?, last_scanned_at = ?, last_job_id = ?, missing_since = NULL WHERE id = ?`
    ).run(originUrl, now, jobId, existing.id);
    return existing.id;
  }
  const r = db
    .prepare(
      `INSERT INTO repos (path_canonical, origin_url, first_seen_at, last_scanned_at, last_job_id)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(pathCanonical, originUrl, now, now, jobId);
  return Number(r.lastInsertRowid);
}

/**
 * Mark repos that are under a scanned root but were NOT found this scan as
 * `missing_since` (soft delete). Scoping is done in JS with literal `startsWith`
 * (NOT SQL LIKE — a real path can contain `%`/`_` which LIKE treats as wildcards).
 *
 * Guards:
 *  - `seenRepoIds`: repos found this scan are present (upsertRepo already cleared
 *    their missing_since) — never marked.
 *  - nested guard: a candidate inside a found repo's directory is skipped. The scan
 *    stops at the outer `.git` so it never descends into a found repo; an inner repo
 *    still exists on disk and must not be flagged.
 *  - only sets missing_since when currently NULL (preserve the first-gone timestamp).
 *
 * Scope = exactly the roots scanned this run. Repos under OTHER roots are untouched
 * (a deleted whole configured root is a known limitation — its repos reconcile only
 * when a still-existing parent root is rescanned).
 */
export function reconcileMissingRepos(
  db: Database.Database,
  params: {
    scannedRoots: string[]; // canonical roots scanned this run
    seenRepoIds: Set<number>; // repo ids found this scan
    foundPaths: string[]; // canonical paths found this scan (nested guard)
    nowIso: string;
  }
): number {
  const rows = db
    .prepare(`SELECT id, path_canonical, missing_since FROM repos`)
    .all() as { id: number; path_canonical: string; missing_since: string | null }[];
  const mark = db.prepare(
    `UPDATE repos SET missing_since = ? WHERE id = ? AND missing_since IS NULL`
  );
  let marked = 0;
  for (const r of rows) {
    if (params.seenRepoIds.has(r.id)) continue; // present this scan
    if (r.missing_since) continue; // already marked
    const inScope = params.scannedRoots.some(
      (root) => r.path_canonical === root || r.path_canonical.startsWith(`${root}/`)
    );
    if (!inScope) continue;
    const nested = params.foundPaths.some((fp) => r.path_canonical.startsWith(`${fp}/`));
    if (nested) continue;
    mark.run(params.nowIso, r.id);
    marked += 1;
  }
  return marked;
}

export type ManifestRow = {
  rel_path: string;
  mtime_ms: number | null;
  size_bytes: number | null;
  sha256_hex: string | null;
  body: string;
};

export function replaceManifest(
  db: Database.Database,
  repoId: number,
  row: ManifestRow
): void {
  const sha =
    row.sha256_hex ??
    createHash("sha256").update(row.body, "utf8").digest("hex");

  const tx = db.transaction(() => {
    const existing = db
      .prepare(`SELECT id FROM manifest_files WHERE repo_id = ? AND rel_path = ?`)
      .get(repoId, row.rel_path) as { id: number } | undefined;
    if (existing) {
      db.prepare(`DELETE FROM manifest_files WHERE id = ?`).run(existing.id);
    }
    const ins = db
      .prepare(
        `INSERT INTO manifest_files (repo_id, rel_path, mtime_ms, size_bytes, sha256_hex, body)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        repoId,
        row.rel_path,
        row.mtime_ms,
        row.size_bytes,
        sha,
        row.body
      );
    const id = Number(ins.lastInsertRowid);
    db.prepare(
      `INSERT INTO manifest_fts (rowid, rel_path, body) VALUES (?, ?, ?)`
    ).run(id, row.rel_path, row.body);
  });

  tx();
}

export function getStatusSummary(db: Database.Database): {
  repos: number;
  manifests: number;
  lastJob: { id: number; kind: string; status: string; finished_at: string | null } | null;
} {
  const repos = (
    db.prepare(`SELECT COUNT(*) AS c FROM repos WHERE missing_since IS NULL`).get() as {
      c: number;
    }
  ).c;
  // Count only manifests of present repos — a missing repo's files are not "indexed".
  const manifests = (
    db
      .prepare(
        `SELECT COUNT(*) AS c FROM manifest_files m
         JOIN repos r ON r.id = m.repo_id
         WHERE r.missing_since IS NULL`
      )
      .get() as { c: number }
  ).c;
  const lastJob = db
    .prepare(
      `SELECT id, kind, status, finished_at FROM jobs ORDER BY id DESC LIMIT 1`
    )
    .get() as
    | { id: number; kind: string; status: string; finished_at: string | null }
    | undefined;
  return { repos, manifests, lastJob: lastJob ?? null };
}

export type SearchHit = {
  repo_id: number;
  repo_path: string;
  rel_path: string;
  snippet: string;
};

/** FTS5 search; limit capped for CLI safety. */
export function searchManifests(
  db: Database.Database,
  query: string,
  limit: number
): SearchHit[] {
  const rows = db
    .prepare(
      `
      SELECT r.id AS repo_id, r.path_canonical AS repo_path, m.rel_path,
             snippet(manifest_fts, 1, '[', ']', '…', 32) AS snippet
      FROM manifest_fts
      JOIN manifest_files m ON m.id = manifest_fts.rowid
      JOIN repos r ON r.id = m.repo_id
      WHERE manifest_fts MATCH ? AND r.missing_since IS NULL
      LIMIT ?
    `
    )
    .all(query, limit) as SearchHit[];
  return rows;
}
