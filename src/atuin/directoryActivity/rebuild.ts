import type Database from "better-sqlite3";
import {
  readDirectoryActivityConfig,
} from "./config.js";
import { includeInFilteredDirectoryActivity } from "./filters.js";
import {
  ATUIN_DIRECTORY_ACTIVITY_RULE_VERSION,
  type DirectoryActivityErrorCode,
  type RebuildDirectoryActivityResult,
} from "./types.js";

type SourceRow = {
  timestamp_ns: number;
  duration: number;
  exit: number;
  command: string;
  cwd: string;
};

type DirAgg = {
  cwd: string;
  rawCommandCount: number;
  filteredCommandCount: number;
  rawFailedCount: number;
  filteredFailedCount: number;
  firstTimestampNs: number | null;
  lastTimestampNs: number | null;
  lastExit: number | null;
};

type CommandAgg = DirAgg & {
  command: string;
};

let rebuildInProgress = false;

function nowIso(): string {
  return new Date().toISOString();
}

function durationMs(started: number): number {
  return Date.now() - started;
}

function failureResult(
  started: number,
  errorCode: DirectoryActivityErrorCode,
  error: string,
  filterConfigHash: string | null,
  counts?: {
    sourceEntryCount?: number;
    derivedDirectoryCount?: number;
    derivedCommandCount?: number;
  }
): RebuildDirectoryActivityResult {
  return {
    ok: false,
    errorCode,
    error,
    ruleVersion: ATUIN_DIRECTORY_ACTIVITY_RULE_VERSION,
    filterConfigHash,
    sourceEntryCount: counts?.sourceEntryCount ?? 0,
    derivedDirectoryCount: counts?.derivedDirectoryCount ?? 0,
    derivedCommandCount: counts?.derivedCommandCount ?? 0,
    durationMs: durationMs(started),
  };
}

function upsertState(
  indexDb: Database.Database,
  values: {
    filterConfigHash: string;
    rebuiltAt: string | null;
    error: string | null;
    errorCode: DirectoryActivityErrorCode | null;
    sourceEntryCount: number;
    derivedDirectoryCount: number;
    derivedCommandCount: number;
    durationMs: number | null;
    updatedAt: string;
  }
): void {
  indexDb
    .prepare(
      `INSERT INTO atuin_directory_activity_state (
        id, rule_version, filter_config_hash, last_rebuilt_at, last_error,
        error_code, source_entry_count, derived_directory_count,
        derived_command_count, last_rebuild_duration_ms, updated_at
      ) VALUES (
        1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      )
      ON CONFLICT(id) DO UPDATE SET
        rule_version = excluded.rule_version,
        filter_config_hash = excluded.filter_config_hash,
        last_rebuilt_at = excluded.last_rebuilt_at,
        last_error = excluded.last_error,
        error_code = excluded.error_code,
        source_entry_count = excluded.source_entry_count,
        derived_directory_count = excluded.derived_directory_count,
        derived_command_count = excluded.derived_command_count,
        last_rebuild_duration_ms = excluded.last_rebuild_duration_ms,
        updated_at = excluded.updated_at`
    )
    .run(
      ATUIN_DIRECTORY_ACTIVITY_RULE_VERSION,
      values.filterConfigHash,
      values.rebuiltAt,
      values.error,
      values.errorCode,
      values.sourceEntryCount,
      values.derivedDirectoryCount,
      values.derivedCommandCount,
      values.durationMs,
      values.updatedAt
    );
}

function currentDerivedCounts(indexDb: Database.Database): {
  directories: number;
  commands: number;
} {
  const dirs = indexDb
    .prepare("SELECT COUNT(*) AS c FROM atuin_directory_activity_dirs")
    .get() as { c: number };
  const commands = indexDb
    .prepare("SELECT COUNT(*) AS c FROM atuin_directory_activity_commands")
    .get() as { c: number };
  return { directories: dirs.c, commands: commands.c };
}

function recordFailureState(
  indexDb: Database.Database,
  started: number,
  errorCode: DirectoryActivityErrorCode,
  error: string,
  filterConfigHash: string
): void {
  let counts = { directories: 0, commands: 0 };
  try {
    counts = currentDerivedCounts(indexDb);
  } catch {
    counts = { directories: 0, commands: 0 };
  }
  upsertState(indexDb, {
    filterConfigHash,
    rebuiltAt: null,
    error,
    errorCode,
    sourceEntryCount: 0,
    derivedDirectoryCount: counts.directories,
    derivedCommandCount: counts.commands,
    durationMs: durationMs(started),
    updatedAt: nowIso(),
  });
}

function validateAtuinHistorySchema(atuinDb: Database.Database): void {
  const table = atuinDb
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'history'")
    .get() as { name: string } | undefined;
  if (!table) throw new Error("Atuin history table not found");
  const rows = atuinDb.prepare("PRAGMA table_info(history)").all() as {
    name: string;
  }[];
  const names = new Set(rows.map((row) => row.name));
  const required = [
    "id",
    "timestamp",
    "duration",
    "exit",
    "command",
    "cwd",
    "session",
    "hostname",
    "deleted_at",
  ];
  const missing = required.filter((name) => !names.has(name));
  if (missing.length > 0) {
    throw new Error(`Atuin history schema missing column(s): ${missing.join(", ")}`);
  }
}

function bumpDir(agg: DirAgg, row: SourceRow, includeFiltered: boolean): void {
  agg.rawCommandCount += 1;
  if (row.exit !== 0) agg.rawFailedCount += 1;
  if (includeFiltered) {
    agg.filteredCommandCount += 1;
    if (row.exit !== 0) agg.filteredFailedCount += 1;
  }
  if (agg.firstTimestampNs == null || row.timestamp_ns < agg.firstTimestampNs) {
    agg.firstTimestampNs = row.timestamp_ns;
  }
  if (agg.lastTimestampNs == null || row.timestamp_ns >= agg.lastTimestampNs) {
    agg.lastTimestampNs = row.timestamp_ns;
    agg.lastExit = row.exit;
  }
}

function newDirAgg(cwd: string): DirAgg {
  return {
    cwd,
    rawCommandCount: 0,
    filteredCommandCount: 0,
    rawFailedCount: 0,
    filteredFailedCount: 0,
    firstTimestampNs: null,
    lastTimestampNs: null,
    lastExit: null,
  };
}

function newCommandAgg(cwd: string, command: string): CommandAgg {
  return { ...newDirAgg(cwd), command };
}

function commandKey(cwd: string, command: string): string {
  return `${cwd}\0${command}`;
}

export function __resetDirectoryActivityRebuildLockForTests(): void {
  rebuildInProgress = false;
}

export function rebuildDirectoryActivity(args: {
  indexDb: Database.Database;
  atuinDb: Database.Database;
  configPath?: string;
}): RebuildDirectoryActivityResult {
  const started = Date.now();
  if (rebuildInProgress) {
    return failureResult(
      started,
      "rebuild_in_progress",
      "Atuin directory activity rebuild is already running",
      null
    );
  }
  rebuildInProgress = true;
  try {
    const config = readDirectoryActivityConfig(args.configPath);
    if (!config.ok) {
      const message = config.issues.map((i) => `${i.path}: ${i.message}`).join("; ");
      return failureResult(started, "config_error", message, null);
    }
    const filterConfigHash = config.hash;
    try {
      validateAtuinHistorySchema(args.atuinDb);
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      recordFailureState(args.indexDb, started, "schema_mismatch", error, filterConfigHash);
      return failureResult(started, "schema_mismatch", error, filterConfigHash);
    }

    const dirs = new Map<string, DirAgg>();
    const commands = new Map<string, CommandAgg>();
    let sourceEntryCount = 0;

    const rows = args.atuinDb
      .prepare(
        `SELECT timestamp AS timestamp_ns, duration, exit, command, cwd
         FROM history
         WHERE deleted_at IS NULL
         ORDER BY timestamp ASC`
      )
      .iterate() as Iterable<SourceRow>;
    for (const row of rows) {
      sourceEntryCount += 1;
      const cwd = row.cwd || "(unknown)";
      const command = row.command.trim();
      const includeFiltered = includeInFilteredDirectoryActivity(command, config.config);
      let dir = dirs.get(cwd);
      if (!dir) {
        dir = newDirAgg(cwd);
        dirs.set(cwd, dir);
      }
      bumpDir(dir, row, includeFiltered);
      const key = commandKey(cwd, command);
      let cmd = commands.get(key);
      if (!cmd) {
        cmd = newCommandAgg(cwd, command);
        commands.set(key, cmd);
      }
      bumpDir(cmd, row, includeFiltered);
    }

    const updatedAt = nowIso();
    const write = args.indexDb.transaction(() => {
      args.indexDb.prepare("DELETE FROM atuin_directory_activity_commands").run();
      args.indexDb.prepare("DELETE FROM atuin_directory_activity_dirs").run();
      const insertDir = args.indexDb.prepare(
        `INSERT INTO atuin_directory_activity_dirs (
          cwd, raw_command_count, filtered_command_count, raw_failed_count,
          filtered_failed_count, first_timestamp_ns, last_timestamp_ns, last_exit, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      for (const dir of dirs.values()) {
        insertDir.run(
          dir.cwd,
          dir.rawCommandCount,
          dir.filteredCommandCount,
          dir.rawFailedCount,
          dir.filteredFailedCount,
          dir.firstTimestampNs,
          dir.lastTimestampNs,
          dir.lastExit,
          updatedAt
        );
      }
      const insertCommand = args.indexDb.prepare(
        `INSERT INTO atuin_directory_activity_commands (
          cwd, command, raw_count, filtered_count, raw_failed_count,
          filtered_failed_count, first_timestamp_ns, last_timestamp_ns, last_exit, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      for (const command of commands.values()) {
        insertCommand.run(
          command.cwd,
          command.command,
          command.rawCommandCount,
          command.filteredCommandCount,
          command.rawFailedCount,
          command.filteredFailedCount,
          command.firstTimestampNs,
          command.lastTimestampNs,
          command.lastExit,
          updatedAt
        );
      }
      upsertState(args.indexDb, {
        filterConfigHash,
        rebuiltAt: updatedAt,
        error: null,
        errorCode: null,
        sourceEntryCount,
        derivedDirectoryCount: dirs.size,
        derivedCommandCount: commands.size,
        durationMs: durationMs(started),
        updatedAt,
      });
    });

    try {
      write();
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      recordFailureState(args.indexDb, started, "rebuild_failed", error, filterConfigHash);
      return failureResult(started, "rebuild_failed", error, filterConfigHash, {
        sourceEntryCount,
      });
    }

    return {
      ok: true,
      errorCode: null,
      error: null,
      ruleVersion: ATUIN_DIRECTORY_ACTIVITY_RULE_VERSION,
      filterConfigHash,
      sourceEntryCount,
      derivedDirectoryCount: dirs.size,
      derivedCommandCount: commands.size,
      durationMs: durationMs(started),
    };
  } finally {
    rebuildInProgress = false;
  }
}
