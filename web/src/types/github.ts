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
  archived: boolean;
  pushed_at: string | null;
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

// ---------- Open-source radar (local-only notes + derived signals) ----------

export type GhStarNoteStatus =
  | "new"
  | "reviewed"
  | "try_next"
  | "ignore"
  | "retired";

export type GhRadarSignal =
  | "archived"
  | "stale"
  | "needs_review"
  | "missing_reason"
  | "recently_starred"
  | "active_recently";

export type GhStarNote = {
  repo_id: number;
  reason: string;
  status: GhStarNoteStatus;
  last_reviewed_at: string | null;
  source: "user";
  created_at: string;
  updated_at: string;
};

export type GhRadarRepo = GhStar & {
  note: GhStarNote | null;
  effective_status: GhStarNoteStatus;
  signals: GhRadarSignal[];
};

export type GhRadarCluster = {
  tag: string;
  count: number;
  missing_reason_count: number;
  needs_review_count: number;
  stale_count: number;
  last_starred_at: string | null;
};

export type GhRadarOverviewRes = {
  generated_at: string;
  thresholds: {
    stale_before: string;
    needs_review_before: string;
    recently_starred_since: string;
    active_recently_since: string;
  };
  counts: {
    total_stars: number;
    missing_reason: number;
    needs_review: number;
    stale: number;
    archived: number;
    recently_starred: number;
    active_recently: number;
    try_next: number;
  };
  clusters: GhRadarCluster[];
  language_only: GhRadarCluster[];
  queues: {
    missing_reason: GhRadarRepo[];
    needs_review: GhRadarRepo[];
    stale: GhRadarRepo[];
    try_next: GhRadarRepo[];
    recently_starred: GhRadarRepo[];
  };
};

export type GhStarNoteRes = {
  note: GhStarNote;
};

// ---------- Open-source radar insights ----------

export type GhRadarInsightKind =
  | "recommended_now"
  | "rediscovered"
  | "retire_candidate"
  | "taste_profile";

export type GhRadarInsightHealth =
  | "strong"
  | "partial"
  | "weak"
  | "stale"
  | "suppressed";

export type GhRadarInsightStatus =
  | "fresh"
  | "stale"
  | "partial"
  | "empty"
  | "error";

export type GhRadarInsightFeedback =
  | "useful"
  | "wrong"
  | "later"
  | "ignore";

export type GhRadarInsightEvidence = {
  source_kind:
    | "todo"
    | "doc"
    | "git_commit"
    | "branch"
    | "repo_fact"
    | "topic"
    | "feedback";
  label: string;
  source_path: string | null;
  matched_terms: string[];
  weight: number;
};

export type GhRadarInsight = {
  id: number | null;
  fingerprint: string;
  kind: GhRadarInsightKind;
  title: string;
  summary: string;
  health: GhRadarInsightHealth;
  health_reason: string;
  score: number;
  repo_ids: number[];
  terms: string[];
  evidence: GhRadarInsightEvidence[];
};

export type GhRadarInsightWarning = {
  code: string;
  message: string;
};

export type GhRadarInsightsRes = {
  meta: {
    status: GhRadarInsightStatus;
    generated_at: string | null;
    error_code: string | null;
    warnings: GhRadarInsightWarning[];
    metrics: {
      duration_ms: number;
      stars_scanned: number;
      docs_scanned: number;
      docs_skipped: number;
      candidate_count: number;
      insight_count: number;
    } | null;
  };
  current_clues: GhRadarInsight[];
  rediscovered: GhRadarInsight[];
  retire_candidates: GhRadarInsight[];
  taste_profile: GhRadarInsight | null;
  legacy_available: boolean;
};

export type GhRadarInsightRefreshRes =
  | {
      ok: true;
      status: "fresh" | "partial" | "empty";
      snapshot: unknown;
      warnings: GhRadarInsightWarning[];
    }
  | {
      ok: false;
      status: "error" | "refresh_in_progress";
      error: string;
      warnings: GhRadarInsightWarning[];
      previousSnapshot: unknown;
    };

export type GhRadarInsightFeedbackRes = {
  ok: true;
};
