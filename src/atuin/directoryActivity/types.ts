export const ATUIN_DIRECTORY_ACTIVITY_RULE_VERSION = 1;

export type DirectoryActivityFilterRuleKind = "literal" | "prefix" | "exact";

export type DirectoryActivityFilterRule = {
  kind: DirectoryActivityFilterRuleKind;
  value: string;
};

export type DirectoryActivityConfig = {
  includeLowInfoCommands: boolean;
  lowInfoCommands: DirectoryActivityFilterRule[];
};

export type DirectoryActivityConfigIssue = {
  path: string;
  message: string;
};

export type DirectoryActivityConfigResult =
  | {
      ok: true;
      path: string;
      exists: boolean;
      config: DirectoryActivityConfig;
      hash: string;
    }
  | {
      ok: false;
      path: string;
      issues: DirectoryActivityConfigIssue[];
    };

export type DirectoryActivityMode = "raw" | "filtered";

export type DirectoryActivityErrorCode =
  | "not_configured"
  | "db_unavailable"
  | "schema_mismatch"
  | "config_error"
  | "rebuild_failed"
  | "rebuild_in_progress";

export type DirectoryActivityStateRow = {
  id: number;
  rule_version: number;
  filter_config_hash: string;
  last_rebuilt_at: string | null;
  last_error: string | null;
  error_code: DirectoryActivityErrorCode | null;
  source_entry_count: number;
  derived_directory_count: number;
  derived_command_count: number;
  last_rebuild_duration_ms: number | null;
  updated_at: string;
};

export type DirectoryActivityStatus = {
  ruleVersion: number;
  configPath: string;
  configOk: boolean;
  configIssues: DirectoryActivityConfigIssue[];
  filterConfigHash: string | null;
  state: DirectoryActivityStateRow | null;
  currentDerivedDirectoryCount: number;
  currentDerivedCommandCount: number;
  fresh: boolean;
  staleReasons: string[];
};

export type DirectoryActivityDirectoryRow = {
  cwd: string;
  raw_command_count: number;
  filtered_command_count: number;
  raw_failed_count: number;
  filtered_failed_count: number;
  first_timestamp_ns: number | null;
  last_timestamp_ns: number | null;
  last_exit: number | null;
  updated_at: string;
};

export type DirectoryActivityCommandRow = {
  cwd: string;
  command: string;
  raw_count: number;
  filtered_count: number;
  raw_failed_count: number;
  filtered_failed_count: number;
  first_timestamp_ns: number | null;
  last_timestamp_ns: number | null;
  last_exit: number | null;
  updated_at: string;
};

export type RebuildDirectoryActivityResult = {
  ok: boolean;
  errorCode: DirectoryActivityErrorCode | null;
  error: string | null;
  ruleVersion: number;
  filterConfigHash: string | null;
  sourceEntryCount: number;
  derivedDirectoryCount: number;
  derivedCommandCount: number;
  durationMs: number;
};
