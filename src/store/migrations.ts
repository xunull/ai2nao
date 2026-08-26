import type Database from "better-sqlite3";
import { chromeVisitContentKey } from "../chromeHistory/contentKey.js";

/**
 * The schema version this build knows how to produce. Exported so `/api/health`
 * can report what a client should expect, and so `probeDaemon` can spot a daemon
 * that is mid-migration or built from different code.
 */
export const SCHEMA_VERSION = 60;
const CURRENT_VERSION = SCHEMA_VERSION;

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
    applyV15(db);
    applyV16(db);
    applyV17(db);
    applyV18(db);
    applyV19(db);
    applyV20(db);
    applyV21(db);
    applyV22(db);
    applyV23(db);
    applyV24(db);
    applyV25(db);
    applyV26(db);
    applyV27(db);
    applyV28(db);
    applyV29(db);
    applyV30(db);
    applyV31(db);
    applyV32(db);
    applyV33(db);
    applyV34(db);
    applyV35(db);
    applyV36(db);
    applyV37(db);
    applyV38(db);
    applyV39(db);
    applyV40(db);
    applyV41(db);
    applyV42(db);
    applyV43(db);
    applyV44(db);
    applyV45(db);
    applyV46(db);
    applyV47(db);
    applyV48(db);
    applyV49(db);
    applyV50(db);
    applyV51(db);
    applyV52(db);
    applyV53(db);
    applyV54(db);
    applyV55(db);
    applyV56(db);
    applyV57(db);
    applyV58(db);
    applyV59(db);
    applyV60(db);
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
  if (v < 15) applyV15(db);
  if (v < 16) applyV16(db);
  if (v < 17) applyV17(db);
  if (v < 18) applyV18(db);
  if (v < 19) applyV19(db);
  if (v < 20) applyV20(db);
  if (v < 21) applyV21(db);
  if (v < 22) applyV22(db);
  if (v < 23) applyV23(db);
  if (v < 24) applyV24(db);
  if (v < 25) applyV25(db);
  if (v < 26) applyV26(db);
  if (v < 27) applyV27(db);
  if (v < 28) applyV28(db);
  if (v < 29) applyV29(db);
  if (v < 30) applyV30(db);
  if (v < 31) applyV31(db);
  if (v < 32) applyV32(db);
  if (v < 33) applyV33(db);
  if (v < 34) applyV34(db);
  if (v < 35) applyV35(db);
  if (v < 36) applyV36(db);
  if (v < 37) applyV37(db);
  if (v < 38) applyV38(db);
  if (v < 39) applyV39(db);
  if (v < 40) applyV40(db);
  if (v < 41) applyV41(db);
  if (v < 42) applyV42(db);
  if (v < 43) applyV43(db);
  if (v < 44) applyV44(db);
  if (v < 45) applyV45(db);
  if (v < 46) applyV46(db);
  if (v < 47) applyV47(db);
  if (v < 48) applyV48(db);
  if (v < 49) applyV49(db);
  if (v < 50) applyV50(db);
  if (v < 51) applyV51(db);
  if (v < 52) applyV52(db);
  if (v < 53) applyV53(db);
  if (v < 54) applyV54(db);
  if (v < 55) applyV55(db);
  if (v < 56) applyV56(db);
  if (v < 57) applyV57(db);
  if (v < 58) applyV58(db);
  if (v < 59) applyV59(db);
  if (v < 60) applyV60(db);
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

function applyV38(db: Database.Database): void {
  // Dashboard summary fields on the Claude token index, so the work-dashboard
  // request path can read session list/preview from this table instead of
  // parsing transcripts. CLAUDE_TOKEN_USAGE_RULE_VERSION bumped to 6 so the
  // next work.tokens.refresh tick backfills these for existing rows.
  db.exec(`
    ALTER TABLE claude_session_token_usage ADD COLUMN preview TEXT;
    ALTER TABLE claude_session_token_usage ADD COLUMN message_count INTEGER;

    UPDATE meta_schema SET version = 38 WHERE id = 1;
  `);
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

/**
 * Topic stream: a source-agnostic, rebuildable derived layer for the topic
 * river (Stage 1 = per-visit rows, browsing adapter only). Raw sources stay the
 * source of truth. `payload` (JSON) carries source-specific fields (browsing:
 * host/url/title/transition) so git/shell sources can populate the same table
 * later without a schema change.
 */
function applyV45(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS topic_stream (
      source TEXT NOT NULL,
      profile TEXT NOT NULL,
      source_ref TEXT NOT NULL,
      category TEXT NOT NULL,
      calendar_day TEXT NOT NULL,
      event_time INTEGER NOT NULL,
      weight INTEGER NOT NULL DEFAULT 1,
      payload TEXT,
      inserted_at TEXT NOT NULL,
      PRIMARY KEY (source, profile, source_ref)
    );

    CREATE INDEX IF NOT EXISTS idx_topic_stream_scope_cat_day
      ON topic_stream(source, profile, category, calendar_day);
    CREATE INDEX IF NOT EXISTS idx_topic_stream_scope_day
      ON topic_stream(source, profile, calendar_day);

    CREATE TABLE IF NOT EXISTS topic_stream_state (
      source TEXT NOT NULL,
      profile TEXT NOT NULL,
      rule_version TEXT NOT NULL,
      last_rebuilt_at TEXT,
      last_error TEXT,
      source_event_count INTEGER NOT NULL DEFAULT 0,
      derived_event_count INTEGER NOT NULL DEFAULT 0,
      last_rebuild_duration_ms INTEGER,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (source, profile)
    );

    UPDATE meta_schema SET version = 45 WHERE id = 1;
  `);
}

/**
 * Topic stream Stage 2: session id on each derived row. The rebuild segments
 * visits into research sessions (from_visit chains + time gap) and labels each
 * row with its session's anchor category. Rebuildable, so ADD COLUMN + next
 * rebuild backfills it.
 */
function applyV46(db: Database.Database): void {
  db.exec(`
    ALTER TABLE topic_stream ADD COLUMN session_id TEXT;

    CREATE INDEX IF NOT EXISTS idx_topic_stream_session
      ON topic_stream(source, profile, session_id);

    UPDATE meta_schema SET version = 46 WHERE id = 1;
  `);
}

/**
 * Topic stream Stage 3: conversation adapter (source-agnostic topic engine, 3rd
 * adapter). `topic_codebook` = frozen learned clusters (centroid + LLM/TF-IDF
 * label) keyed by rule_version (`cluster-vN`); new sessions assign to the nearest
 * frozen centroid. `topic_conversation_vectors` caches per-session embeddings of
 * cleaned user messages (keyed by embed_key = cleaner+embedder id) so a rebuild
 * doesn't re-embed. Design: quincy-feat-topic-river-engine-design-20260711.
 */
function applyV47(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS topic_codebook (
      rule_version TEXT NOT NULL,
      cluster_id INTEGER NOT NULL,
      centroid BLOB NOT NULL,
      dim INTEGER NOT NULL,
      label TEXT NOT NULL,
      member_count INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (rule_version, cluster_id)
    );

    CREATE TABLE IF NOT EXISTS topic_conversation_vectors (
      source TEXT NOT NULL,
      session_id TEXT NOT NULL,
      event_time INTEGER NOT NULL,
      msg_count INTEGER NOT NULL DEFAULT 0,
      text_sample TEXT,
      vector BLOB NOT NULL,
      dim INTEGER NOT NULL,
      embed_key TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (source, session_id)
    );

    UPDATE meta_schema SET version = 47 WHERE id = 1;
  `);
}

/**
 * v48 — 定时报告体系:自然日/自然周窗口 + 飞书推送记账。
 *
 * (a) `work_recap_runs.window_key` 原 CHECK 只允许 5 个滚动窗口。SQLite 无法
 *     ALTER 一个 CHECK,所以必须整表重建才能容纳日历窗口 today / last-week。
 * (b) `recap_push_log`:PK (kind, period_key) 保证「至多成功送达一次」。
 *     status='sent' 才算已发;failed 行仍占 PK,重试走 UPSERT + attempts 上限。
 * 设计:quincy-...-design-20260713(office-hours,读代码审阅后修订)。
 */
function applyV48(db: Database.Database): void {
  db.exec(`
    CREATE TABLE work_recap_runs_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      window_key TEXT NOT NULL CHECK (
        window_key IN ('1d', '3d', '7d', '14d', '30d', 'today', 'last-week')
      ),
      generated_at TEXT NOT NULL,
      model TEXT NOT NULL,
      prompt_version TEXT NOT NULL,
      facts_json TEXT NOT NULL,
      inference_json TEXT NOT NULL,
      degraded INTEGER NOT NULL DEFAULT 0,
      degrade_reason TEXT
    );

    INSERT INTO work_recap_runs_new
      (id, window_key, generated_at, model, prompt_version,
       facts_json, inference_json, degraded, degrade_reason)
    SELECT id, window_key, generated_at, model, prompt_version,
           facts_json, inference_json, degraded, degrade_reason
      FROM work_recap_runs;

    DROP TABLE work_recap_runs;
    ALTER TABLE work_recap_runs_new RENAME TO work_recap_runs;

    CREATE INDEX IF NOT EXISTS idx_work_recap_runs_window_time
      ON work_recap_runs(window_key, generated_at DESC);

    CREATE TABLE IF NOT EXISTS recap_push_log (
      kind TEXT NOT NULL CHECK (kind IN ('daily', 'weekly')),
      period_key TEXT NOT NULL,
      due_at TEXT NOT NULL,
      sent_at TEXT,
      run_id INTEGER,
      status TEXT NOT NULL CHECK (status IN ('sent', 'failed', 'skipped')),
      reason TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      lateness_ms INTEGER,
      error TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (kind, period_key)
    );

    UPDATE meta_schema SET version = 48 WHERE id = 1;
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

/** GitHub open-source radar local notes and star health metadata. */
function applyV15(db: Database.Database): void {
  db.exec(`
    ALTER TABLE gh_star ADD COLUMN archived INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE gh_star ADD COLUMN pushed_at TEXT;

    CREATE INDEX IF NOT EXISTS idx_gh_star_pushed_at
      ON gh_star(pushed_at);
    CREATE INDEX IF NOT EXISTS idx_gh_star_archived
      ON gh_star(archived);

    CREATE TABLE IF NOT EXISTS gh_star_note (
      repo_id INTEGER PRIMARY KEY,
      reason TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'new'
        CHECK (status IN ('new', 'reviewed', 'try_next', 'ignore', 'retired')),
      last_reviewed_at TEXT,
      source TEXT NOT NULL DEFAULT 'user'
        CHECK (source IN ('user')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_gh_star_note_status
      ON gh_star_note(status);
    CREATE INDEX IF NOT EXISTS idx_gh_star_note_last_reviewed
      ON gh_star_note(last_reviewed_at);

    UPDATE meta_schema SET version = 15 WHERE id = 1;
  `);
}

/** Materialized GitHub radar insights, safe evidence payloads, and feedback. */
function applyV16(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS gh_radar_insight_snapshot (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      generated_at TEXT NOT NULL,
      status TEXT NOT NULL
        CHECK (status IN ('fresh', 'stale', 'partial', 'empty', 'error')),
      source_fingerprint_json TEXT NOT NULL,
      error_code TEXT,
      duration_ms INTEGER NOT NULL DEFAULT 0,
      stars_scanned INTEGER NOT NULL DEFAULT 0,
      docs_scanned INTEGER NOT NULL DEFAULT 0,
      docs_skipped INTEGER NOT NULL DEFAULT 0,
      candidate_count INTEGER NOT NULL DEFAULT 0,
      insight_count INTEGER NOT NULL DEFAULT 0,
      warnings_json TEXT NOT NULL DEFAULT '[]'
    );

    CREATE TABLE IF NOT EXISTS gh_radar_insight (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      snapshot_id INTEGER NOT NULL REFERENCES gh_radar_insight_snapshot(id) ON DELETE CASCADE,
      fingerprint TEXT NOT NULL,
      kind TEXT NOT NULL
        CHECK (kind IN ('recommended_now', 'rediscovered', 'retire_candidate', 'taste_profile')),
      title TEXT NOT NULL,
      summary TEXT NOT NULL,
      health TEXT NOT NULL
        CHECK (health IN ('strong', 'partial', 'weak', 'stale', 'suppressed')),
      health_reason TEXT NOT NULL,
      score INTEGER NOT NULL DEFAULT 0,
      repo_ids_json TEXT NOT NULL DEFAULT '[]',
      terms_json TEXT NOT NULL DEFAULT '[]',
      evidence_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      UNIQUE(snapshot_id, fingerprint)
    );

    CREATE TABLE IF NOT EXISTS gh_radar_insight_feedback (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      target_type TEXT NOT NULL CHECK (target_type IN ('insight', 'repo')),
      target_id TEXT NOT NULL,
      feedback TEXT NOT NULL CHECK (feedback IN ('useful', 'wrong', 'later', 'ignore')),
      insight_fingerprint TEXT,
      repo_id INTEGER,
      terms_json TEXT NOT NULL DEFAULT '[]',
      expires_at TEXT,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_gh_radar_insight_snapshot_generated
      ON gh_radar_insight_snapshot(generated_at);
    CREATE INDEX IF NOT EXISTS idx_gh_radar_insight_list
      ON gh_radar_insight(snapshot_id, kind, health, score DESC);
    CREATE INDEX IF NOT EXISTS idx_gh_radar_insight_fingerprint
      ON gh_radar_insight(fingerprint);
    CREATE INDEX IF NOT EXISTS idx_gh_radar_feedback_target
      ON gh_radar_insight_feedback(target_type, target_id, expires_at);

    UPDATE meta_schema SET version = 16 WHERE id = 1;
  `);
}

/** Local AI chat sessions and normalized messages for the desktop AI Studio. */
function applyV17(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS llm_chat_sessions (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_message_at TEXT,
      message_count INTEGER NOT NULL DEFAULT 0,
      metadata_json TEXT NOT NULL DEFAULT '{}'
    );

    CREATE TABLE IF NOT EXISTS llm_chat_messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES llm_chat_sessions(id) ON DELETE CASCADE,
      message_id TEXT NOT NULL,
      message_index INTEGER NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('system', 'user', 'assistant')),
      raw_json TEXT NOT NULL,
      plain_text TEXT NOT NULL DEFAULT '',
      preview TEXT NOT NULL DEFAULT '',
      status TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(session_id, message_id),
      UNIQUE(session_id, message_index)
    );

    CREATE INDEX IF NOT EXISTS idx_llm_chat_sessions_recent
      ON llm_chat_sessions(last_message_at DESC, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_llm_chat_messages_session_order
      ON llm_chat_messages(session_id, message_index);
    CREATE INDEX IF NOT EXISTS idx_llm_chat_messages_session_role
      ON llm_chat_messages(session_id, role);

    UPDATE meta_schema SET version = 17 WHERE id = 1;
  `);
}

/** Rebuild AI chat storage for CopilotKit AG-UI. Old assistant-ui data is intentionally dropped. */
function applyV18(db: Database.Database): void {
  db.exec(`
    DROP TABLE IF EXISTS llm_chat_messages;
    DROP TABLE IF EXISTS llm_chat_sessions;

    CREATE TABLE llm_chat_sessions (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      protocol TEXT NOT NULL DEFAULT 'copilotkit-agui',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_message_at TEXT,
      message_count INTEGER NOT NULL DEFAULT 0,
      metadata_json TEXT NOT NULL DEFAULT '{}'
    );

    CREATE TABLE llm_chat_messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES llm_chat_sessions(id) ON DELETE CASCADE,
      message_id TEXT NOT NULL,
      message_index INTEGER NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('system', 'user', 'assistant')),
      raw_json TEXT NOT NULL,
      plain_text TEXT NOT NULL DEFAULT '',
      preview TEXT NOT NULL DEFAULT '',
      status TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(session_id, message_id),
      UNIQUE(session_id, message_index)
    );

    CREATE INDEX idx_llm_chat_sessions_recent
      ON llm_chat_sessions(last_message_at DESC, updated_at DESC);
    CREATE INDEX idx_llm_chat_messages_session_order
      ON llm_chat_messages(session_id, message_index);
    CREATE INDEX idx_llm_chat_messages_session_role
      ON llm_chat_messages(session_id, role);

    UPDATE meta_schema SET version = 18 WHERE id = 1;
  `);
}

/** Allow AG-UI tool/result sidecar messages while preserving existing chat rows. */
function applyV19(db: Database.Database): void {
  db.exec(`
    CREATE TABLE llm_chat_messages_v19 (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES llm_chat_sessions(id) ON DELETE CASCADE,
      message_id TEXT NOT NULL,
      message_index INTEGER NOT NULL,
      role TEXT NOT NULL CHECK (
        role IN ('developer', 'system', 'user', 'assistant', 'tool', 'activity', 'reasoning')
      ),
      raw_json TEXT NOT NULL,
      plain_text TEXT NOT NULL DEFAULT '',
      preview TEXT NOT NULL DEFAULT '',
      status TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(session_id, message_id),
      UNIQUE(session_id, message_index)
    );

    INSERT INTO llm_chat_messages_v19 (
      id, session_id, message_id, message_index, role, raw_json, plain_text,
      preview, status, created_at, updated_at
    )
    SELECT
      id, session_id, message_id, message_index, role, raw_json, plain_text,
      preview, status, created_at, updated_at
    FROM llm_chat_messages;

    DROP TABLE llm_chat_messages;
    ALTER TABLE llm_chat_messages_v19 RENAME TO llm_chat_messages;

    CREATE INDEX idx_llm_chat_messages_session_order
      ON llm_chat_messages(session_id, message_index);
    CREATE INDEX idx_llm_chat_messages_session_role
      ON llm_chat_messages(session_id, role);

    UPDATE meta_schema SET version = 19 WHERE id = 1;
  `);
}

/** Persistent local Bash permission rules for AI Chat shell approval. */
function applyV20(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS bash_permission_rules (
      id TEXT PRIMARY KEY,
      tool_name TEXT NOT NULL,
      behavior TEXT NOT NULL CHECK (behavior IN ('allow', 'ask', 'deny')),
      rule_type TEXT NOT NULL CHECK (rule_type IN ('exact', 'prefix', 'wildcard')),
      rule_content TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'user',
      note TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_used_at TEXT,
      use_count INTEGER NOT NULL DEFAULT 0,
      UNIQUE(tool_name, behavior, rule_type, rule_content)
    );

    CREATE INDEX IF NOT EXISTS idx_bash_permission_rules_lookup
      ON bash_permission_rules(tool_name, enabled, behavior);

    UPDATE meta_schema SET version = 20 WHERE id = 1;
  `);
}

/** Scope Bash permission rules to a directory tree instead of only global command text. */
function applyV21(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS bash_permission_rules_v21 (
      id TEXT PRIMARY KEY,
      tool_name TEXT NOT NULL,
      scope_type TEXT NOT NULL DEFAULT 'global' CHECK (scope_type IN ('global', 'directory')),
      scope_value TEXT NOT NULL DEFAULT '',
      behavior TEXT NOT NULL CHECK (behavior IN ('allow', 'ask', 'deny')),
      rule_type TEXT NOT NULL CHECK (rule_type IN ('exact', 'prefix', 'wildcard')),
      rule_content TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'user',
      note TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_used_at TEXT,
      use_count INTEGER NOT NULL DEFAULT 0,
      UNIQUE(tool_name, scope_type, scope_value, behavior, rule_type, rule_content)
    );

    INSERT OR IGNORE INTO bash_permission_rules_v21 (
      id, tool_name, scope_type, scope_value, behavior, rule_type, rule_content,
      source, note, enabled, created_at, updated_at, last_used_at, use_count
    )
    SELECT
      id, tool_name, 'global', '', behavior, rule_type, rule_content,
      source, note, enabled, created_at, updated_at, last_used_at, use_count
    FROM bash_permission_rules;

    DROP TABLE bash_permission_rules;
    ALTER TABLE bash_permission_rules_v21 RENAME TO bash_permission_rules;

    CREATE INDEX IF NOT EXISTS idx_bash_permission_rules_lookup
      ON bash_permission_rules(tool_name, enabled, scope_type, behavior);

    UPDATE meta_schema SET version = 21 WHERE id = 1;
  `);
}

/** Local scheduled task configuration and unified run history. */
function applyV22(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS scheduled_tasks (
      task_key TEXT PRIMARY KEY,
      enabled INTEGER NOT NULL DEFAULT 0,
      interval_seconds INTEGER,
      next_run_at TEXT,
      last_run_id INTEGER,
      lease_owner TEXT,
      lease_until TEXT,
      config_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_due
      ON scheduled_tasks(enabled, next_run_at);
    CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_lease
      ON scheduled_tasks(lease_until);

    CREATE TABLE IF NOT EXISTS scheduled_task_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_key TEXT NOT NULL,
      trigger TEXT NOT NULL CHECK (trigger IN ('manual', 'scheduled', 'cli')),
      started_at TEXT NOT NULL,
      finished_at TEXT,
      status TEXT NOT NULL CHECK (status IN ('running', 'success', 'partial', 'failed', 'skipped')),
      summary_json TEXT NOT NULL DEFAULT '{}',
      error_summary TEXT,
      lease_owner TEXT,
      FOREIGN KEY (task_key) REFERENCES scheduled_tasks(task_key) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_scheduled_task_runs_task_started
      ON scheduled_task_runs(task_key, started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_scheduled_task_runs_status
      ON scheduled_task_runs(status, started_at DESC);

    UPDATE meta_schema SET version = 22 WHERE id = 1;
  `);
}

/** Derived Codex session token usage index for project-level full-history totals. */
function applyV23(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS codex_session_token_usage (
      session_id TEXT PRIMARY KEY,
      rollout_path TEXT NOT NULL,
      rollout_mtime_ms INTEGER NOT NULL,
      rollout_size_bytes INTEGER NOT NULL,
      cwd TEXT NOT NULL,
      project_key TEXT NOT NULL,
      project_path TEXT NOT NULL,
      identity_confidence TEXT NOT NULL CHECK (identity_confidence IN ('high', 'low')),
      title TEXT,
      model TEXT,
      git_branch TEXT,
      created_at TEXT,
      last_updated_at TEXT NOT NULL,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      total_tokens INTEGER NOT NULL DEFAULT 0,
      token_status TEXT NOT NULL CHECK (token_status IN ('full', 'unknown', 'error')),
      parse_error TEXT,
      missing_since TEXT,
      source_seen_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_codex_token_project_updated
      ON codex_session_token_usage(project_key, last_updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_codex_token_updated
      ON codex_session_token_usage(last_updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_codex_token_rollout
      ON codex_session_token_usage(rollout_path);
    CREATE INDEX IF NOT EXISTS idx_codex_token_missing
      ON codex_session_token_usage(missing_since);

    CREATE TABLE IF NOT EXISTS codex_token_usage_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      rule_version INTEGER NOT NULL,
      last_rebuilt_at TEXT,
      last_error TEXT,
      source_session_count INTEGER NOT NULL DEFAULT 0,
      indexed_session_count INTEGER NOT NULL DEFAULT 0,
      token_known_session_count INTEGER NOT NULL DEFAULT 0,
      token_unknown_session_count INTEGER NOT NULL DEFAULT 0,
      error_session_count INTEGER NOT NULL DEFAULT 0,
      skipped_unchanged_count INTEGER NOT NULL DEFAULT 0,
      duration_ms INTEGER,
      updated_at TEXT NOT NULL
    );

    UPDATE meta_schema SET version = 23 WHERE id = 1;
  `);
}

/** Derived Claude Code session token usage index for fast token ranking. */
function applyV24(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS claude_session_token_usage (
      session_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      file_path TEXT NOT NULL,
      file_mtime_ms INTEGER NOT NULL,
      file_size_bytes INTEGER NOT NULL,
      cwd TEXT NOT NULL,
      project_key TEXT NOT NULL,
      project_path TEXT NOT NULL,
      identity_confidence TEXT NOT NULL CHECK (identity_confidence IN ('high', 'low')),
      title TEXT,
      created_at TEXT,
      last_updated_at TEXT NOT NULL,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      total_tokens INTEGER NOT NULL DEFAULT 0,
      token_status TEXT NOT NULL CHECK (token_status IN ('full', 'unknown', 'error')),
      parse_error TEXT,
      missing_since TEXT,
      source_seen_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_claude_token_project_updated
      ON claude_session_token_usage(project_key, last_updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_claude_token_updated
      ON claude_session_token_usage(last_updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_claude_token_file
      ON claude_session_token_usage(file_path);
    CREATE INDEX IF NOT EXISTS idx_claude_token_missing
      ON claude_session_token_usage(missing_since);

    CREATE TABLE IF NOT EXISTS claude_session_token_usage_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      rule_version INTEGER NOT NULL,
      last_rebuilt_at TEXT,
      last_error TEXT,
      source_session_count INTEGER NOT NULL DEFAULT 0,
      indexed_session_count INTEGER NOT NULL DEFAULT 0,
      token_known_session_count INTEGER NOT NULL DEFAULT 0,
      token_unknown_session_count INTEGER NOT NULL DEFAULT 0,
      error_session_count INTEGER NOT NULL DEFAULT 0,
      skipped_unchanged_count INTEGER NOT NULL DEFAULT 0,
      duration_ms INTEGER,
      updated_at TEXT NOT NULL
    );

    UPDATE meta_schema SET version = 24 WHERE id = 1;
  `);
}

/** Derived Claude Code + Codex session active-duration index for work projects. */
function applyV25(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS work_session_duration (
      source TEXT NOT NULL CHECK (source IN ('claude-code', 'codex')),
      session_id TEXT NOT NULL,
      transcript_path TEXT NOT NULL,
      transcript_mtime_ms INTEGER NOT NULL,
      transcript_size_bytes INTEGER NOT NULL,
      cwd TEXT NOT NULL,
      project_key TEXT NOT NULL,
      project_path TEXT NOT NULL,
      identity_confidence TEXT NOT NULL CHECK (identity_confidence IN ('high', 'low')),
      title TEXT,
      started_at TEXT,
      ended_at TEXT,
      wall_ms INTEGER NOT NULL DEFAULT 0,
      active_ms INTEGER NOT NULL DEFAULT 0,
      event_count INTEGER NOT NULL DEFAULT 0,
      idle_threshold_ms INTEGER NOT NULL,
      duration_status TEXT NOT NULL CHECK (duration_status IN ('full', 'unknown', 'error')),
      parse_error TEXT,
      missing_since TEXT,
      source_seen_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (source, session_id)
    );

    CREATE INDEX IF NOT EXISTS idx_work_duration_project_ended
      ON work_session_duration(project_key, ended_at DESC);
    CREATE INDEX IF NOT EXISTS idx_work_duration_source_session
      ON work_session_duration(source, session_id);
    CREATE INDEX IF NOT EXISTS idx_work_duration_transcript
      ON work_session_duration(transcript_path);
    CREATE INDEX IF NOT EXISTS idx_work_duration_missing
      ON work_session_duration(missing_since);

    CREATE TABLE IF NOT EXISTS work_duration_state (
      source TEXT PRIMARY KEY CHECK (source IN ('claude-code', 'codex')),
      rule_version INTEGER NOT NULL,
      last_rebuilt_at TEXT,
      last_error TEXT,
      source_session_count INTEGER NOT NULL DEFAULT 0,
      indexed_session_count INTEGER NOT NULL DEFAULT 0,
      duration_known_session_count INTEGER NOT NULL DEFAULT 0,
      duration_unknown_session_count INTEGER NOT NULL DEFAULT 0,
      error_session_count INTEGER NOT NULL DEFAULT 0,
      skipped_unchanged_count INTEGER NOT NULL DEFAULT 0,
      duration_ms INTEGER,
      updated_at TEXT NOT NULL
    );

    UPDATE meta_schema SET version = 25 WHERE id = 1;
  `);
}

/**
 * work_recap_runs: append-only event log of generated commit-based recaps.
 *
 * Each row = one (windowKey, generatedAt) snapshot. UI displays the latest
 * per window and lets the user expand history. Retention is enforced
 * application-side via cleanupRetention(windowKey, keep=200).
 *
 * facts_json and inference_json are stored as JSON-encoded TEXT so the
 * payload shape can evolve without migrations as long as parsers are
 * defensive (workRecap design Phase 1 keeps the shape strict; future
 * evolution will bump prompt_version).
 */
function applyV26(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS work_recap_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      window_key TEXT NOT NULL CHECK (window_key IN ('1d', '3d', '7d', '14d', '30d')),
      generated_at TEXT NOT NULL,
      model TEXT NOT NULL,
      prompt_version TEXT NOT NULL,
      facts_json TEXT NOT NULL,
      inference_json TEXT NOT NULL,
      degraded INTEGER NOT NULL DEFAULT 0,
      degrade_reason TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_work_recap_runs_window_time
      ON work_recap_runs(window_key, generated_at DESC);

    UPDATE meta_schema SET version = 26 WHERE id = 1;
  `);
}

/**
 * v27 — Activity Cosmos `/dashboard/cosmos` 派生索引。
 *
 * 两张表 + 单例 state（设计文档 D3 schema 决策）：
 *
 *   work_cosmos_points
 *     - 每 session 一行；x/y 是 UMAP 投影后的 2D 坐标
 *     - **不含** summary 文本（默认不进 API payload）
 *     - source_mtime_ms / source_size_bytes 给 D2 增量 skip 用
 *     - missing_since 跟 token usage 表语义一致
 *
 *   work_cosmos_embeddings
 *     - sidecar：summary TEXT + vector BLOB（float32 raw bytes）
 *     - 永远不进 API；只供 refresh.ts 自己读写
 *     - FK 到 points.session_id；cascade delete 保证孤儿不会留下
 *
 *   work_cosmos_state
 *     - 单例：rule_version、最近一次 refresh 统计
 *     - rule_version 自愈跟 claudeTokenUsage 同 pattern（v1 起步）
 */
function applyV27(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS work_cosmos_points (
      session_id TEXT PRIMARY KEY,
      source TEXT NOT NULL CHECK (source IN ('claude', 'codex')),
      source_path TEXT NOT NULL,
      source_mtime_ms INTEGER NOT NULL,
      source_size_bytes INTEGER NOT NULL,
      project_key TEXT NOT NULL,
      project_path TEXT NOT NULL,
      total_tokens INTEGER NOT NULL DEFAULT 0,
      x REAL,
      y REAL,
      cluster_id TEXT,
      token_status TEXT NOT NULL CHECK (token_status IN ('full', 'unknown', 'error')),
      embedding_status TEXT NOT NULL CHECK (
        embedding_status IN (
          'ok', 'pending', 'no_summary', 'rate_limited', 'auth_failed', 'provider_error'
        )
      ),
      missing_since TEXT,
      source_seen_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_work_cosmos_points_source_seen
      ON work_cosmos_points(source_seen_at);
    CREATE INDEX IF NOT EXISTS idx_work_cosmos_points_project
      ON work_cosmos_points(project_key);

    CREATE TABLE IF NOT EXISTS work_cosmos_embeddings (
      session_id TEXT PRIMARY KEY
        REFERENCES work_cosmos_points(session_id) ON DELETE CASCADE,
      embedding_dim INTEGER NOT NULL,
      vector BLOB NOT NULL,
      summary TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS work_cosmos_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      rule_version INTEGER NOT NULL,
      last_rebuilt_at TEXT,
      last_error TEXT,
      source_session_count INTEGER NOT NULL DEFAULT 0,
      indexed_session_count INTEGER NOT NULL DEFAULT 0,
      embedded_session_count INTEGER NOT NULL DEFAULT 0,
      no_summary_session_count INTEGER NOT NULL DEFAULT 0,
      error_session_count INTEGER NOT NULL DEFAULT 0,
      skipped_unchanged_count INTEGER NOT NULL DEFAULT 0,
      projection_method TEXT NOT NULL DEFAULT 'none'
        CHECK (projection_method IN ('umap', 'pca', 'none')),
      projected_session_count INTEGER NOT NULL DEFAULT 0,
      duration_ms INTEGER,
      updated_at TEXT NOT NULL
    );

    UPDATE meta_schema SET version = 27 WHERE id = 1;
  `);
}

/**
 * v28 — Claude prompt-cache input breakdown.
 *
 * `claude_session_token_usage.input_tokens` is the FUSED billed input
 * (fresh + cache_creation + cache_read). To show "how much of my Claude
 * input is cache replay", we store the two cache components separately.
 * `真实新增 input` is derived as input_tokens - creation - read.
 *
 * Both default 0; existing rows get 0 until the next refresh, which
 * self-heals (CLAUDE_TOKEN_USAGE_RULE_VERSION bumped 2→3) and reparses
 * every Claude session to fill them. Codex has no equivalent — its table
 * is intentionally left unchanged.
 */
function applyV28(db: Database.Database): void {
  db.exec(`
    ALTER TABLE claude_session_token_usage
      ADD COLUMN cache_read_input_tokens INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE claude_session_token_usage
      ADD COLUMN cache_creation_input_tokens INTEGER NOT NULL DEFAULT 0;

    UPDATE meta_schema SET version = 28 WHERE id = 1;
  `);
}

/**
 * v29 — Codex reasoning (thinking) output breakdown.
 *
 * `codex_session_token_usage.output_tokens` is the full output. Codex reports
 * reasoning_output_tokens as a SUBSET of it (OpenAI semantics). We store it
 * separately so the "Codex 输出构成" view can show how much output was
 * reasoning vs visible output. 正常输出 = output_tokens - reasoning.
 *
 * Defaults 0; existing rows get 0 until the next refresh, which self-heals
 * (CODEX_TOKEN_USAGE_RULE_VERSION bumped 2->3) and reparses every Codex
 * session to fill it. Claude has no reasoning concept — its table is left
 * unchanged.
 */
function applyV29(db: Database.Database): void {
  db.exec(`
    ALTER TABLE codex_session_token_usage
      ADD COLUMN reasoning_output_tokens INTEGER NOT NULL DEFAULT 0;

    UPDATE meta_schema SET version = 29 WHERE id = 1;
  `);
}

/**
 * v30 — Codex per-event token timeline (`codex_token_usage_event`).
 *
 * Problem: `codex_session_token_usage` stores ONE row per session with a single
 * `last_updated_at`. The trend page buckets by that date, so a session resumed
 * across many days (Codex keeps appending to one rollout) collapses ALL its
 * tokens onto its final day — e.g. a 6/11→6/18 session put 200M tokens on 6/18
 * and left 6/11..6/17 empty even though Codex ran heavily every day. Claude
 * dodges this only because it opens a fresh session file per conversation.
 *
 * Fix: record each `token_count` event's per-event token delta against its own
 * timestamp. The trend reads codex token sums from this table (bucketed by
 * `event_at`), so tokens land on the day they were actually consumed. Session
 * counts / coverage stay on the per-session table (they're about sessions, not
 * time-distributed tokens). Investigation 2026-06-18.
 *
 * Rows are (re)written per session during refresh (delete-then-insert), gated
 * by CODEX_TOKEN_USAGE_RULE_VERSION (bumped 3->4) so existing installs backfill
 * on the next tick. No data is derived here; the table starts empty and the
 * self-heal full reparse populates it.
 */
function applyV30(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS codex_token_usage_event (
      session_id TEXT NOT NULL,
      event_at TEXT NOT NULL,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      reasoning_output_tokens INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_codex_token_event_session
      ON codex_token_usage_event(session_id);
    CREATE INDEX IF NOT EXISTS idx_codex_token_event_at
      ON codex_token_usage_event(event_at);

    UPDATE meta_schema SET version = 30 WHERE id = 1;
  `);
}

/**
 * v31 — Codex cached-input (cache-hit) breakdown.
 *
 * Codex reports `cached_input_tokens` as a SUBSET of `input_tokens` (its mirror
 * of Claude's cache_read) — typically ~95% of input on long sessions. We never
 * captured it (input_tokens already includes it, so the total was always right;
 * nothing needed the split until the tokens-trend cache toggle). Persist it on
 * BOTH the per-session row and the per-event timeline so the toggle can exclude
 * Codex cache symmetrically with Claude.
 *
 * Defaults 0; existing rows backfill on the next refresh via the
 * CODEX_TOKEN_USAGE_RULE_VERSION 4->5 self-heal. total_tokens is unchanged
 * (cached ⊆ input, never added on top). Investigation 2026-06-18.
 */
function applyV31(db: Database.Database): void {
  db.exec(`
    ALTER TABLE codex_session_token_usage
      ADD COLUMN cached_input_tokens INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE codex_token_usage_event
      ADD COLUMN cached_input_tokens INTEGER NOT NULL DEFAULT 0;

    UPDATE meta_schema SET version = 31 WHERE id = 1;
  `);
}

/**
 * v32 — Claude per-session dominant model (for USD cost estimation).
 *
 * The Claude token row had no model; the model lives per-message in the jsonl.
 * The tokens-trend cost view prices each session by its model (Opus vs Sonnet
 * differ ~5x), so we capture the session's DOMINANT model (the one with the
 * most output tokens, real data: 96% of sessions are single-model). Codex
 * already stores its model.
 *
 * Defaults NULL; existing rows backfill on the next refresh via the
 * CLAUDE_TOKEN_USAGE_RULE_VERSION 4->5 self-heal. NULL model → cost shows "—"
 * (unpriced), never guessed. Investigation 2026-06-19.
 */
function applyV32(db: Database.Database): void {
  db.exec(`
    ALTER TABLE claude_session_token_usage
      ADD COLUMN model TEXT;

    UPDATE meta_schema SET version = 32 WHERE id = 1;
  `);
}

/**
 * v33 — synced model prices (models.dev) for the USD cost view.
 *
 * The cost view priced from a vendored static snapshot in src/cost/pricing.ts.
 * This table lets the `model-price-sync` scheduler task keep prices fresh and
 * auto-cover new models (e.g. gpt-5.5). pricing.ts becomes DB-first: the
 * vendored map is the seed/fallback, rows here override it (synced wins).
 *
 * Costs are stored as USD PER TOKEN (models.dev gives per-1M; the sync divides
 * by 1e6). cache_creation maps models.dev's cache_write. Starts empty; the
 * task is default-disabled (no network until the user enables it). 2026-06-19.
 */
/**
 * v34 — pluggable external-provider usage sync (MiniMax #1).
 *
 * `provider_config`: per-provider enable flag + API key (local-first secret,
 * stored plaintext in the local DB; NEVER returned over the API — routes mask
 * it to `hasKey`). `provider_usage`: the latest usage SNAPSHOT per provider,
 * one row per item (e.g. MiniMax returns per-model-group remaining quota, so
 * item_key = model_name). Snapshot-only — these providers expose a current
 * remaining-quota snapshot, not per-day history. Both seed empty; the
 * `provider.usage.sync` scheduler task (default-disabled) populates them.
 * 2026-06-19.
 */
function applyV34(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS provider_config (
      provider TEXT PRIMARY KEY,
      enabled INTEGER NOT NULL DEFAULT 0,
      api_key TEXT,
      last_sync_at TEXT,
      last_status TEXT,
      last_error TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS provider_usage (
      provider TEXT NOT NULL,
      item_key TEXT NOT NULL,
      label TEXT NOT NULL,
      remaining_percent REAL,
      reset_at TEXT,
      detail_json TEXT,
      synced_at TEXT NOT NULL,
      PRIMARY KEY (provider, item_key)
    );

    UPDATE meta_schema SET version = 34 WHERE id = 1;
  `);
}

/**
 * Per-project git line churn (token-vs-git output analysis).
 *
 *   git_line_churn       : repo-level (project_key = repos.path_canonical) per-day
 *                          added/deleted/commits. day = author-date local calendar day.
 *   git_line_churn_state : per-repo incremental cursor. `rule_version` forces a full
 *                          rescan when denoise/author/tz/floor cohort changes (the
 *                          incremental path never self-heals a cohort change).
 */
function applyV35(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS git_line_churn (
      project_key TEXT NOT NULL,
      day TEXT NOT NULL,
      added INTEGER NOT NULL DEFAULT 0,
      deleted INTEGER NOT NULL DEFAULT 0,
      commits INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (project_key, day)
    );
    CREATE INDEX IF NOT EXISTS idx_git_line_churn_day
      ON git_line_churn(day);

    CREATE TABLE IF NOT EXISTS git_line_churn_state (
      repo_path TEXT PRIMARY KEY,
      last_synced_sha TEXT,
      rule_version INTEGER NOT NULL DEFAULT 0,
      author_email TEXT,
      updated_at TEXT NOT NULL,
      last_error TEXT
    );

    UPDATE meta_schema SET version = 35 WHERE id = 1;
  `);
}

/**
 * App-level config (settings page). Flat key/value bag for NON-secret preferences
 * (e.g. `scan.roots`). Secrets do NOT live here — the GitHub token stays in its
 * 0600 file via src/github/config.ts. `value` is JSON, guarded by a json_valid
 * CHECK so a corrupt/hand-edited row can't smuggle non-JSON into accessors.
 */
function applyV36(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS app_config (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL CHECK (json_valid(value)),
      updated_at TEXT NOT NULL
    );

    UPDATE meta_schema SET version = 36 WHERE id = 1;
  `);
}

function applyV37(db: Database.Database): void {
  // Soft-delete marker for repos no longer found on disk (scan reconcile).
  // NULL = present; a timestamp = first scan that found it gone. Mirrors the
  // missing_since pattern used by huggingface_models / mac_apps / brew_packages.
  db.exec(`
    ALTER TABLE repos ADD COLUMN missing_since TEXT;
    CREATE INDEX IF NOT EXISTS idx_repos_missing_since ON repos(missing_since);

    UPDATE meta_schema SET version = 37 WHERE id = 1;
  `);
}

function applyV33(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS model_prices (
      provider TEXT NOT NULL,
      model_id TEXT NOT NULL,
      input REAL NOT NULL,
      output REAL NOT NULL,
      cache_read REAL NOT NULL DEFAULT 0,
      cache_creation REAL NOT NULL DEFAULT 0,
      source TEXT NOT NULL DEFAULT 'models.dev',
      synced_at TEXT NOT NULL,
      PRIMARY KEY (provider, model_id)
    );
    CREATE INDEX IF NOT EXISTS idx_model_prices_model
      ON model_prices(model_id);

    UPDATE meta_schema SET version = 33 WHERE id = 1;
  `);
}

/**
 * v39 — Claude per-event token timeline (`claude_token_usage_event`).
 *
 * Same day-attribution bug that v30 fixed for Codex, now for Claude. Claude
 * `claude_session_token_usage` stores ONE row per session bucketed by
 * `last_updated_at`, carrying the session's FULL cumulative lifetime total. The
 * "Claude sessions are short-lived" assumption is false: Claude Code resumes /
 * continues one conversation across days, so a session created 6/09 and touched
 * 7/01 dumps its entire 22-day, 2B-token total onto 7/01 (verified: 7/01 had 15
 * sessions, only 1 created that day). The trend then shows today spiking and
 * prior days understated.
 *
 * Fix (mirror of v30): record each deduped assistant message's usage against its
 * own `event_at` (message timestamp). The trend reads Claude token sums from
 * this table bucketed by `event_at`, so tokens land on the day consumed. Session
 * counts / coverage stay on the per-session table. Columns mirror
 * `claude_session_token_usage` exactly (`input_tokens` is FUSED = fresh +
 * cache_read + cache_creation) so a per-bucket SUM reproduces the session-table
 * semantics — asserted by a golden invariant test.
 *
 * `message_id` is the dedup key (same as extractClaudeSessionUsage); UNIQUE
 * (session_id, message_id) makes the per-session delete-then-insert idempotent
 * and aids debugging. Rows are (re)written per session during refresh, gated by
 * CLAUDE_TOKEN_USAGE_RULE_VERSION (bumped 6->7) so existing installs backfill on
 * the next tick via the self-heal full reparse. Investigation 2026-07-01.
 */
function applyV39(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS claude_token_usage_event (
      session_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      event_at TEXT NOT NULL,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_input_tokens INTEGER NOT NULL DEFAULT 0,
      cache_creation_input_tokens INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (session_id, message_id)
    );
    CREATE INDEX IF NOT EXISTS idx_claude_token_event_session
      ON claude_token_usage_event(session_id);
    CREATE INDEX IF NOT EXISTS idx_claude_token_event_at
      ON claude_token_usage_event(event_at, session_id);

    UPDATE meta_schema SET version = 39 WHERE id = 1;
  `);
}

/**
 * v40: MiniMax per-hour billing-history events.
 *
 * MiniMax's undocumented `GET /account/amount` returns charge_records
 * pre-aggregated per (hour × method × model). Unlike claude/codex (parsed from
 * LOCAL JSONL), this is pulled from a REMOTE billing endpoint, lags T+1~T+2, and
 * is opt-in per provider. One row per (event_at, method, model, api_token_name):
 *
 *   method ∈ { cache-read(Text API), cache-create(Text API),
 *              chatcompletion-v2(Text API), <future/unknown> }
 *   input_tokens  = consume_input_token  (for cache-* methods this IS the cache)
 *   output_tokens = consume_output_token (only chatcompletion has output)
 *
 * The trend query classifies cache vs fresh BY METHOD, so no per-row cache
 * columns here — `method` is the classifier. `consume_cash` is kept raw for a
 * future pay-as-you-go cost path (subscription plans bill 0). `raw_json` keeps
 * the verbatim record because the endpoint is undocumented and may drift.
 *
 * PK columns are NOT NULL with '' defaults so a missing/renamed dimension never
 * NULLs the key and silently drops the upsert.
 */
function applyV40(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS minimax_token_usage_event (
      event_at TEXT NOT NULL,
      method TEXT NOT NULL DEFAULT '',
      model TEXT NOT NULL DEFAULT '',
      api_token_name TEXT NOT NULL DEFAULT '',
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      consume_cash TEXT,
      raw_json TEXT,
      PRIMARY KEY (event_at, method, model, api_token_name)
    );
    CREATE INDEX IF NOT EXISTS idx_minimax_token_event_at
      ON minimax_token_usage_event(event_at);

    UPDATE meta_schema SET version = 40 WHERE id = 1;
  `);
}

/**
 * v41: `provider_config.history_enabled` — a SEPARATE opt-in from the
 * remaining-quota snapshot. Enabling a provider must not silently start hitting
 * the undocumented MiniMax /account/amount billing endpoint; history scraping is
 * its own toggle. Default off.
 *
 * Kept as its OWN version (not folded into v40) so it's forward-only: any DB
 * already at v40 — e.g. a dev DB that applied v40 before this column existed —
 * still gets the column here. The pragma check makes the ALTER idempotent.
 */
function applyV41(db: Database.Database): void {
  const cols = db
    .prepare("PRAGMA table_info(provider_config)")
    .all() as { name: string }[];
  if (!cols.some((c) => c.name === "history_enabled")) {
    db.exec(
      "ALTER TABLE provider_config ADD COLUMN history_enabled INTEGER NOT NULL DEFAULT 0;"
    );
  }
  db.exec("UPDATE meta_schema SET version = 41 WHERE id = 1;");
}

/**
 * v42: agent 用户消息统一库 —— 把 claude/codex/opencode 会话里「用户自己发的消息」
 * 抽出来汇进一张可搜可统计的表(v1 只 opencode)。设计:docs/agent-user-messages-design.md。
 *
 * 三轨口径(D2/D5/D6):raw_text(逐字) + raw_payload_json(完整原始 part,用于 cleaner
 * 升级后重清洗,无 per-part 上限) + cleaned_text(清洗后) + is_human。cleaner_version /
 * parser_version 支持「改口径 → 从 payload 重算历史行」自愈(仿 token-usage 的 rule_version)。
 *
 * FTS = 独立 fts5 + trigram(D3/D4):中文子串搜;2 字词(<3 码点)由 app 层 LIKE 兜底
 * (T0 实测 opencode 真实数据:trigram 对 2 字中文命中 0、LIKE 兜住)。独立 fts5 手动同步
 * + AFTER DELETE 触发器(匹配 manifest_fts);cleaner_version 回填走逐行 DELETE+INSERT,
 * 不用 'rebuild'(D10:rebuild 只重 tokenize 影子副本、捡不到更新后的 cleaned_text)。
 *
 * 只存 event_at_utc(D8):不物化 local_day,分桶留查询时 bucketExpr(与全 app 一致)。
 * 孤儿留底 = 从不删(D7):不设 missing_since,增量 watermark 看不到水位之下的删除。
 */
function applyV42(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_user_messages (
      id                 INTEGER PRIMARY KEY,
      source             TEXT NOT NULL CHECK (source IN ('claude','codex','opencode')),
      source_session_id  TEXT NOT NULL,
      source_message_key TEXT NOT NULL,
      project            TEXT,
      event_at_utc       TEXT NOT NULL,
      raw_text           TEXT NOT NULL,
      raw_payload_json   TEXT NOT NULL,
      cleaned_text       TEXT NOT NULL,
      is_human           INTEGER NOT NULL,
      char_len           INTEGER NOT NULL,
      cleaner_version    INTEGER NOT NULL,
      parser_version     INTEGER NOT NULL,
      source_path        TEXT,
      source_seen_at     TEXT NOT NULL,
      ingested_at        TEXT NOT NULL,
      updated_at         TEXT NOT NULL,
      UNIQUE (source, source_session_id, source_message_key)
    );
    CREATE INDEX IF NOT EXISTS idx_aum_source_event
      ON agent_user_messages(source, event_at_utc);

    CREATE VIRTUAL TABLE IF NOT EXISTS agent_user_messages_fts USING fts5(
      cleaned_text,
      source UNINDEXED,
      event_at_utc UNINDEXED,
      tokenize = 'trigram'
    );
    CREATE TRIGGER IF NOT EXISTS agent_user_messages_ad_fts
      AFTER DELETE ON agent_user_messages BEGIN
        DELETE FROM agent_user_messages_fts WHERE rowid = old.id;
      END;

    CREATE TABLE IF NOT EXISTS agent_user_messages_sync_state (
      source        TEXT PRIMARY KEY,
      watermark_ms  INTEGER,
      last_run_at   TEXT,
      last_status   TEXT,
      last_error    TEXT
    );

    UPDATE meta_schema SET version = 42 WHERE id = 1;
  `);
}

/**
 * v43: agent_user_messages 的 windowed 分析(时间线图)查询 =「is_human 过滤 + event_at_utc
 * 范围 + GROUP BY 分桶」,常不带 source filter。v42 的 (source, event_at_utc) 索引 source 打头,
 * 这类查询用不上、会扫表。补覆盖索引 (is_human, event_at_utc, source):is_human 等值 +
 * event_at_utc 范围 seek + source 覆盖分组。设计:docs/agent-messages-analytics-timeline-design.md D7。
 */
function applyV43(db: Database.Database): void {
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_aum_human_event
      ON agent_user_messages(is_human, event_at_utc, source);
    UPDATE meta_schema SET version = 43 WHERE id = 1;
  `);
}

/**
 * v44: 对话↔提交桥(T1a)git commit 摄取落地。git_commits 记录本机全局 git author 的
 * 每个非合并提交(repo_key + commit_hash 主键,幂等 upsert),author_date_utc/committer_date_utc
 * 均为规范化 UTC ISO;project_key = slugFromPath(repo_key) 与三源对话侧的 project 正向编码对齐,
 * 便于后续按项目把提交与对话关联。git_commits_state 存每仓库增量水位(last_hash)与上次运行状态,
 * 供 ingest 决定「lastHash..HEAD 增量」还是「历史被改写/首跑时 --since 全量重扫」。
 */
function applyV44(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS git_commits (
      repo_key           TEXT NOT NULL,
      commit_hash        TEXT NOT NULL,
      author_date_utc    TEXT NOT NULL,
      committer_date_utc TEXT,
      subject            TEXT,
      added              INTEGER NOT NULL DEFAULT 0,
      deleted            INTEGER NOT NULL DEFAULT 0,
      files_changed      INTEGER NOT NULL DEFAULT 0,
      project_key        TEXT,
      ingested_at        TEXT NOT NULL,
      PRIMARY KEY (repo_key, commit_hash)
    );

    CREATE INDEX IF NOT EXISTS idx_git_commits_repo_authored
      ON git_commits(repo_key, author_date_utc, commit_hash);
    CREATE INDEX IF NOT EXISTS idx_git_commits_project
      ON git_commits(project_key);

    CREATE TABLE IF NOT EXISTS git_commits_state (
      repo_key    TEXT PRIMARY KEY,
      last_hash   TEXT,
      last_run_at TEXT,
      last_status TEXT,
      last_error  TEXT
    );

    UPDATE meta_schema SET version = 44 WHERE id = 1;
  `);
}

/**
 * v49: AI 工具清单(ai_tools)。识别本机装了哪些 AI 工具(桌面 app / CLI / 本地运行时 /
 * IDE 插件)。派生自 mac_apps / brew_packages 等现有清点表 + 盲区探测器(PATH/Ollama);
 * evidence 用稳定标识(bundle_id / formula 名 / binary 名),**不含安装路径**(install_path
 * 单列、可变、不进唯一键);软删除对齐 mac_apps/brew(missing_since)。展示时按 tool_key 折叠。
 * 设计:~/.gstack/projects/xunull-ai2nao/20260720-design-ai-tools-inventory.md
 */
function applyV49(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ai_tools (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      tool_key      TEXT NOT NULL,
      name          TEXT NOT NULL,
      kind          TEXT NOT NULL,
      vendor        TEXT,
      detect_source TEXT NOT NULL,
      evidence      TEXT NOT NULL,
      version       TEXT,
      install_path  TEXT,
      first_seen_at TEXT NOT NULL,
      last_seen_at  TEXT NOT NULL,
      missing_since TEXT,
      inserted_at   TEXT NOT NULL,
      updated_at    TEXT NOT NULL,
      UNIQUE(tool_key, detect_source, evidence)
    );

    CREATE INDEX IF NOT EXISTS idx_ai_tools_present
      ON ai_tools(kind, tool_key) WHERE missing_since IS NULL;

    -- 扩 local_inventory_sync_runs 的 source CHECK,加入 'ai_tools'(SQLite 改 CHECK 须重建表;
    -- 沿用 applyV14 的 _vNN 重建套路)。
    CREATE TABLE IF NOT EXISTS local_inventory_sync_runs_v49 (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL CHECK (source IN ('mac_apps', 'brew', 'huggingface', 'lmstudio', 'ai_tools')),
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
    INSERT OR IGNORE INTO local_inventory_sync_runs_v49 (
      id, source, started_at, finished_at, status, inserted, updated,
      marked_missing, warnings_count, error_summary, metadata_json
    )
    SELECT id, source, started_at, finished_at, status, inserted, updated,
           marked_missing, warnings_count, error_summary, metadata_json
    FROM local_inventory_sync_runs;
    DROP TABLE local_inventory_sync_runs;
    ALTER TABLE local_inventory_sync_runs_v49 RENAME TO local_inventory_sync_runs;
    CREATE INDEX IF NOT EXISTS idx_local_inventory_sync_runs_source_started
      ON local_inventory_sync_runs(source, started_at);

    UPDATE meta_schema SET version = 49 WHERE id = 1;
  `);
}

/**
 * v50: 修 local_inventory_sync_runs 的 source CHECK —— 补 'ai_tools'。
 *
 * 为什么单独一版:开发中真实库先被热重载升到了 v49(那一刻的 applyV49 只建了 ai_tools 表、
 * 尚未含 CHECK 重建;重建是稍后才补进 applyV49 的)。已到 v49 的库不会再跑 applyV49,导致
 * CHECK 里缺 'ai_tools',ai_tools.scan 写 sync run 时报「CHECK constraint failed」。migration
 * 一经应用即不可改,故这里独立重建一次。幂等安全:表已含 ai_tools(全新库经 applyV49 重建过)
 * 时,再重建成同样的 CHECK 也无副作用。
 */
function applyV50(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS local_inventory_sync_runs_v50 (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL CHECK (source IN ('mac_apps', 'brew', 'huggingface', 'lmstudio', 'ai_tools')),
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
    INSERT OR IGNORE INTO local_inventory_sync_runs_v50 (
      id, source, started_at, finished_at, status, inserted, updated,
      marked_missing, warnings_count, error_summary, metadata_json
    )
    SELECT id, source, started_at, finished_at, status, inserted, updated,
           marked_missing, warnings_count, error_summary, metadata_json
    FROM local_inventory_sync_runs;
    DROP TABLE local_inventory_sync_runs;
    ALTER TABLE local_inventory_sync_runs_v50 RENAME TO local_inventory_sync_runs;
    CREATE INDEX IF NOT EXISTS idx_local_inventory_sync_runs_source_started
      ON local_inventory_sync_runs(source, started_at);

    UPDATE meta_schema SET version = 50 WHERE id = 1;
  `);
}

/**
 * v51: 给 scheduled_task_runs 补一条以 started_at 打头的索引。
 *
 * 这张表已经有两条索引 —— (task_key, started_at DESC) 和 (status, started_at DESC) ——
 * 看上去「started_at 已经索引过了」。但复合索引只能从最左列开始用,而
 * `listScheduledTaskRuns` 的无过滤分支(src/scheduler/store.ts)是
 * `ORDER BY started_at DESC, id DESC LIMIT ?`,两条都用不上,只能全表扫再排序。
 *
 * 2026-08-08 实测(真实库约 12 万行 run 记录):limit=5 要 123ms、limit=200 要 332ms ——
 * 存在与返回行数无关的约 120ms 固定成本,payload 增长只是叠在上面。诊断办法就是同一端点
 * 跑不同 limit:最小 limit 也慢,说明慢在扫描不在序列化。
 *
 * 带 id 是为了让 ORDER BY 的第二键也走索引,避免退化成「索引取序 + 内存再排」。
 */
function applyV51(db: Database.Database): void {
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_scheduled_task_runs_started
      ON scheduled_task_runs(started_at DESC, id DESC);

    UPDATE meta_schema SET version = 51 WHERE id = 1;
  `);
}

/**
 * 注意力层：macOS knowledgeC 的前台使用时段，以及它的同步水位。
 *
 * 列的语义全部来自 2026-08-10 在真机上的实测（`ai2nao attention probe`），不是
 * 对 CoreDuet 文档的推断：
 *
 *   - 本机的前台流是 `/app/usage`（10349 行 / 19 天），**没有** `/app/inFocus`，
 *     尽管取证文献称后者才是 macOS 的前台流。流名因此不写死，采集侧运行时解析，
 *     并把当时用的流名记进 `attention_sync_state.focus_stream`。
 *   - `ZVALUESTRING` 就是 bundle id，源里**没有**应用显示名，所以这里不存
 *     `app_name`：查询时 LEFT JOIN `mac_apps`（已有 idx_mac_apps_bundle_id）。
 *     存一个查出来的名字既冗余又会过期。
 *   - `ZENDDATE` 全量 0 个 null、最长 span 49.7 分钟，所以每行自带结束时间，
 *     不需要靠锁屏/背光事件封口。153/10343 行 `end == start` 是闪切，属合法数据，
 *     由采集侧的最小时长阈值过滤，不在这里体现。
 *
 * 幂等键是「源库实例 + 源行号 + 分片序号」而不是「bundle + 开始时间」：后者依赖
 * 一个未经验证的假设（同一 app 同一时刻只有一行），而 migration 一经应用即不可改。
 * `part_index` 是必需的 —— 跨本地午夜的时段会被切成多行落库，共享同一个源行号，
 * 没有它第二片会被唯一约束静默吞掉。
 */
function applyV52(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS attention_focus_spans (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      source             TEXT    NOT NULL,
      source_instance_id TEXT    NOT NULL,
      source_row_id      INTEGER NOT NULL,
      part_index         INTEGER NOT NULL DEFAULT 0,
      bundle_id          TEXT    NOT NULL,
      start_ms           INTEGER NOT NULL,
      end_ms             INTEGER NOT NULL,
      duration_ms        INTEGER NOT NULL,
      tz_offset_s        INTEGER,
      local_day          TEXT    NOT NULL,
      inserted_at        TEXT    NOT NULL,
      UNIQUE(source, source_instance_id, source_row_id, part_index)
    );

    CREATE INDEX IF NOT EXISTS idx_attention_spans_day
      ON attention_focus_spans(local_day, start_ms);
    CREATE INDEX IF NOT EXISTS idx_attention_spans_range
      ON attention_focus_spans(start_ms, end_ms);
    CREATE INDEX IF NOT EXISTS idx_attention_spans_bundle_day
      ON attention_focus_spans(bundle_id, local_day);

    CREATE TABLE IF NOT EXISTS attention_sync_state (
      source             TEXT PRIMARY KEY,
      source_instance_id TEXT,
      focus_stream       TEXT,
      watermark_row_id   INTEGER NOT NULL DEFAULT 0,
      anchor_row_id      INTEGER,
      anchor_start_ms    INTEGER,
      anchor_bundle_id   TEXT,
      last_success_at    TEXT,
      last_error         TEXT,
      coverage_from_ms   INTEGER,
      coverage_to_ms     INTEGER
    );

    UPDATE meta_schema SET version = 52 WHERE id = 1;
  `);
}

/**
 * agent_user_messages 收 AI 的话:加 role 列。
 *
 * 在此之前这张表只装 role='user' 的消息(myMessages.ts 的 `if (m.role !== "user")
 * continue`),AI 说的话一个字都没进过 db —— 而 Claude Code 按 30 天滚动窗口删本地
 * transcript,实测 170 个会话里已有 75 个的源文件消失,那些会话的 AI 回答永久没了。
 *
 * **为什么加列而不是建新表**(2026-08-17 eng review 被 codex outside voice 反转):
 * 建新表要付跨两表搜索的全部代价 —— user 行在两表重复、两个 FTS 的 BM25 rank 不可比、
 * 全局 LIMIT 失效、搜索结果只带数字 id 会打错 raw 路由(AgentMessages.tsx:14/81)。
 * 而当初拒绝加列的两条理由,一条(is_human=0 同时表示噪音和 AI 回答)恰恰被这个 role
 * 列本身消解,另一条(表名说谎)是改名问题。
 *
 * **为什么 10 个下游零回归**:它们全部带 `is_human = 1` 过滤(逐个核验过 aiRhythm /
 * home.leads / attention / commitBridge / projectCalendar / topicStream×2 / replay /
 * queries)。assistant 行 is_human=0,天然被隔离在既有查询之外。
 *
 * DEFAULT 'user' 让现有 5.6 万行自动归位 —— 它们本来全是 user 消息,语义正确。
 * 实测 SQLite 的 ADD COLUMN 支持 NOT NULL + DEFAULT + CHECK 组合。
 *
 * 索引形状照抄 idx_aum_human_event(is_human, event_at_utc, source):等值列 + 排序列。
 * EXPLAIN QUERY PLAN 实证那条能让 <3 码点的 LIKE 兜底路径沿时间倒序扫、凑够 LIMIT
 * 就停(5.6 万行 23ms,无 SCAN 无临时排序)。若把 char_len 放进第二列则范围条件会掐断
 * 排序能力,退化成全表扫 + 临时排序。
 *
 * `answering_user_key` 存这条 AI 消息在回答哪个提问(指向同会话内更早的那条 user 行的
 * source_message_key,user 行自身为 NULL)。搜索命中一句 AI 的话时,中位长度只有 87 字,
 * 孤立看不知道在回答什么 —— 这一列让结果能带一行提问上下文。
 *
 * **为什么 ingest 期算而不是查询期算**:实测一条 AI 消息离它回答的那个提问中位隔 6 条、
 * P90 隔 26 条、最远 91 条(中间全是同一轮里被工具调用切开的 AI 正文段)。查询期要沿
 * 时间倒扫找最近的 user 行,而表上没有 (source_session_id, event_at_utc) 索引,50 条
 * 结果就是 50 次子查询。ingest 期顺序扫一遍是 O(n) 且只算一次。
 * 实测 13294 条 kept assistant 100% 能找到前置 kept user,所以 NULL 只会出现在 user 行上。
 */
function applyV53(db: Database.Database): void {
  // pragma 检查让两条 ALTER 幂等 —— 同 applyV41 的模式。SQLite 没有
  // ADD COLUMN IF NOT EXISTS,而「版本号被降回去再 migrate」是真实存在的路径:
  // 三个既有 migration 测试就是这么构造夹具的(migrate 到 head → 改 meta_schema
  // 版本号 → 再 migrate),不做检查会直接 duplicate column name。
  const cols = (
    db.prepare("PRAGMA table_info(agent_user_messages)").all() as {
      name: string;
    }[]
  ).map((c) => c.name);

  if (!cols.includes("role")) {
    db.exec(
      `ALTER TABLE agent_user_messages
         ADD COLUMN role TEXT NOT NULL DEFAULT 'user'
         CHECK (role IN ('user', 'assistant'));`
    );
  }
  if (!cols.includes("answering_user_key")) {
    db.exec(
      "ALTER TABLE agent_user_messages ADD COLUMN answering_user_key TEXT;"
    );
  }

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_aum_role_event
      ON agent_user_messages(role, event_at_utc);

    UPDATE meta_schema SET version = 53 WHERE id = 1;
  `);
}

/**
 * V54:重建 agent_user_messages,去掉 source 列的 CHECK。
 *
 * 为什么要重建整张表(232.5 MB / 6.2 万行):SQLite 不支持修改 CHECK 约束,唯一办法是
 * 12 步重建(新建 → 搬数据 → 删旧 → 改名 → 重建索引触发器)。先例是 applyV49 给
 * local_inventory_sync_runs 扩 source CHECK。这次不写新 CHECK —— source 的合法性
 * 下移到 TS 的 AgentUserMessageSource 联合类型,以后加源改一行类型,零迁移。
 * 保留 role 的 CHECK:它只有两个取值且是本次唯一没被外部数据驱动的列。
 *
 * 三件实测出来、写错就静默的事:
 *
 * 1. **必须包事务。** 仓库里所有 applyVNN 都是裸 db.exec 多语句(全文件只有一处
 *    db.transaction)。实测:崩在 DROP 和 RENAME 之间 → 主表已删、版本号仍是 53、
 *    数据只在 _v54 里,下次启动重跑撞 "no such table" 而 applyVNN 不可改 = 永久
 *    启动失败。小表上这个窗口是毫秒所以从没出过事;这张表实测 6.74 秒。
 *
 * 2. **必须写显式列名,不能用 SELECT *。** role / answering_user_key 是 applyV53
 *    用 ALTER 追加在末尾的。重写建表语句时把 role 挪到 is_human 旁边是人之常情,
 *    而 SELECT * 按列序对应 —— 实测错位后 is_human=42、char_len='/p/a.jsonl',
 *    零报错、事务照常提交。也不能照抄 applyV49 的 INSERT OR IGNORE(冲突时静默丢行);
 *    普通 INSERT 抛错,配合事务就是干净回滚。
 *
 * 3. **触发器和索引会随 DROP TABLE 一起消失,FTS 不会。** 实测:DROP TABLE 不触发
 *    AFTER DELETE,所以独立 fts5 表完好且 rowid 对齐(含空洞);但三个索引和
 *    agent_user_messages_ad_fts 必须显式重建。漏了触发器没有任何东西会报错 ——
 *    搜索走的是 fts JOIN 主表的内连接,孤儿 FTS 行被静默丢弃,只会无限膨胀。
 */
function applyV54(db: Database.Database): void {
  // 幂等:CHECK 已经没了就只推版本号。"版本号被降回去再 migrate" 是真实路径
  // (几个 migration 测试就这么造夹具),不判的话会白搬一遍 232 MB。
  const ddl =
    (
      db
        .prepare(
          "SELECT sql FROM sqlite_master WHERE type='table' AND name='agent_user_messages'"
        )
        .get() as { sql: string } | undefined
    )?.sql ?? "";
  if (!ddl.includes("CHECK (source IN")) {
    db.exec("UPDATE meta_schema SET version = 54 WHERE id = 1;");
    return;
  }

  db.transaction(() => {
    db.exec(`
      CREATE TABLE agent_user_messages_v54 (
        id                 INTEGER PRIMARY KEY,
        source             TEXT NOT NULL,
        source_session_id  TEXT NOT NULL,
        source_message_key TEXT NOT NULL,
        project            TEXT,
        event_at_utc       TEXT NOT NULL,
        raw_text           TEXT NOT NULL,
        raw_payload_json   TEXT NOT NULL,
        cleaned_text       TEXT NOT NULL,
        is_human           INTEGER NOT NULL,
        char_len           INTEGER NOT NULL,
        cleaner_version    INTEGER NOT NULL,
        parser_version     INTEGER NOT NULL,
        source_path        TEXT,
        source_seen_at     TEXT NOT NULL,
        ingested_at        TEXT NOT NULL,
        updated_at         TEXT NOT NULL,
        role               TEXT NOT NULL DEFAULT 'user'
                             CHECK (role IN ('user', 'assistant')),
        answering_user_key TEXT,
        UNIQUE (source, source_session_id, source_message_key)
      );
    `);

    // 19 列逐个写死。id 是 INTEGER PRIMARY KEY(rowid 别名),显式带上它才能保住
    // rowid —— 独立 fts5 靠 rowid = 主表 id 关联,错一个位整个搜索就对不上了。
    db.exec(`
      INSERT INTO agent_user_messages_v54 (
        id, source, source_session_id, source_message_key, project,
        event_at_utc, raw_text, raw_payload_json, cleaned_text, is_human,
        char_len, cleaner_version, parser_version, source_path,
        source_seen_at, ingested_at, updated_at, role, answering_user_key
      )
      SELECT
        id, source, source_session_id, source_message_key, project,
        event_at_utc, raw_text, raw_payload_json, cleaned_text, is_human,
        char_len, cleaner_version, parser_version, source_path,
        source_seen_at, ingested_at, updated_at, role, answering_user_key
      FROM agent_user_messages;
    `);

    db.exec("DROP TABLE agent_user_messages;");
    db.exec("ALTER TABLE agent_user_messages_v54 RENAME TO agent_user_messages;");

    // 三个索引 + 触发器都随旧表没了,逐个重建(形状与 applyV42/V47/V53 一致)。
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_aum_source_event
        ON agent_user_messages(source, event_at_utc);
      CREATE INDEX IF NOT EXISTS idx_aum_human_event
        ON agent_user_messages(is_human, event_at_utc, source);
      CREATE INDEX IF NOT EXISTS idx_aum_role_event
        ON agent_user_messages(role, event_at_utc);

      CREATE TRIGGER IF NOT EXISTS agent_user_messages_ad_fts
        AFTER DELETE ON agent_user_messages BEGIN
          DELETE FROM agent_user_messages_fts WHERE rowid = old.id;
        END;
    `);

    // 事务内自检:行数和 rowid 集合都必须与 FTS 对得上。对不上就抛,整个迁移回滚,
    // 库还停在 v53 —— 好过带着一个搜不全的索引往下跑。
    const bad = db
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM agent_user_messages) AS main_rows,
           (SELECT COUNT(*) FROM agent_user_messages_fts) AS fts_rows,
           (SELECT COUNT(*) FROM agent_user_messages_fts f
              WHERE NOT EXISTS (SELECT 1 FROM agent_user_messages m WHERE m.id = f.rowid)
           ) AS orphan_fts`
      )
      .get() as { main_rows: number; fts_rows: number; orphan_fts: number };
    if (bad.main_rows !== bad.fts_rows || bad.orphan_fts !== 0) {
      throw new Error(
        `applyV54 一致性自检失败: main=${bad.main_rows} fts=${bad.fts_rows} orphan=${bad.orphan_fts}`
      );
    }

    db.exec("UPDATE meta_schema SET version = 54 WHERE id = 1;");
  })();
}

/**
 * V55 — kimi token 用量的两张表。
 *
 * ## 为什么主表是 **agent** 粒度而不是 session 粒度
 *
 * claude / codex 一个会话对应一个文件,所以它们的主表是 session 粒度。
 * kimi 不是:一个会话下有 `agents/<main|agent-N>/wire.jsonl` 多个文件,
 * 实测 29 个会话里 6 个是多 agent,最多一个会话有 **12 个** agent 文件。
 *
 * 如果照抄 session 粒度,那么「12 个 agent 里坏了 1 个」就只能给整个会话
 * 记一个最差态。而趋势页的 token SUM 门禁是 `token_status='full'`,
 * 于是那 11 个好文件的 token 会**整场从图表里消失** —— 一个诊断列
 * (`covered_agents`)只能记录这个损失,阻止不了它。
 * (这条是 codex outside voice 的 X2 抓到的;主评审最初把它写反了。)
 *
 * 一行一个 agent 文件之后:坏的那个 agent 记 error 且不贡献 token,
 * 好的 11 个照常计入。会话级的「11/12 覆盖」是 COUNT 出来的,不用存。
 *
 * 单位差异由 `SourceCapabilities.coverageUnit = "agent"` 显式承载 ——
 * kimi 的覆盖率单位是 agent,claude/codex 是 session,两者不能汇总成
 * 同一个百分比,totals 会因此报 `coverageUnit: "mixed"`。
 *
 * ## 事件键(X3)
 *
 * `(session_id, agent, event_ordinal)`,`event_ordinal` 是该 `usage.record`
 * 在文件内的出现序号。**不用时间戳做键** —— 实测「time 全局唯一」是观察
 * 不是格式契约。ingest 侧按文件事务性 delete-and-replace,所以文件被截断、
 * 重写或删除时旧事件不会残留。
 *
 * `(event_at, session_id, agent)` 复合索引只服务查询(趋势页 event JOIN agent),
 * **不兼任幂等键**。
 *
 * ## 列按原子分量存(X1)
 *
 * fresh_input / cache_read_input / cache_creation_input / output。
 * kimi 的 `usage.record.inputOther` 直接就是 `fresh_input`,零转换 ——
 * 存融合值的话「真实新增」要靠减法,映射写反会得到大负数。
 */
function applyV55(db: Database.Database): void {
  // 幂等:表已在就只推版本号(migration 测试会把版本号降回去重跑)。
  const exists = db
    .prepare(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name='kimi_token_usage_event'"
    )
    .get();
  if (exists) {
    db.exec("UPDATE meta_schema SET version = 55 WHERE id = 1;");
    return;
  }

  db.transaction(() => {
    db.exec(`
      CREATE TABLE kimi_agent_token_usage (
        session_id          TEXT NOT NULL,
        agent               TEXT NOT NULL,
        file_path           TEXT NOT NULL,
        file_mtime_ms       INTEGER NOT NULL,
        file_size_bytes     INTEGER NOT NULL,
        root_kind           TEXT NOT NULL CHECK (root_kind IN ('cli', 'desktop')),
        cwd                 TEXT NOT NULL,
        project_key         TEXT NOT NULL,
        project_path        TEXT NOT NULL,
        identity_confidence TEXT NOT NULL CHECK (identity_confidence IN ('high', 'low')),
        title               TEXT,
        model               TEXT,
        created_at          TEXT,
        last_updated_at     TEXT NOT NULL,
        token_status        TEXT NOT NULL CHECK (token_status IN ('full', 'unknown', 'error')),
        parse_error         TEXT,
        missing_since       TEXT,
        source_seen_at      TEXT NOT NULL,
        updated_at          TEXT NOT NULL,
        PRIMARY KEY (session_id, agent)
      );

      CREATE INDEX idx_kimi_agent_project_updated
        ON kimi_agent_token_usage(project_key, last_updated_at DESC);
      CREATE INDEX idx_kimi_agent_updated
        ON kimi_agent_token_usage(last_updated_at DESC);
      CREATE INDEX idx_kimi_agent_file
        ON kimi_agent_token_usage(file_path);
      CREATE INDEX idx_kimi_agent_missing
        ON kimi_agent_token_usage(missing_since);

      CREATE TABLE kimi_token_usage_event (
        session_id           TEXT NOT NULL,
        agent                TEXT NOT NULL,
        -- 该 usage.record 在文件内的出现序号(0 起)。稳定事件键的一半。
        event_ordinal        INTEGER NOT NULL,
        event_at             TEXT NOT NULL,
        -- 原子分量:不存任何可派生的量(X1)
        fresh_input          INTEGER NOT NULL DEFAULT 0,
        cache_read_input     INTEGER NOT NULL DEFAULT 0,
        cache_creation_input INTEGER NOT NULL DEFAULT 0,
        output               INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (session_id, agent, event_ordinal)
      );

      -- 只服务趋势页的 event JOIN agent + 时间范围;不兼任幂等键。
      CREATE INDEX idx_kimi_token_event_at
        ON kimi_token_usage_event(event_at, session_id, agent);

      CREATE TABLE kimi_token_usage_state (
        id                        INTEGER PRIMARY KEY CHECK (id = 1),
        rule_version              INTEGER NOT NULL,
        last_rebuilt_at           TEXT,
        last_error                TEXT,
        source_agent_count        INTEGER NOT NULL DEFAULT 0,
        indexed_agent_count       INTEGER NOT NULL DEFAULT 0,
        token_known_agent_count   INTEGER NOT NULL DEFAULT 0,
        token_unknown_agent_count INTEGER NOT NULL DEFAULT 0,
        error_agent_count         INTEGER NOT NULL DEFAULT 0,
        skipped_unchanged_count   INTEGER NOT NULL DEFAULT 0,
        duration_ms               INTEGER,
        updated_at                TEXT NOT NULL
      );
    `);
    db.exec("UPDATE meta_schema SET version = 55 WHERE id = 1;");
  })();
}

/**
 * V56 —— `agent_user_messages_sync_state` 加 `ingest_version`。
 *
 * 为什么需要它:ingest 的口径改了之后,**光改代码不够** —— 已入库的行不会重算,
 * 而水位会挡住重扫。仓库对这件事早有家法:五个 token refresh 都是
 * 「读 state 里的版本号,与代码常量比对,不符就本轮强制 full」
 * (见 `claudeTokenUsage/refresh.ts:216-220`)。这一列把同一套机制给到四个
 * `agent_user_messages` 的 ingest。
 *
 * 直接触发它的是 opencode ingest 的水位 bug:消息级过滤器读一个在批循环里被
 * 改写的水位,导致「早创建、晚更新」的 session 的老消息被永久跳过,
 * 真库实测丢了 550/1934 条(28.4%)。修完代码后,既有装机仍需重扫一次才能回填 ——
 * 而重扫正是靠这一列触发的。
 *
 * 默认 0:另外三个 ingest 目前没有版本方案,写 0 表示「未启用」,不是「版本 0 已生效」。
 */
function applyV56(db: Database.Database): void {
  // 表还不在(某些测试手工构造的部分旧库)→ 只推版本号。真实迁移链里它由更早的
  // migration 建好,走不到这一支;PRAGMA 对不存在的表返回空数组而不是抛,
  // 所以必须显式判存在,否则会一路走到 ALTER TABLE 才炸。
  const tableExists = db
    .prepare(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name='agent_user_messages_sync_state'"
    )
    .get();
  if (!tableExists) {
    db.exec("UPDATE meta_schema SET version = 56 WHERE id = 1;");
    return;
  }
  const cols = db
    .prepare("PRAGMA table_info(agent_user_messages_sync_state)")
    .all() as { name: string }[];
  if (cols.some((c) => c.name === "ingest_version")) {
    db.exec("UPDATE meta_schema SET version = 56 WHERE id = 1;");
    return;
  }
  db.transaction(() => {
    db.exec(`
      ALTER TABLE agent_user_messages_sync_state
        ADD COLUMN ingest_version INTEGER NOT NULL DEFAULT 0;
    `);
    db.exec("UPDATE meta_schema SET version = 56 WHERE id = 1;");
  })();
}

/**
 * V57 —— opencode 的 token 事件表 + state 表。
 *
 * opencode 此前在 index.db 里**一张源专属表都没有**,每次看板加载实时读那个
 * 3.2 GB 的外部库。跨源功能全在 index.db 里 join,它不在里面,所以每个跨源功能
 * 都要为它写特例 —— 而没人愿意写,于是它每次都被跳过(趋势页、活跃时长、
 * 排行页少算 89%,全是这个的症状)。
 *
 * **列名刻意不叫 `input_tokens`。** 那个名字在本仓库已经承载「融合」语义:
 * `claude_session_token_usage.input_tokens` 是 fresh + cache_read + cache_creation
 * 的融合值(见 :1816 的 FUSED 注释,以及 :2726「映射写反会得到大负数」的警告)。
 * opencode 的 `message.data.tokens` 是**分离**的,所以照 `kimi_token_usage_event`
 * 的原子分量命名,加第五个分量 reasoning_output。
 *
 * 事件键是 (session_id, message_id) —— opencode 的 message.id 是主键,天然稳定,
 * 不需要像 kimi 那样自造 ordinal。
 *
 * state 表的用途:趋势页 adapter 的 everPresent() 探测「这个源到底有没有被用过」,
 * 它同时看 state 表与数据表(缺一不可 —— 有数据没 state 行、有 state 行没数据,
 * 是两种不同的真实状态)。
 */
function applyV57(db: Database.Database): void {
  const exists = db
    .prepare(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name='opencode_token_usage_event'"
    )
    .get();
  if (exists) {
    db.exec("UPDATE meta_schema SET version = 57 WHERE id = 1;");
    return;
  }
  db.transaction(() => {
    db.exec(`
      CREATE TABLE opencode_token_usage_event (
        session_id           TEXT NOT NULL,
        message_id           TEXT NOT NULL,
        event_at             TEXT NOT NULL,
        -- 原子分量:不存任何可派生的量。融合值一律现算。
        fresh_input          INTEGER NOT NULL DEFAULT 0,
        cache_read_input     INTEGER NOT NULL DEFAULT 0,
        cache_creation_input INTEGER NOT NULL DEFAULT 0,
        output               INTEGER NOT NULL DEFAULT 0,
        reasoning_output     INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (session_id, message_id)
      );

      -- 复合索引:时间范围查询要能只走索引拿到 join 键,与 kimi/claude 一致。
      CREATE INDEX idx_opencode_token_event_at
        ON opencode_token_usage_event(event_at, session_id, message_id);

      CREATE TABLE opencode_token_usage_state (
        id                    INTEGER PRIMARY KEY CHECK (id = 1),
        rule_version          INTEGER NOT NULL,
        last_rebuilt_at       TEXT,
        last_error            TEXT,
        source_message_count  INTEGER NOT NULL DEFAULT 0,
        indexed_event_count   INTEGER NOT NULL DEFAULT 0,
        duration_ms           INTEGER,
        updated_at            TEXT NOT NULL
      );
    `);
    db.exec("UPDATE meta_schema SET version = 57 WHERE id = 1;");
  })();
}

/**
 * V58 —— opencode 的会话级表。
 *
 * V57 的事件表只有 `session_id`,没有项目 —— 而看板的一切聚合都按项目。
 * index.db 里唯一带 opencode 项目信息的是 `agent_user_messages.project`,
 * 但那是 **slug**(`/` → `-`),而看板用的是**规范路径**。slug 不可逆:
 * 目录名本身带 `-` 的(如 `clash-verge-rev`)反解不回来。所以必须单独存。
 *
 * `project_key` 在 ingest 里用 `canonicalizePath(directory, {bestEffort})` 算好 ——
 * 它要 `realpathSync`,进不了 SQL,与 claude/codex/kimi 同一口径。
 *
 * 这张表一次解开三件事:
 *   - 排行页:事件表 join 出项目(O5)
 *   - 趋势页:每个时间桶的 session 计数,coverage 三态才有分母(O6)
 *   - 列表页:`messageCount` 不再写死 0(O8)
 */
function applyV58(db: Database.Database): void {
  const exists = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='opencode_session'")
    .get();
  if (exists) {
    db.exec("UPDATE meta_schema SET version = 58 WHERE id = 1;");
    return;
  }
  db.transaction(() => {
    db.exec(`
      CREATE TABLE opencode_session (
        session_id     TEXT PRIMARY KEY,
        directory      TEXT NOT NULL,
        -- canonicalizePath(directory) —— 与 claude/codex/kimi 的 project_key 同口径
        project_key    TEXT NOT NULL,
        project_path   TEXT NOT NULL,
        title          TEXT,
        created_at     TEXT,
        last_updated_at TEXT NOT NULL,
        -- opencode 的 time_archived。查询侧默认排除已归档,与它自己的列表口径一致。
        archived_at    TEXT,
        -- 真人提问条数。与 kimi 同口径(is_human=1),不是消息总数。
        human_message_count INTEGER NOT NULL DEFAULT 0,
        -- 含 AI 正文的全部入库条数。用于分辨「零提问」与「正文没入库」。
        total_message_count INTEGER NOT NULL DEFAULT 0,
        updated_at     TEXT NOT NULL
      );

      CREATE INDEX idx_opencode_session_project
        ON opencode_session(project_key, last_updated_at);
      CREATE INDEX idx_opencode_session_updated
        ON opencode_session(last_updated_at);
    `);
    db.exec("UPDATE meta_schema SET version = 58 WHERE id = 1;");
  })();
}

/**
 * V60 —— git churn 从 `(project_key, day)` 降到**逐提交**。
 *
 * 为什么：v1 的增量写入是**累加**(`added = added + excluded.added`),同一个提交扫两次
 * 数字就翻倍 —— 所以 v1 需要 `merge-base --is-ancestor` 判祖先、rescan/incremental
 * 两路分开、删窗重扫,外加一条「重扫不双重计数」的 CRITICAL 单测来守着。
 * 换成 sha 做主键之后写入是 `INSERT OR REPLACE`,**幂等由主键保证**,那套机器不再需要。
 *
 * 主键是 `(project_key, sha)` 而**不是** `sha` —— sha 不是全局唯一的:真库里
 * `xibahe-rag` 被 clone 到两个路径,28 个 sha 同属两个 project_key。只用 sha 做主键,
 * 并发采集(`sync.ts` 的 pLimit(4))下后写的会覆盖先写的 project_key,
 * 另一个项目的产出**静默归零且永不自愈**(下轮 incremental 的 last_sha..HEAD 是空的)。
 *
 * 老数据必须搬过来,不能丢:`DEFAULT_FLOOR_DAYS = 400`,重扫只覆盖 `--since=now-400d`,
 * 真库有 32 行(最早 2024-04-23、含 12458 行产出)在 floor 之下 —— 一旦 DROP 就永久没了。
 * 所以搬成 `is_legacy=1` 的行,合成键 `'legacy:'||day`,并保留原来那天的 `commits` 数。
 *
 * 快照表不是可选的:主验收是「视图聚合与迁移前逐行相等」,DROP 之后就无从比较了。
 */
function applyV60(db: Database.Database): void {
  // 三种状态要分开,少判一种就会炸:
  //   view  → 本迁移跑过了,早退(没有它重复执行会 UNIQUE 冲突,而且第二次的
  //           INSERT...SELECT 会从新表读回自己)
  //   table → 正常升级路径,要快照 + 搬运 + DROP + 建视图
  //   都没有 → 合成旧库/裁剪过的库(测试里就有),直接建新表与视图,不搬运
  const kind = (
    db
      .prepare("SELECT type FROM sqlite_master WHERE name = 'git_line_churn'")
      .get() as { type?: string } | undefined
  )?.type;
  if (kind === "view") {
    db.exec("UPDATE meta_schema SET version = 60 WHERE id = 1;");
    return;
  }
  const hasLegacyTable = kind === "table";

  db.transaction(() => {
    db.exec(`
      CREATE TABLE git_commit_churn (
        project_key  TEXT NOT NULL,
        -- 真提交是 40 位 sha;历史遗留行是合成键 'legacy:<day>'(不会与 sha 冲突)。
        sha          TEXT NOT NULL,
        author_email TEXT NOT NULL,
        -- %aI 归一到 UTC。原始 %aI 带作者本地偏移(真库 +08:00 与 Z 混用),
        -- 而 queries 的时间边界是 toISOString();TEXT 列上混合偏移的字符串比较是错的。
        -- 遗留行只知道天、不知道时刻,填当天 00:00:00Z。
        authored_at  TEXT NOT NULL,
        -- git --date=format-local 算出的本地日历日,**原样存,永不从 authored_at 重算**
        -- (换时区会分叉)。
        day          TEXT NOT NULL,
        added        INTEGER NOT NULL DEFAULT 0,
        deleted      INTEGER NOT NULL DEFAULT 0,
        -- 真提交恒为 1;遗留行装原来那天的提交数,所以视图用 SUM 而不是 COUNT。
        commits      INTEGER NOT NULL DEFAULT 1,
        is_legacy    INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (project_key, sha)
      );
      CREATE INDEX idx_git_commit_churn_project_day ON git_commit_churn(project_key, day);
      -- queries.ts 的过滤列是 day(**不带 project_key**),v1 的 idx_git_line_churn_day
      -- 正是为它建的;少了它视图会退化成全表扫。
      CREATE INDEX idx_git_commit_churn_day ON git_commit_churn(day);
      CREATE INDEX idx_git_commit_churn_at  ON git_commit_churn(authored_at);
    `);

    if (hasLegacyTable) {
      // 快照:主验收「视图聚合与迁移前逐行相等」离了它没法执行。
      db.exec(
        "CREATE TABLE git_line_churn_v59_snapshot AS SELECT * FROM git_line_churn;"
      );

      db.exec(`
        INSERT INTO git_commit_churn
          (project_key, sha, author_email, authored_at, day, added, deleted, commits, is_legacy)
        SELECT project_key,
               'legacy:' || day,
               COALESCE((SELECT s.author_email FROM git_line_churn_state s
                          WHERE s.repo_path = git_line_churn.project_key), ''),
               day || 'T00:00:00.000Z',
               day, added, deleted, commits, 1
          FROM git_line_churn;
      `);

      // 同名 DROP TABLE + CREATE VIEW 是允许的;表上的索引随表自动消失。
      db.exec("DROP TABLE git_line_churn;");
    }
    db.exec(`
      CREATE VIEW git_line_churn AS
        SELECT project_key,
               day,
               SUM(added)   AS added,
               SUM(deleted) AS deleted,
               SUM(commits) AS commits
          FROM git_commit_churn
         GROUP BY project_key, day;
    `);
    db.exec("UPDATE meta_schema SET version = 60 WHERE id = 1;");
  })();
}

/**
 * V59 —— 两张 duration 表去掉 `source` 的 CHECK。
 *
 * `work_session_duration` 与 `work_duration_state` 的 CHECK 都只有
 * `('claude-code','codex')` —— 所以「活跃时长」那一列**从来只算两个源**,
 * opencode 与 kimi 都不在里面。排行页上它读起来像项目总时长,其实不是。
 *
 * SQLite 改不了 CHECK,只能重建。两张表都要 —— 只改一张会在首次写入另一张时炸
 * (这是对抗性复审抓到的:原计划只写了 work_session_duration)。
 *
 * 改成**不设 CHECK**,而不是把值列全:约束下沉到写入边界(`WORK_DURATION_SOURCES`),
 * 第五个源加进来时不用再动 schema。表很小(claude 216 + codex 362 = 578 行),
 * 重建是毫秒级。
 *
 * 重建的四条纪律(见 learnings `sqlite-rebuild-what-survives`):
 *   1. 显式列名,不用 `SELECT *` —— 列序错位是完全静默的
 *   2. 四个索引随表消失,必须显式重建
 *   3. 无触发器需要重建(已核对 sqlite_master)
 *   4. 整个过程包 db.transaction
 */
function applyV59(db: Database.Database): void {
  const hasCheck = (table: string): boolean => {
    const row = db
      .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?")
      .get(table) as { sql?: string } | undefined;
    return Boolean(row?.sql && /CHECK\s*\(\s*source\s+IN/i.test(row.sql));
  };
  if (!hasCheck("work_session_duration") && !hasCheck("work_duration_state")) {
    db.exec("UPDATE meta_schema SET version = 59 WHERE id = 1;");
    return;
  }
  db.transaction(() => {
    db.exec(`
      CREATE TABLE work_session_duration_new (
        source TEXT NOT NULL,
        session_id TEXT NOT NULL,
        -- 源产物的身份与变更信号。文件型源(claude/codex)填转写文件的路径/mtime/大小;
        -- 库型源(opencode)填源库路径 + session 的 time_updated + 消息条数 ——
        -- 语义都是「这个会话的原始材料变了没有」。
        transcript_path TEXT NOT NULL,
        transcript_mtime_ms INTEGER NOT NULL,
        transcript_size_bytes INTEGER NOT NULL,
        cwd TEXT NOT NULL,
        project_key TEXT NOT NULL,
        project_path TEXT NOT NULL,
        identity_confidence TEXT NOT NULL CHECK (identity_confidence IN ('high', 'low')),
        title TEXT,
        started_at TEXT,
        ended_at TEXT,
        wall_ms INTEGER NOT NULL DEFAULT 0,
        active_ms INTEGER NOT NULL DEFAULT 0,
        event_count INTEGER NOT NULL DEFAULT 0,
        idle_threshold_ms INTEGER NOT NULL,
        duration_status TEXT NOT NULL CHECK (duration_status IN ('full', 'unknown', 'error')),
        parse_error TEXT,
        missing_since TEXT,
        source_seen_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (source, session_id)
      );

      -- 显式列名。SELECT * 在列序错位时完全静默 —— 仓库吃过这个亏。
      INSERT INTO work_session_duration_new
        (source, session_id, transcript_path, transcript_mtime_ms, transcript_size_bytes,
         cwd, project_key, project_path, identity_confidence, title, started_at, ended_at,
         wall_ms, active_ms, event_count, idle_threshold_ms, duration_status, parse_error,
         missing_since, source_seen_at, updated_at)
      SELECT
         source, session_id, transcript_path, transcript_mtime_ms, transcript_size_bytes,
         cwd, project_key, project_path, identity_confidence, title, started_at, ended_at,
         wall_ms, active_ms, event_count, idle_threshold_ms, duration_status, parse_error,
         missing_since, source_seen_at, updated_at
      FROM work_session_duration;

      DROP TABLE work_session_duration;
      ALTER TABLE work_session_duration_new RENAME TO work_session_duration;

      -- 四个索引随表消失,逐个重建。
      CREATE INDEX idx_work_duration_project_ended
        ON work_session_duration(project_key, ended_at DESC);
      CREATE INDEX idx_work_duration_source_session
        ON work_session_duration(source, session_id);
      CREATE INDEX idx_work_duration_transcript
        ON work_session_duration(transcript_path);
      CREATE INDEX idx_work_duration_missing
        ON work_session_duration(missing_since);

      CREATE TABLE work_duration_state_new (
        source TEXT PRIMARY KEY,
        rule_version INTEGER NOT NULL,
        last_rebuilt_at TEXT,
        last_error TEXT,
        source_session_count INTEGER NOT NULL DEFAULT 0,
        indexed_session_count INTEGER NOT NULL DEFAULT 0,
        duration_known_session_count INTEGER NOT NULL DEFAULT 0,
        duration_unknown_session_count INTEGER NOT NULL DEFAULT 0,
        error_session_count INTEGER NOT NULL DEFAULT 0,
        skipped_unchanged_count INTEGER NOT NULL DEFAULT 0,
        duration_ms INTEGER,
        updated_at TEXT NOT NULL
      );
      INSERT INTO work_duration_state_new
        (source, rule_version, last_rebuilt_at, last_error, source_session_count,
         indexed_session_count, duration_known_session_count, duration_unknown_session_count,
         error_session_count, skipped_unchanged_count, duration_ms, updated_at)
      SELECT
         source, rule_version, last_rebuilt_at, last_error, source_session_count,
         indexed_session_count, duration_known_session_count, duration_unknown_session_count,
         error_session_count, skipped_unchanged_count, duration_ms, updated_at
      FROM work_duration_state;
      DROP TABLE work_duration_state;
      ALTER TABLE work_duration_state_new RENAME TO work_duration_state;
    `);
    db.exec("UPDATE meta_schema SET version = 59 WHERE id = 1;");
  })();
}
