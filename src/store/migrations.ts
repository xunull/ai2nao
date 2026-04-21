import type Database from "better-sqlite3";

const CURRENT_VERSION = 5;

export function migrate(db: Database.Database): void {
  db.exec("PRAGMA foreign_keys = ON;");
  const exists = db
    .prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'meta_schema'"
    )
    .get() as { 1: number } | undefined;
  if (!exists) {
    applyV1(db);
    applyV2(db);
    applyV3(db);
    applyV4(db);
    applyV5(db);
    return;
  }
  const row = db.prepare("SELECT version FROM meta_schema WHERE id = 1").get() as
    | { version: number }
    | undefined;
  const v = row?.version ?? 0;
  if (v < 1) applyV1(db);
  if (v < 2) applyV2(db);
  if (v < 3) applyV3(db);
  if (v < 4) applyV4(db);
  if (v < 5) applyV5(db);
  const vAfter = (
    db.prepare("SELECT version FROM meta_schema WHERE id = 1").get() as {
      version: number;
    }
  ).version;
  if (vAfter > CURRENT_VERSION) {
    throw new Error(
      `Database schema newer than this binary (version ${vAfter}); upgrade ai2nao`
    );
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

/** Download folder file snapshots (insert-only; dedupe via UNIQUE). */
function applyV2(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS download_files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      root_path TEXT NOT NULL,
      rel_path TEXT NOT NULL,
      file_birthtime_ms INTEGER NOT NULL,
      file_mtime_ms INTEGER,
      size_bytes INTEGER,
      calendar_day TEXT NOT NULL,
      inserted_at TEXT NOT NULL,
      UNIQUE(root_path, rel_path, file_birthtime_ms)
    );

    CREATE INDEX IF NOT EXISTS idx_download_files_day ON download_files(calendar_day);

    UPDATE meta_schema SET version = 2 WHERE id = 1;
  `);
}

/** Chrome History mirror (insert-only; dedupe via PRIMARY KEY on chrome visit id + profile). */
function applyV3(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS chrome_history_urls (
      id INTEGER NOT NULL,
      profile TEXT NOT NULL,
      url TEXT NOT NULL,
      title TEXT,
      visit_count INTEGER NOT NULL DEFAULT 0,
      typed_count INTEGER NOT NULL DEFAULT 0,
      last_visit_time INTEGER NOT NULL DEFAULT 0,
      hidden INTEGER NOT NULL DEFAULT 0,
      inserted_at TEXT NOT NULL,
      PRIMARY KEY (profile, id)
    );

    CREATE TABLE IF NOT EXISTS chrome_history_visits (
      id INTEGER NOT NULL,
      profile TEXT NOT NULL,
      url_id INTEGER NOT NULL,
      visit_time INTEGER NOT NULL,
      from_visit INTEGER,
      transition INTEGER,
      segment_id INTEGER,
      visit_duration INTEGER,
      calendar_day TEXT NOT NULL,
      inserted_at TEXT NOT NULL,
      PRIMARY KEY (profile, id)
    );

    CREATE INDEX IF NOT EXISTS idx_chrome_history_visits_day
      ON chrome_history_visits(calendar_day);

    UPDATE meta_schema SET version = 3 WHERE id = 1;
  `);
}

/** Chrome `History.downloads` mirror (insert-only; PRIMARY KEY profile + chrome download id). */
function applyV4(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS chrome_downloads (
      id INTEGER NOT NULL,
      profile TEXT NOT NULL,
      guid TEXT,
      current_path TEXT,
      target_path TEXT,
      start_time INTEGER NOT NULL,
      end_time INTEGER,
      received_bytes INTEGER,
      total_bytes INTEGER,
      state INTEGER,
      danger_type INTEGER,
      interrupt_reason INTEGER,
      mime_type TEXT,
      referrer TEXT,
      site_url TEXT,
      tab_url TEXT,
      tab_referrer_url TEXT,
      calendar_day TEXT NOT NULL,
      inserted_at TEXT NOT NULL,
      PRIMARY KEY (profile, id)
    );

    CREATE INDEX IF NOT EXISTS idx_chrome_downloads_day
      ON chrome_downloads(profile, calendar_day);

    UPDATE meta_schema SET version = 4 WHERE id = 1;
  `);
}

/**
 * GitHub personal mirror: user's own repos, starred repos, per-repo commit counts,
 * and sync-state watermarks. All four tables are upsert-friendly:
 *   gh_repo.id      = GitHub numeric repo id (PRIMARY KEY, not autoincrement)
 *   gh_commit_count = 1:1 with gh_repo (FK + ON DELETE CASCADE)
 *   gh_star         = keyed by repo_id; we keep full_name/html_url so rows
 *                     remain readable even if upstream gets transferred/renamed
 *   gh_sync_state   = flat key/value bag for per-sync watermarks and status
 *                     (last_full_sync_at, last_full_sync_error, etc.)
 */
function applyV5(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS gh_repo (
      id INTEGER PRIMARY KEY,
      owner TEXT NOT NULL,
      name TEXT NOT NULL,
      full_name TEXT NOT NULL UNIQUE,
      description TEXT,
      private INTEGER NOT NULL DEFAULT 0,
      fork INTEGER NOT NULL DEFAULT 0,
      archived INTEGER NOT NULL DEFAULT 0,
      default_branch TEXT,
      html_url TEXT NOT NULL,
      clone_url TEXT,
      language TEXT,
      topics_json TEXT NOT NULL DEFAULT '[]',
      stargazers_count INTEGER NOT NULL DEFAULT 0,
      forks_count INTEGER NOT NULL DEFAULT 0,
      open_issues_count INTEGER NOT NULL DEFAULT 0,
      size_kb INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      pushed_at TEXT,
      inserted_at TEXT NOT NULL,
      last_synced_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_gh_repo_created_at ON gh_repo(created_at);
    CREATE INDEX IF NOT EXISTS idx_gh_repo_updated_at ON gh_repo(updated_at);

    CREATE TABLE IF NOT EXISTS gh_commit_count (
      repo_id INTEGER PRIMARY KEY REFERENCES gh_repo(id) ON DELETE CASCADE,
      count INTEGER,
      default_branch TEXT,
      error TEXT,
      checked_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS gh_star (
      repo_id INTEGER PRIMARY KEY,
      owner TEXT NOT NULL,
      name TEXT NOT NULL,
      full_name TEXT NOT NULL,
      description TEXT,
      html_url TEXT NOT NULL,
      language TEXT,
      topics_json TEXT NOT NULL DEFAULT '[]',
      stargazers_count INTEGER NOT NULL DEFAULT 0,
      starred_at TEXT NOT NULL,
      inserted_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_gh_star_starred_at ON gh_star(starred_at);

    CREATE TABLE IF NOT EXISTS gh_sync_state (
      key TEXT PRIMARY KEY,
      value TEXT
    );

    UPDATE meta_schema SET version = 5 WHERE id = 1;
  `);
}
