import type Database from "better-sqlite3";
import { chromeVisitContentKey } from "../chromeHistory/contentKey.js";

const CURRENT_VERSION = 14;

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
    applyV6(db);
    applyV7(db);
    applyV8(db);
    applyV9(db);
    applyV10(db);
    applyV11(db);
    applyV12(db);
    applyV13(db);
    applyV14(db);
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
  if (v < 6) applyV6(db);
  if (v < 7) applyV7(db);
  if (v < 8) applyV8(db);
  if (v < 9) applyV9(db);
  if (v < 10) applyV10(db);
  if (v < 11) applyV11(db);
  if (v < 12) applyV12(db);
  if (v < 13) applyV13(db);
  if (v < 14) applyV14(db);
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

/**
 * GitHub tag pivot tables. Two concerns:
 *
 *   gh_tag_alias(from_tag → to_tag): local synonym map. Persistent asset;
 *     never touched by `github sync`. Seeded by `ai2nao github tags alias seed`
 *     (preset entries) and edited by `ai2nao github tags alias add/rm`
 *     (user entries). Editing an alias does NOT auto-rebuild gh_repo_tag —
 *     users must explicitly run `ai2nao github tags rebuild` after alias
 *     edits (CLI prints a hint).
 *
 *   gh_repo_tag(repo_id, tag, source): canonical tag per starred repo, after
 *     alias resolution. V1 scope is stars-only per design doc Premise 1, so
 *     `repo_id` references `gh_star(repo_id)` rather than `gh_repo(id)` —
 *     most of the repos you star are other people's, so they never land in
 *     `gh_repo`. Table is named `gh_repo_tag` (not `gh_star_tag`) to leave
 *     room for a future 'own-topic' source without a rename.
 *
 *   Rebuild strategy: see `rebuildRepoTags` in src/github/tags.ts.
 */
function applyV6(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS gh_tag_alias (
      from_tag   TEXT PRIMARY KEY,
      to_tag     TEXT NOT NULL,
      source     TEXT NOT NULL DEFAULT 'preset',
      note       TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS gh_repo_tag (
      repo_id INTEGER NOT NULL,
      tag     TEXT NOT NULL,
      source  TEXT NOT NULL,
      PRIMARY KEY (repo_id, tag),
      FOREIGN KEY (repo_id) REFERENCES gh_star(repo_id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_gh_repo_tag_tag ON gh_repo_tag(tag);

    UPDATE meta_schema SET version = 6 WHERE id = 1;
  `);
}

/** Local software inventory: macOS app bundles + Homebrew formulae/casks. */
function applyV7(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS mac_apps (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bundle_id TEXT,
      name TEXT NOT NULL,
      path TEXT NOT NULL,
      version TEXT,
      short_version TEXT,
      executable TEXT,
      bundle_name TEXT,
      bundle_display_name TEXT,
      minimum_system_version TEXT,
      category TEXT,
      source_root TEXT NOT NULL,
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      missing_since TEXT,
      inserted_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(path)
    );

    CREATE INDEX IF NOT EXISTS idx_mac_apps_bundle_id ON mac_apps(bundle_id);
    CREATE INDEX IF NOT EXISTS idx_mac_apps_name ON mac_apps(name);
    CREATE INDEX IF NOT EXISTS idx_mac_apps_source_root ON mac_apps(source_root);
    CREATE INDEX IF NOT EXISTS idx_mac_apps_last_seen ON mac_apps(last_seen_at);
    CREATE INDEX IF NOT EXISTS idx_mac_apps_missing_since ON mac_apps(missing_since);

    CREATE TABLE IF NOT EXISTS brew_packages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL CHECK (kind IN ('formula', 'cask')),
      name TEXT NOT NULL,
      full_name TEXT,
      installed_version TEXT,
      current_version TEXT,
      desc TEXT,
      homepage TEXT,
      tap TEXT,
      installed_as_dependency INTEGER,
      installed_on_request INTEGER,
      outdated INTEGER NOT NULL DEFAULT 0,
      caveats TEXT,
      aliases_json TEXT NOT NULL DEFAULT '[]',
      dependencies_json TEXT NOT NULL DEFAULT '[]',
      raw_json TEXT,
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      missing_since TEXT,
      inserted_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(kind, name)
    );

    CREATE INDEX IF NOT EXISTS idx_brew_packages_kind ON brew_packages(kind);
    CREATE INDEX IF NOT EXISTS idx_brew_packages_name ON brew_packages(name);
    CREATE INDEX IF NOT EXISTS idx_brew_packages_tap ON brew_packages(tap);
    CREATE INDEX IF NOT EXISTS idx_brew_packages_last_seen ON brew_packages(last_seen_at);
    CREATE INDEX IF NOT EXISTS idx_brew_packages_missing_since ON brew_packages(missing_since);
    CREATE INDEX IF NOT EXISTS idx_brew_packages_outdated ON brew_packages(outdated);

    CREATE TABLE IF NOT EXISTS software_sync_state (
      key TEXT PRIMARY KEY,
      value TEXT
    );

    CREATE TABLE IF NOT EXISTS software_sync_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL CHECK (source IN ('mac_apps', 'brew')),
      started_at TEXT NOT NULL,
      finished_at TEXT,
      status TEXT NOT NULL CHECK (status IN ('running', 'success', 'partial', 'failed')),
      inserted INTEGER NOT NULL DEFAULT 0,
      updated INTEGER NOT NULL DEFAULT 0,
      marked_missing INTEGER NOT NULL DEFAULT 0,
      warnings_count INTEGER NOT NULL DEFAULT 0,
      error_summary TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}'
    );

    CREATE INDEX IF NOT EXISTS idx_software_sync_runs_source_started
      ON software_sync_runs(source, started_at);

    UPDATE meta_schema SET version = 7 WHERE id = 1;
  `);
}

/**
 * Chrome History files can be rebuilt by Chrome, causing visits.id/downloads.id
 * to start from a small value again. Scope those ids to a local source_id so the
 * mirror remains insert-only across Chrome database resets.
 */
function applyV8(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS chrome_history_urls_v8 (
      id INTEGER NOT NULL,
      profile TEXT NOT NULL,
      source_id TEXT NOT NULL,
      url TEXT NOT NULL,
      title TEXT,
      visit_count INTEGER NOT NULL DEFAULT 0,
      typed_count INTEGER NOT NULL DEFAULT 0,
      last_visit_time INTEGER NOT NULL DEFAULT 0,
      hidden INTEGER NOT NULL DEFAULT 0,
      inserted_at TEXT NOT NULL,
      PRIMARY KEY (profile, source_id, id)
    );

    INSERT OR IGNORE INTO chrome_history_urls_v8 (
      id, profile, source_id, url, title, visit_count, typed_count,
      last_visit_time, hidden, inserted_at
    )
    SELECT id, profile, 'legacy', url, title, visit_count, typed_count,
           last_visit_time, hidden, inserted_at
    FROM chrome_history_urls;

    DROP TABLE chrome_history_urls;
    ALTER TABLE chrome_history_urls_v8 RENAME TO chrome_history_urls;

    CREATE TABLE IF NOT EXISTS chrome_history_visits_v8 (
      id INTEGER NOT NULL,
      profile TEXT NOT NULL,
      source_id TEXT NOT NULL,
      url_id INTEGER NOT NULL,
      visit_time INTEGER NOT NULL,
      from_visit INTEGER,
      transition INTEGER,
      segment_id INTEGER,
      visit_duration INTEGER,
      calendar_day TEXT NOT NULL,
      inserted_at TEXT NOT NULL,
      PRIMARY KEY (profile, source_id, id)
    );

    INSERT OR IGNORE INTO chrome_history_visits_v8 (
      id, profile, source_id, url_id, visit_time, from_visit, transition,
      segment_id, visit_duration, calendar_day, inserted_at
    )
    SELECT id, profile, 'legacy', url_id, visit_time, from_visit, transition,
           segment_id, visit_duration, calendar_day, inserted_at
    FROM chrome_history_visits;

    DROP TABLE chrome_history_visits;
    ALTER TABLE chrome_history_visits_v8 RENAME TO chrome_history_visits;

    CREATE INDEX IF NOT EXISTS idx_chrome_history_visits_day
      ON chrome_history_visits(calendar_day);

    CREATE TABLE IF NOT EXISTS chrome_downloads_v8 (
      id INTEGER NOT NULL,
      profile TEXT NOT NULL,
      source_id TEXT NOT NULL,
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
      PRIMARY KEY (profile, source_id, id)
    );

    INSERT OR IGNORE INTO chrome_downloads_v8 (
      id, profile, source_id, guid, current_path, target_path, start_time,
      end_time, received_bytes, total_bytes, state, danger_type,
      interrupt_reason, mime_type, referrer, site_url, tab_url,
      tab_referrer_url, calendar_day, inserted_at
    )
    SELECT id, profile, 'legacy', guid, current_path, target_path, start_time,
           end_time, received_bytes, total_bytes, state, danger_type,
           interrupt_reason, mime_type, referrer, site_url, tab_url,
           tab_referrer_url, calendar_day, inserted_at
    FROM chrome_downloads;

    DROP TABLE chrome_downloads;
    ALTER TABLE chrome_downloads_v8 RENAME TO chrome_downloads;

    CREATE INDEX IF NOT EXISTS idx_chrome_downloads_day
      ON chrome_downloads(profile, calendar_day);

    CREATE TABLE IF NOT EXISTS chrome_history_sync_state (
      profile TEXT NOT NULL,
      source_path TEXT NOT NULL,
      current_source_id TEXT NOT NULL,
      max_visit_id INTEGER NOT NULL DEFAULT 0,
      max_download_id INTEGER NOT NULL DEFAULT 0,
      anchor_visit_id INTEGER,
      anchor_visit_time INTEGER,
      anchor_url TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (profile, source_path)
    );

    UPDATE meta_schema SET version = 8 WHERE id = 1;
  `);
}

/**
 * Deduplicate Chrome visits by stable content, not only Chrome's local visit id.
 * Chrome can delete/rebuild History and reuse ids; the content key lets a full
 * rescan keep old mirror rows while skipping already-seen visits.
 */
function applyV9(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS chrome_history_visits_v9 (
      id INTEGER NOT NULL,
      profile TEXT NOT NULL,
      source_id TEXT NOT NULL,
      content_key TEXT NOT NULL,
      url_id INTEGER NOT NULL,
      visit_time INTEGER NOT NULL,
      from_visit INTEGER,
      transition INTEGER,
      segment_id INTEGER,
      visit_duration INTEGER,
      calendar_day TEXT NOT NULL,
      inserted_at TEXT NOT NULL,
      PRIMARY KEY (profile, source_id, id),
      UNIQUE(profile, content_key)
    );
  `);

  const rows = db
    .prepare(
      `SELECT v.id, v.profile, v.source_id, v.url_id, v.visit_time,
              v.from_visit, v.transition, v.segment_id, v.visit_duration,
              v.calendar_day, v.inserted_at, u.url
       FROM chrome_history_visits v
       INNER JOIN chrome_history_urls u
         ON u.profile = v.profile AND u.source_id = v.source_id AND u.id = v.url_id
       ORDER BY v.inserted_at, v.profile, v.source_id, v.id`
    )
    .all() as {
    id: number;
    profile: string;
    source_id: string;
    url_id: number;
    visit_time: number;
    from_visit: number | null;
    transition: number | null;
    segment_id: number | null;
    visit_duration: number | null;
    calendar_day: string;
    inserted_at: string;
    url: string;
  }[];

  const insert = db.prepare(
    `INSERT INTO chrome_history_visits_v9 (
      id, profile, source_id, content_key, url_id, visit_time, from_visit,
      transition, segment_id, visit_duration, calendar_day, inserted_at
    ) VALUES (
      @id, @profile, @source_id, @content_key, @url_id, @visit_time,
      @from_visit, @transition, @segment_id, @visit_duration,
      @calendar_day, @inserted_at
    )`
  );
  const seen = new Set<string>();
  const copyRows = db.transaction(() => {
    for (const row of rows) {
      const baseKey = chromeVisitContentKey(row);
      const scopedKey = `${row.profile}\0${baseKey}`;
      const contentKey = seen.has(scopedKey)
        ? `${baseKey}:dup:${row.source_id}:${row.id}`
        : baseKey;
      seen.add(scopedKey);
      insert.run({ ...row, content_key: contentKey });
    }
  });
  copyRows();

  db.exec(`
    DROP TABLE chrome_history_visits;
    ALTER TABLE chrome_history_visits_v9 RENAME TO chrome_history_visits;

    CREATE INDEX IF NOT EXISTS idx_chrome_history_visits_day
      ON chrome_history_visits(calendar_day);
    CREATE INDEX IF NOT EXISTS idx_chrome_history_visits_content
      ON chrome_history_visits(profile, content_key);

    UPDATE meta_schema SET version = 9 WHERE id = 1;
  `);
}

/**
 * Chrome History domain pivot. Raw visits remain the source of truth; this
 * projection is rebuildable and carries freshness state for UI trust signals.
 */
function applyV10(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS chrome_history_visit_domains (
      profile TEXT NOT NULL,
      source_id TEXT NOT NULL,
      visit_id INTEGER NOT NULL,
      url_id INTEGER NOT NULL,
      content_key TEXT NOT NULL,
      url_kind TEXT NOT NULL,
      scheme TEXT,
      host TEXT,
      domain TEXT,
      origin TEXT,
      calendar_day TEXT NOT NULL,
      visit_time INTEGER NOT NULL,
      inserted_at TEXT NOT NULL,
      PRIMARY KEY (profile, source_id, visit_id)
    );

    CREATE INDEX IF NOT EXISTS idx_chrome_history_visit_domains_profile_domain_day
      ON chrome_history_visit_domains(profile, domain, calendar_day);
    CREATE INDEX IF NOT EXISTS idx_chrome_history_visit_domains_profile_day
      ON chrome_history_visit_domains(profile, calendar_day);
    CREATE INDEX IF NOT EXISTS idx_chrome_history_visit_domains_profile_kind
      ON chrome_history_visit_domains(profile, url_kind);
    CREATE INDEX IF NOT EXISTS idx_chrome_history_visit_domains_content
      ON chrome_history_visit_domains(profile, content_key);

    CREATE TABLE IF NOT EXISTS chrome_history_domain_state (
      profile TEXT PRIMARY KEY,
      rule_version INTEGER NOT NULL,
      last_rebuilt_at TEXT,
      last_error TEXT,
      source_visit_count INTEGER NOT NULL DEFAULT 0,
      derived_visit_count INTEGER NOT NULL DEFAULT 0,
      last_rebuild_duration_ms INTEGER,
      updated_at TEXT NOT NULL
    );

    UPDATE meta_schema SET version = 10 WHERE id = 1;
  `);
}

/** VS Code recent work context mirror. */
function applyV11(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS vscode_recent_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      app TEXT NOT NULL CHECK (app IN ('code', 'code-insiders', 'vscodium', 'cursor')),
      profile TEXT NOT NULL DEFAULT 'default',
      kind TEXT NOT NULL CHECK (kind IN ('folder', 'file', 'workspace')),
      recent_index INTEGER NOT NULL,
      uri_redacted TEXT NOT NULL,
      path TEXT,
      label TEXT,
      remote_type TEXT,
      remote_authority_hash TEXT,
      remote_path_hash TEXT,
      exists_on_disk INTEGER,
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      missing_since TEXT,
      inserted_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(app, profile, uri_redacted)
    );

    CREATE INDEX IF NOT EXISTS idx_vscode_recent_app_profile_rank
      ON vscode_recent_entries(app, profile, recent_index);
    CREATE INDEX IF NOT EXISTS idx_vscode_recent_app_profile_last_seen
      ON vscode_recent_entries(app, profile, last_seen_at);
    CREATE INDEX IF NOT EXISTS idx_vscode_recent_kind
      ON vscode_recent_entries(app, profile, kind);
    CREATE INDEX IF NOT EXISTS idx_vscode_recent_missing_since
      ON vscode_recent_entries(missing_since);
    CREATE INDEX IF NOT EXISTS idx_vscode_recent_path
      ON vscode_recent_entries(path);
    CREATE INDEX IF NOT EXISTS idx_vscode_recent_remote
      ON vscode_recent_entries(remote_type, remote_authority_hash);

    CREATE TABLE IF NOT EXISTS vscode_sync_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    UPDATE meta_schema SET version = 11 WHERE id = 1;
  `);
}

/** Hugging Face Hub model cache inventory + generalized local inventory sync state. */
function applyV12(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS local_inventory_sync_state (
      key TEXT PRIMARY KEY,
      value TEXT
    );

    INSERT OR IGNORE INTO local_inventory_sync_state (key, value)
    SELECT key, value FROM software_sync_state;

    CREATE TABLE IF NOT EXISTS local_inventory_sync_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL CHECK (source IN ('mac_apps', 'brew', 'huggingface')),
      started_at TEXT NOT NULL,
      finished_at TEXT,
      status TEXT NOT NULL CHECK (status IN ('running', 'success', 'partial', 'failed')),
      inserted INTEGER NOT NULL DEFAULT 0,
      updated INTEGER NOT NULL DEFAULT 0,
      marked_missing INTEGER NOT NULL DEFAULT 0,
      warnings_count INTEGER NOT NULL DEFAULT 0,
      error_summary TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}'
    );

    INSERT OR IGNORE INTO local_inventory_sync_runs (
      id, source, started_at, finished_at, status, inserted, updated,
      marked_missing, warnings_count, error_summary, metadata_json
    )
    SELECT id, source, started_at, finished_at, status, inserted, updated,
           marked_missing, warnings_count, error_summary, metadata_json
    FROM software_sync_runs;

    CREATE INDEX IF NOT EXISTS idx_local_inventory_sync_runs_source_started
      ON local_inventory_sync_runs(source, started_at);

    CREATE TABLE IF NOT EXISTS huggingface_models (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      repo_type TEXT NOT NULL DEFAULT 'model' CHECK (repo_type IN ('model', 'dataset', 'space')),
      repo_id TEXT NOT NULL,
      cache_root TEXT NOT NULL,
      cache_dir TEXT NOT NULL,
      refs_json TEXT NOT NULL DEFAULT '{}',
      snapshot_count INTEGER NOT NULL DEFAULT 0,
      blob_count INTEGER NOT NULL DEFAULT 0,
      size_bytes INTEGER NOT NULL DEFAULT 0,
      warnings_json TEXT NOT NULL DEFAULT '[]',
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      missing_since TEXT,
      inserted_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(cache_root, repo_type, repo_id)
    );

    CREATE INDEX IF NOT EXISTS idx_huggingface_models_repo
      ON huggingface_models(repo_type, repo_id);
    CREATE INDEX IF NOT EXISTS idx_huggingface_models_cache_root
      ON huggingface_models(cache_root);
    CREATE INDEX IF NOT EXISTS idx_huggingface_models_last_seen
      ON huggingface_models(last_seen_at);
    CREATE INDEX IF NOT EXISTS idx_huggingface_models_missing_since
      ON huggingface_models(missing_since);
    CREATE INDEX IF NOT EXISTS idx_huggingface_models_size
      ON huggingface_models(size_bytes);

    CREATE TABLE IF NOT EXISTS huggingface_model_revisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      model_id INTEGER NOT NULL REFERENCES huggingface_models(id) ON DELETE CASCADE,
      revision TEXT NOT NULL,
      snapshot_path TEXT NOT NULL,
      refs_json TEXT NOT NULL DEFAULT '[]',
      file_count INTEGER NOT NULL DEFAULT 0,
      last_modified_ms INTEGER,
      warnings_json TEXT NOT NULL DEFAULT '[]',
      inserted_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(model_id, revision)
    );

    CREATE INDEX IF NOT EXISTS idx_huggingface_model_revisions_model
      ON huggingface_model_revisions(model_id);
    CREATE INDEX IF NOT EXISTS idx_huggingface_model_revisions_revision
      ON huggingface_model_revisions(revision);

    UPDATE meta_schema SET version = 12 WHERE id = 1;
  `);
}

/** Atuin directory activity projection, rebuilt from read-only Atuin history.db. */
function applyV13(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS atuin_directory_activity_dirs (
      cwd TEXT PRIMARY KEY,
      raw_command_count INTEGER NOT NULL DEFAULT 0,
      filtered_command_count INTEGER NOT NULL DEFAULT 0,
      raw_failed_count INTEGER NOT NULL DEFAULT 0,
      filtered_failed_count INTEGER NOT NULL DEFAULT 0,
      first_timestamp_ns INTEGER,
      last_timestamp_ns INTEGER,
      last_exit INTEGER,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_atuin_directory_activity_dirs_filtered
      ON atuin_directory_activity_dirs(filtered_command_count DESC, last_timestamp_ns DESC);
    CREATE INDEX IF NOT EXISTS idx_atuin_directory_activity_dirs_raw
      ON atuin_directory_activity_dirs(raw_command_count DESC, last_timestamp_ns DESC);
    CREATE INDEX IF NOT EXISTS idx_atuin_directory_activity_dirs_last
      ON atuin_directory_activity_dirs(last_timestamp_ns DESC);

    CREATE TABLE IF NOT EXISTS atuin_directory_activity_commands (
      cwd TEXT NOT NULL,
      command TEXT NOT NULL,
      raw_count INTEGER NOT NULL DEFAULT 0,
      filtered_count INTEGER NOT NULL DEFAULT 0,
      raw_failed_count INTEGER NOT NULL DEFAULT 0,
      filtered_failed_count INTEGER NOT NULL DEFAULT 0,
      first_timestamp_ns INTEGER,
      last_timestamp_ns INTEGER,
      last_exit INTEGER,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (cwd, command)
    );

    CREATE INDEX IF NOT EXISTS idx_atuin_directory_activity_commands_filtered
      ON atuin_directory_activity_commands(cwd, filtered_count DESC, last_timestamp_ns DESC);
    CREATE INDEX IF NOT EXISTS idx_atuin_directory_activity_commands_raw
      ON atuin_directory_activity_commands(cwd, raw_count DESC, last_timestamp_ns DESC);

    CREATE TABLE IF NOT EXISTS atuin_directory_activity_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      rule_version INTEGER NOT NULL,
      filter_config_hash TEXT NOT NULL,
      last_rebuilt_at TEXT,
      last_error TEXT,
      error_code TEXT,
      source_entry_count INTEGER NOT NULL DEFAULT 0,
      derived_directory_count INTEGER NOT NULL DEFAULT 0,
      derived_command_count INTEGER NOT NULL DEFAULT 0,
      last_rebuild_duration_ms INTEGER,
      updated_at TEXT NOT NULL
    );

    UPDATE meta_schema SET version = 13 WHERE id = 1;
  `);
}

/** LM Studio downloaded model inventory, keyed by resolved models root + publisher/model. */
function applyV14(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS local_inventory_sync_runs_v14 (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL CHECK (source IN ('mac_apps', 'brew', 'huggingface', 'lmstudio')),
      started_at TEXT NOT NULL,
      finished_at TEXT,
      status TEXT NOT NULL CHECK (status IN ('running', 'success', 'partial', 'failed')),
      inserted INTEGER NOT NULL DEFAULT 0,
      updated INTEGER NOT NULL DEFAULT 0,
      marked_missing INTEGER NOT NULL DEFAULT 0,
      warnings_count INTEGER NOT NULL DEFAULT 0,
      error_summary TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}'
    );

    INSERT OR IGNORE INTO local_inventory_sync_runs_v14 (
      id, source, started_at, finished_at, status, inserted, updated,
      marked_missing, warnings_count, error_summary, metadata_json
    )
    SELECT id, source, started_at, finished_at, status, inserted, updated,
           marked_missing, warnings_count, error_summary, metadata_json
    FROM local_inventory_sync_runs;

    DROP TABLE local_inventory_sync_runs;
    ALTER TABLE local_inventory_sync_runs_v14 RENAME TO local_inventory_sync_runs;

    CREATE INDEX IF NOT EXISTS idx_local_inventory_sync_runs_source_started
      ON local_inventory_sync_runs(source, started_at);

    CREATE TABLE IF NOT EXISTS lmstudio_models (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      publisher TEXT NOT NULL,
      model_name TEXT NOT NULL,
      model_key TEXT NOT NULL,
      models_root TEXT NOT NULL,
      model_dir TEXT NOT NULL,
      format TEXT NOT NULL CHECK (format IN ('gguf', 'mlx_safetensors', 'safetensors', 'mixed', 'unknown')),
      weight_file_count INTEGER NOT NULL DEFAULT 0,
      auxiliary_file_count INTEGER NOT NULL DEFAULT 0,
      total_file_count INTEGER NOT NULL DEFAULT 0,
      total_size_bytes INTEGER NOT NULL DEFAULT 0,
      weight_size_bytes INTEGER NOT NULL DEFAULT 0,
      primary_file TEXT,
      config_json TEXT,
      warnings_json TEXT NOT NULL DEFAULT '[]',
      metadata_json TEXT NOT NULL DEFAULT '{}',
      last_modified_ms INTEGER,
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      missing_since TEXT,
      inserted_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(models_root, model_key)
    );

    CREATE INDEX IF NOT EXISTS idx_lmstudio_models_root
      ON lmstudio_models(models_root);
    CREATE INDEX IF NOT EXISTS idx_lmstudio_models_key
      ON lmstudio_models(model_key);
    CREATE INDEX IF NOT EXISTS idx_lmstudio_models_missing_since
      ON lmstudio_models(missing_since);
    CREATE INDEX IF NOT EXISTS idx_lmstudio_models_size
      ON lmstudio_models(total_size_bytes);
    CREATE INDEX IF NOT EXISTS idx_lmstudio_models_format
      ON lmstudio_models(format);
    CREATE INDEX IF NOT EXISTS idx_lmstudio_models_last_seen
      ON lmstudio_models(last_seen_at);

    CREATE TABLE IF NOT EXISTS lmstudio_model_files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      model_id INTEGER NOT NULL REFERENCES lmstudio_models(id) ON DELETE CASCADE,
      rel_path TEXT NOT NULL,
      file_kind TEXT NOT NULL CHECK (file_kind IN ('weight', 'auxiliary')),
      format TEXT NOT NULL,
      size_bytes INTEGER NOT NULL DEFAULT 0,
      target_path TEXT,
      is_symlink INTEGER NOT NULL DEFAULT 0,
      last_modified_ms INTEGER,
      warnings_json TEXT NOT NULL DEFAULT '[]',
      inserted_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(model_id, rel_path)
    );

    CREATE INDEX IF NOT EXISTS idx_lmstudio_model_files_model
      ON lmstudio_model_files(model_id);
    CREATE INDEX IF NOT EXISTS idx_lmstudio_model_files_kind
      ON lmstudio_model_files(model_id, file_kind);

    UPDATE meta_schema SET version = 14 WHERE id = 1;
  `);
}
