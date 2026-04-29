import type Database from "better-sqlite3";
import { readDirectoryActivityConfig } from "./config.js";
import {
  ATUIN_DIRECTORY_ACTIVITY_RULE_VERSION,
  type DirectoryActivityCommandRow,
  type DirectoryActivityDirectoryRow,
  type DirectoryActivityMode,
  type DirectoryActivityStateRow,
  type DirectoryActivityStatus,
} from "./types.js";

function countRows(db: Database.Database, table: string): number {
  const row = db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number };
  return row.c;
}

function clampLimit(limit: number, max = 200): number {
  return Math.min(max, Math.max(1, Math.floor(limit) || 50));
}

function countColumn(mode: DirectoryActivityMode): "raw_command_count" | "filtered_command_count" {
  return mode === "raw" ? "raw_command_count" : "filtered_command_count";
}

function commandCountColumn(mode: DirectoryActivityMode): "raw_count" | "filtered_count" {
  return mode === "raw" ? "raw_count" : "filtered_count";
}

export function getDirectoryActivityState(
  db: Database.Database
): DirectoryActivityStateRow | null {
  const row = db
    .prepare(
      `SELECT id, rule_version, filter_config_hash, last_rebuilt_at, last_error,
              error_code, source_entry_count, derived_directory_count,
              derived_command_count, last_rebuild_duration_ms, updated_at
       FROM atuin_directory_activity_state
       WHERE id = 1`
    )
    .get() as DirectoryActivityStateRow | undefined;
  return row ?? null;
}

export function getDirectoryActivityStatus(
  db: Database.Database,
  configPath?: string
): DirectoryActivityStatus {
  const config = readDirectoryActivityConfig(configPath);
  const state = getDirectoryActivityState(db);
  const currentDerivedDirectoryCount = countRows(db, "atuin_directory_activity_dirs");
  const currentDerivedCommandCount = countRows(db, "atuin_directory_activity_commands");
  const staleReasons: string[] = [];
  if (!state) staleReasons.push("not_built");
  if (state && state.rule_version !== ATUIN_DIRECTORY_ACTIVITY_RULE_VERSION) {
    staleReasons.push("rule_version_mismatch");
  }
  if (!config.ok) staleReasons.push("config_error");
  if (state && config.ok && state.filter_config_hash !== config.hash) {
    staleReasons.push("filter_config_changed");
  }
  if (state?.last_error) staleReasons.push("last_rebuild_error");
  if (state && state.derived_directory_count !== currentDerivedDirectoryCount) {
    staleReasons.push("derived_directory_count_changed");
  }
  if (state && state.derived_command_count !== currentDerivedCommandCount) {
    staleReasons.push("derived_command_count_changed");
  }
  return {
    ruleVersion: ATUIN_DIRECTORY_ACTIVITY_RULE_VERSION,
    configPath: config.path,
    configOk: config.ok,
    configIssues: config.ok ? [] : config.issues,
    filterConfigHash: config.ok ? config.hash : null,
    state,
    currentDerivedDirectoryCount,
    currentDerivedCommandCount,
    fresh: staleReasons.length === 0,
    staleReasons,
  };
}

export function listTopDirectoryActivityDirs(
  db: Database.Database,
  args?: { mode?: DirectoryActivityMode; limit?: number }
): DirectoryActivityDirectoryRow[] {
  const mode = args?.mode ?? "filtered";
  const col = countColumn(mode);
  return db
    .prepare(
      `SELECT cwd, raw_command_count, filtered_command_count, raw_failed_count,
              filtered_failed_count, first_timestamp_ns, last_timestamp_ns, last_exit,
              updated_at
       FROM atuin_directory_activity_dirs
       ORDER BY ${col} DESC, last_timestamp_ns DESC, cwd ASC
       LIMIT ?`
    )
    .all(clampLimit(args?.limit ?? 50)) as DirectoryActivityDirectoryRow[];
}

export function searchDirectoryActivityDirs(
  db: Database.Database,
  args: { q: string; mode?: DirectoryActivityMode; limit?: number }
): DirectoryActivityDirectoryRow[] {
  const q = args.q.trim();
  if (!q) return [];
  const mode = args.mode ?? "filtered";
  const col = countColumn(mode);
  return db
    .prepare(
      `SELECT cwd, raw_command_count, filtered_command_count, raw_failed_count,
              filtered_failed_count, first_timestamp_ns, last_timestamp_ns, last_exit,
              updated_at
       FROM atuin_directory_activity_dirs
       WHERE cwd LIKE ? ESCAPE '\\'
       ORDER BY ${col} DESC, last_timestamp_ns DESC, cwd ASC
       LIMIT ?`
    )
    .all(`%${escapeLike(q)}%`, clampLimit(args.limit ?? 50)) as DirectoryActivityDirectoryRow[];
}

export function listDirectoryActivityCommands(
  db: Database.Database,
  args: { cwd: string; mode?: DirectoryActivityMode; limit?: number }
): DirectoryActivityCommandRow[] {
  const mode = args.mode ?? "filtered";
  const col = commandCountColumn(mode);
  return db
    .prepare(
      `SELECT cwd, command, raw_count, filtered_count, raw_failed_count,
              filtered_failed_count, first_timestamp_ns, last_timestamp_ns, last_exit,
              updated_at
       FROM atuin_directory_activity_commands
       WHERE cwd = ?
       ORDER BY ${col} DESC, last_timestamp_ns DESC, command ASC
       LIMIT ?`
    )
    .all(args.cwd, clampLimit(args.limit ?? 100)) as DirectoryActivityCommandRow[];
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}
