import type Database from "better-sqlite3";

const CURRENT_VERSION = 1;

export function migrate(db: Database.Database): void {
  db.exec("PRAGMA foreign_keys = ON;");
  const exists = db
    .prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'meta_schema'"
    )
    .get() as { 1: number } | undefined;
  if (!exists) {
    applyV1(db);
    return;
  }
  const row = db.prepare("SELECT version FROM meta_schema WHERE id = 1").get() as
    | { version: number }
    | undefined;
  const v = row?.version ?? 0;
  if (v < 1) applyV1(db);
  if (v > CURRENT_VERSION) {
    throw new Error(`Database schema newer than this binary (version ${v}); upgrade ai2nao`);
  }
}

/** Standalone FTS5 (no content=): we maintain rowid = manifest_files.id in application code. */
function applyV1(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta_schema (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      version INTEGER NOT NULL
    );
    INSERT OR IGNORE INTO meta_schema (id, version) VALUES (1, 0);

    CREATE TABLE IF NOT EXISTS jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      status TEXT NOT NULL,
      error_summary TEXT
    );

    CREATE TABLE IF NOT EXISTS repos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      path_canonical TEXT NOT NULL UNIQUE,
      origin_url TEXT,
      first_seen_at TEXT NOT NULL,
      last_scanned_at TEXT,
      last_job_id INTEGER REFERENCES jobs(id)
    );

    CREATE TABLE IF NOT EXISTS manifest_files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      repo_id INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
      rel_path TEXT NOT NULL,
      mtime_ms INTEGER,
      size_bytes INTEGER,
      sha256_hex TEXT,
      body TEXT NOT NULL,
      UNIQUE(repo_id, rel_path)
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS manifest_fts USING fts5(rel_path, body);

    CREATE TRIGGER IF NOT EXISTS manifest_files_ad_fts AFTER DELETE ON manifest_files BEGIN
      DELETE FROM manifest_fts WHERE rowid = old.id;
    END;

    UPDATE meta_schema SET version = 1 WHERE id = 1;
  `);
}
