/** Mirrors `/api/github/*` response shapes. Keep in sync with src/github/routes.ts. */

export type GhTokenStatus = {
  configured: boolean;
  source: "env" | "file" | null;
  configPath: string;
  envVar: "GITHUB_TOKEN";
  insecureFilePermissions: boolean;
};

export type GhSyncState = {
  last_full_sync_at: string | null;
  last_full_sync_duration_ms: number | null;
  last_full_sync_error: string | null;
  last_incremental_sync_at: string | null;
  last_incremental_sync_duration_ms: number | null;
  last_incremental_sync_error: string | null;
  last_repos_updated_at: string | null;
  last_starred_at: string | null;
  in_progress: boolean;
};

export type GhStatusRes = {
  token: GhTokenStatus;
  sync: GhSyncState;
  counts: { repos: number; stars: number };
};

export type GhRepo = {
  id: number;
  owner: string;
  name: string;
  full_name: string;
  description: string | null;
  private: boolean;
  fork: boolean;
  archived: boolean;
  default_branch: string | null;
  html_url: string;
  clone_url: string | null;
  language: string | null;
  topics: string[];
  stargazers_count: number;
  forks_count: number;
  open_issues_count: number;
  size_kb: number;
  created_at: string;
  updated_at: string;
  pushed_at: string | null;
  commit_count: number | null;
  commit_count_error: string | null;
  commit_count_checked_at: string | null;
};

export type GhStar = {
  repo_id: number;
  owner: string;
  name: string;
  full_name: string;
  description: string | null;
  html_url: string;
  language: string | null;
  topics: string[];
  stargazers_count: number;
  starred_at: string;
};

export type GhReposRes = {
  items: GhRepo[];
  next_cursor: number | null;
};

export type GhStarsRes = {
  items: GhStar[];
  next_cursor: string | null;
};

export type GhHeatmapBucket = {
  day: string;
  repo_count: number;
  star_count: number;
};

export type GhHeatmapRes = {
  buckets: GhHeatmapBucket[];
};

// ---------- Tag pivot (V1 — stars only) ----------

export type GhTopTag = {
  tag: string;
  count: number;
  last_starred_at: string | null;
};

export type GhTopTagsRes = {
  items: GhTopTag[];
};

export type GhTagHeatmapRes = {
  /** Time buckets, ascending: e.g. ['2024-01', '2024-02', …] */
  xs: string[];
  /** Tags, sorted by total count desc. */
  ys: string[];
  /** cells[i][j] = count for tag ys[i] in bucket xs[j]. */
  cells: number[][];
};

export type GhTaggedRepo = {
  repo_id: number;
  owner: string;
  name: string;
  full_name: string;
  description: string | null;
  html_url: string;
  language: string | null;
  topics: string[];
  stargazers_count: number;
  starred_at: string;
  matched_tags: string[];
};

export type GhTaggedReposRes = {
  items: GhTaggedRepo[];
  next_cursor: string | null;
};

export type GhTagAlias = {
  from_tag: string;
  to_tag: string;
  source: "preset" | "user";
  note: string | null;
  created_at: string;
};

export type GhTagAliasesRes = {
  items: GhTagAlias[];
};

export type TagFilterMode = "or" | "and";
export type TagHeatmapGrain = "month" | "quarter" | "year";
