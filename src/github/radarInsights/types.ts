export const RADAR_INSIGHT_KINDS = [
  "recommended_now",
  "rediscovered",
  "retire_candidate",
  "taste_profile",
] as const;

export type RadarInsightKind = (typeof RADAR_INSIGHT_KINDS)[number];

export const RADAR_INSIGHT_HEALTH = [
  "strong",
  "partial",
  "weak",
  "stale",
  "suppressed",
] as const;

export type RadarInsightHealth = (typeof RADAR_INSIGHT_HEALTH)[number];

export const RADAR_INSIGHT_FEEDBACK = [
  "useful",
  "wrong",
  "later",
  "ignore",
] as const;

export type RadarInsightFeedback = (typeof RADAR_INSIGHT_FEEDBACK)[number];

export const RADAR_INSIGHT_META_STATUSES = [
  "fresh",
  "stale",
  "partial",
  "empty",
  "error",
] as const;

export type RadarInsightMetaStatus = (typeof RADAR_INSIGHT_META_STATUSES)[number];

export const RADAR_INSIGHT_REFRESH_ERRORS = [
  "no_stars",
  "current_work_scan_failed",
  "todos_read_failed",
  "docs_scan_failed",
  "git_log_failed",
  "no_indexed_projects",
  "project_context_empty",
  "project_context_skipped",
  "snapshot_write_failed",
  "snapshot_parse_failed",
] as const;

export type RadarInsightRefreshError =
  (typeof RADAR_INSIGHT_REFRESH_ERRORS)[number];

export type RadarInsightWarning = {
  code: RadarInsightRefreshError | "docs_skipped";
  message: string;
};

export type RadarEvidenceSourceKind =
  | "todo"
  | "doc"
  | "git_commit"
  | "branch"
  | "repo_fact"
  | "topic"
  | "feedback";

export type RadarInsightEvidence = {
  source_kind: RadarEvidenceSourceKind;
  label: string;
  source_path: string | null;
  matched_terms: string[];
  weight: number;
};

export type RadarInsight = {
  id: number | null;
  fingerprint: string;
  kind: RadarInsightKind;
  title: string;
  summary: string;
  health: RadarInsightHealth;
  health_reason: string;
  score: number;
  repo_ids: number[];
  terms: string[];
  evidence: RadarInsightEvidence[];
};

export type RadarInsightSnapshotMetrics = {
  duration_ms: number;
  stars_scanned: number;
  docs_scanned: number;
  docs_skipped: number;
  candidate_count: number;
  insight_count: number;
};

export type RadarInsightSourceFingerprint = {
  stars_count: number;
  max_starred_at: string | null;
  max_star_pushed_at: string | null;
  project_context_hash: string | null;
  git_context_hash: string | null;
  feedback_hash: string | null;
  version: "2026-05-04.1";
};

export type RadarInsightSnapshot = {
  id: number;
  generated_at: string;
  status: RadarInsightMetaStatus;
  source_fingerprint: RadarInsightSourceFingerprint;
  error_code: RadarInsightRefreshError | null;
  warnings: RadarInsightWarning[];
  metrics: RadarInsightSnapshotMetrics;
  insights: RadarInsight[];
};

export type RadarInsightsResponse = {
  meta: {
    status: RadarInsightMetaStatus;
    generated_at: string | null;
    error_code: RadarInsightRefreshError | null;
    warnings: RadarInsightWarning[];
    metrics: RadarInsightSnapshotMetrics | null;
  };
  current_clues: RadarInsight[];
  rediscovered: RadarInsight[];
  retire_candidates: RadarInsight[];
  taste_profile: RadarInsight | null;
  legacy_available: boolean;
};

export type RadarInsightRefreshResult =
  | {
      ok: true;
      status: "fresh" | "partial" | "empty";
      snapshot: RadarInsightSnapshot;
      warnings: RadarInsightWarning[];
    }
  | {
      ok: false;
      status: "error" | "refresh_in_progress";
      error: RadarInsightRefreshError | "refresh_in_progress";
      previousSnapshot: RadarInsightSnapshot | null;
      warnings: RadarInsightWarning[];
    };

export type RadarFeedbackInput = {
  target_type: "insight" | "repo";
  target_id: string;
  feedback: RadarInsightFeedback;
  insight_fingerprint?: string | null;
  repo_id?: number | null;
  terms?: string[];
};

export function isRadarInsightFeedback(v: unknown): v is RadarInsightFeedback {
  return (
    typeof v === "string" &&
    RADAR_INSIGHT_FEEDBACK.includes(v as RadarInsightFeedback)
  );
}
