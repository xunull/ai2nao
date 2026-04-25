export type VscodeAppId = "code" | "code-insiders" | "vscodium" | "cursor";

export type VscodeRecentKind = "folder" | "file" | "workspace";

export type VscodeWarningCode =
  | "source_missing"
  | "key_missing"
  | "entry_unknown_shape"
  | "repo_association_failed"
  | "remote_redacted";

export type VscodeWarning = {
  code: VscodeWarningCode;
  message: string;
  context?: Record<string, string | number | boolean | null>;
};

export type ParsedVscodeRecentEntry = {
  kind: VscodeRecentKind;
  recentIndex: number;
  uriRedacted: string;
  path: string | null;
  label: string | null;
  remoteType: string | null;
  remoteAuthorityHash: string | null;
  remotePathHash: string | null;
};

export type VscodeRecentRow = {
  id: number;
  app: VscodeAppId;
  profile: string;
  kind: VscodeRecentKind;
  recent_index: number;
  uri_redacted: string;
  path: string | null;
  label: string | null;
  remote_type: string | null;
  remote_authority_hash: string | null;
  remote_path_hash: string | null;
  exists_on_disk: number | null;
  first_seen_at: string;
  last_seen_at: string;
  missing_since: string | null;
  updated_at: string;
};

export type VscodeRepoSummary = {
  id: number;
  path_canonical: string;
  origin_url: string | null;
};

export type VscodeRecentProject = {
  key: string;
  label: string;
  path: string | null;
  repo: VscodeRepoSummary | null;
  entryCount: number;
  latestRecentIndex: number;
  kind: VscodeRecentKind;
  remoteType: string | null;
  remoteAuthorityHash: string | null;
  missing: boolean;
  app: VscodeAppId;
  profile: string;
};
