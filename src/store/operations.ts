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
    db.prepare(
      `UPDATE repos SET origin_url = ?, last_scanned_at = ?, last_job_id = ? WHERE id = ?`
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
    db.prepare(`SELECT COUNT(*) AS c FROM repos`).get() as { c: number }
  ).c;
  const manifests = (
    db.prepare(`SELECT COUNT(*) AS c FROM manifest_files`).get() as { c: number }
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
      WHERE manifest_fts MATCH ?
      LIMIT ?
    `
    )
    .all(query, limit) as SearchHit[];
  return rows;
}
