/**
 * Commit-based work recap: given the user's git commits across all locally
 * indexed `repos` over a fixed window, produce a fact layer + an LLM-inferred
 * narrative layer + workMode classification + nextUp guidance.
 *
 *   button -> POST /api/work-recap/generate?window=7d
 *               |
 *               +-- scanCommits   --> WorkRecapFacts (deterministic)
 *               +-- buildPrompt   --> redacted prompt within token budget
 *               +-- callLlm       --> WorkRecapInference (LLM)
 *               +-- insertRecap   --> work_recap_runs row
 *               +-- cleanupRetention(window, 200)
 *
 * Facts layer is the source of truth. Inference layer is best-effort and may
 * degrade (sparse signal, LLM timeout, malformed JSON). UI never blends them.
 */

export const WORK_RECAP_WINDOWS = [
  "1d",
  "3d",
  "7d",
  "14d",
  "30d",
] as const;

export type WorkRecapWindow = (typeof WORK_RECAP_WINDOWS)[number];

export type WorkRecapWorkMode =
  | "build"
  | "debug"
  | "explore"
  | "fragmented"
  | "low_signal";

export type WorkRecapFragmentation = "low" | "med" | "high";

/**
 * Reason codes for degradation. Two layers:
 *   - inference-layer: LLM-side problems → set inference.degraded=true
 *   - facts-layer: scan-side truncations → set facts.scanTruncated=true
 *
 * Display rule: inference degrade replaces the summary card; facts degrade
 * shows a small corner badge on the facts card.
 */
export type WorkRecapDegradeReason =
  | "sparse_signal"
  | "llm_timeout"
  | "llm_malformed"
  | "llm_empty"
  | "llm_unavailable"
  | "text_fact_conflict"
  | "scan_timeout"
  | "prompt_budget_exceeded";

export type WorkRecapCommitTypeKind =
  | "feat"
  | "fix"
  | "refactor"
  | "docs"
  | "chore"
  | "test"
  | "style"
  | "perf"
  | "build"
  | "ci"
  | "revert"
  | "other";

export const COMMIT_TYPE_KINDS: WorkRecapCommitTypeKind[] = [
  "feat",
  "fix",
  "refactor",
  "docs",
  "chore",
  "test",
  "style",
  "perf",
  "build",
  "ci",
  "revert",
  "other",
];

export type WorkRecapProjectShare = {
  projectKey: string;
  projectLabel: string;
  commitCount: number;
  share: number; // 0..1
};

export type WorkRecapDailyBucket = {
  /** Local YYYY-MM-DD calendar date (resolver's local time zone). */
  date: string;
  commitCount: number;
};

/** Degrade state of a v2 multi-source fact group (distinct from a bare null). */
export type WorkRecapFactStatus = "ok" | "absent" | "empty" | "error";

export type WorkRecapFactGroup<T> = {
  status: WorkRecapFactStatus;
  data?: T;
  /** Present only when status = "error". */
  message?: string;
};

/** Token/cost facts for the window (headline-caliber tokens + priced cost + coverage). */
export type WorkRecapTokenFacts = {
  costUsd: number;
  coverage: "full" | "partial" | "unknown";
  unpricedTokenCount: number;
  priceSnapshotDate: string;
  /** input+output headline tokens (cache / reasoning excluded). */
  headlineTokens: number;
  dominantProvider: "claude" | "codex" | "minimax" | "none";
  claudeShare: number;
  codexShare: number;
};

export type WorkRecapTopicShare = { name: string; count: number; share: number };

export type WorkRecapTopicSourceTop = {
  source: "chrome" | "git" | "conversation";
  events: number;
  top: WorkRecapTopicShare[];
};

export type WorkRecapTopicDriftItem = {
  source: "chrome" | "git" | "conversation";
  from: string;
  to: string;
};

/** Top topics per source (the reliable narrative spine) + optional gated drift. */
export type WorkRecapTopicFacts = {
  bySource: WorkRecapTopicSourceTop[];
  /** null when no source cleared the volume/bucket threshold (weekly grain is noisy). */
  drift: WorkRecapTopicDriftItem[] | null;
};

export type WorkRecapFacts = {
  windowKey: WorkRecapWindow;
  windowStart: string; // ISO
  windowEnd: string; // ISO
  authorEmail: string;
  totalCommits: number;
  projectCount: number;
  projectShare: WorkRecapProjectShare[];
  commitTypeCounts: Record<WorkRecapCommitTypeKind, number>;
  dailyCounts: WorkRecapDailyBucket[];
  reposScanned: number;
  reposTotal: number;
  /** True when scan was cut by 10s hard timeout OR prompt budget. */
  scanTruncated: boolean;
  /** Reason for scanTruncated (facts-layer); null if not truncated. */
  scanTruncatedReason: WorkRecapDegradeReason | null;
  /** Per-repo errors encountered during scan. */
  diagnostics: WorkRecapDiagnostic[];
  /** v2 multi-source: token/cost facts (status-gated, degrades independently). */
  tokenFacts: WorkRecapFactGroup<WorkRecapTokenFacts>;
  /** v2 multi-source: per-source top topics + gated drift (status-gated). */
  topicDrift: WorkRecapFactGroup<WorkRecapTopicFacts>;
};

export type WorkRecapDiagnostic = {
  severity: "info" | "warning" | "error";
  kind: string;
  message: string;
  repo?: string;
};

export type WorkRecapInference = {
  /** Chinese narrative paragraph, <= 400 chars. */
  summary: string;
  workMode: WorkRecapWorkMode;
  /** <=80 char one-liner explaining the workMode pick. */
  workModeReason: string;
  /** 1-2 short lines guiding tomorrow's pickup. */
  nextUp: string[];
  fragmentation: WorkRecapFragmentation;
  /** True only when inference layer degraded; facts-layer degrade lives in facts.scanTruncated. */
  degraded: boolean;
  degradeReason: WorkRecapDegradeReason | null;
};

/** Persisted recap snapshot (one row in work_recap_runs). */
export type WorkRecapRun = {
  id: number;
  windowKey: WorkRecapWindow;
  generatedAt: Date;
  model: string;
  promptVersion: string;
  facts: WorkRecapFacts;
  inference: WorkRecapInference;
};

/** Response envelope for empty-repos shortcut (no LLM call, no DB write). */
export type WorkRecapEmptyResponse = {
  ok: true;
  empty: true;
  reason: "no_repos_indexed";
};

/** Response envelope for in-flight collision. */
export type WorkRecapInflightResponse = {
  ok: false;
  inflight: true;
  windowKey: WorkRecapWindow;
  startedAt: string; // ISO
};

export type WorkRecapRunResponse = {
  ok: true;
  run: WorkRecapRun;
};

export type WorkRecapLatestResponse = {
  ok: true;
  windowKey: WorkRecapWindow;
  /** null when no recap has been generated for this window yet. */
  run: WorkRecapRun | null;
};

export type WorkRecapListResponse = {
  ok: true;
  windowKey: WorkRecapWindow;
  runs: WorkRecapRun[];
};

/** Raw commit shape after `git log` parse. Lives in memory only. */
export type WorkRecapCommit = {
  /** Canonical repo path (matches repos.path_canonical). */
  repoPath: string;
  /** Short repo label derived from path tail. */
  repoLabel: string;
  sha: string;
  authorEmail: string;
  authorName: string;
  committedAt: Date;
  subject: string;
  /** Conventional-commit prefix classification (`feat`, `fix`, …, `other`). */
  kind: WorkRecapCommitTypeKind;
};

/** Current prompt version. Bump when prompt template OR schema changes. */
export const WORK_RECAP_PROMPT_VERSION = "work-recap@v2";

/** Top topics kept per source in the topic-drift facts (narrative spine). */
export const WORK_RECAP_TOPIC_TOP_N = 5;
/** Drift is noisy on small N (weekly dev topics run 6–26 events). Gate it. */
export const WORK_RECAP_DRIFT_MIN_EVENTS = 30;

/** Per-repo `git log --max-count` (F8 decision). */
export const WORK_RECAP_PER_REPO_COMMIT_CAP = 500;

/** Global scan budget (git log phase only, excludes LLM call). */
export const WORK_RECAP_SCAN_TIMEOUT_MS = 10_000;

/**
 * LLM call timeout. 60s (was 30s): reasoning models (deepseek-reasoner) spend
 * real time reasoning before emitting the JSON, and the v2 multi-source prompt
 * is longer; 30s timed out mid-reason and degraded to the commit-only fallback.
 */
export const WORK_RECAP_LLM_TIMEOUT_MS = 60_000;

/** Concurrent git log calls cap (F8/F9 / D1 decision). */
export const WORK_RECAP_CONCURRENCY = 8;

/** Retention per window (P4 decision). */
export const WORK_RECAP_RETENTION_PER_WINDOW = 200;

/** Prompt budget caps. */
export const WORK_RECAP_PROMPT_BUDGET = {
  topProjects: 8,
  commitsPerProject: 15,
  subjectMaxChars: 100,
  totalCharsCap: 12_000,
} as const;

export function windowToDays(window: WorkRecapWindow): number {
  switch (window) {
    case "1d":
      return 1;
    case "3d":
      return 3;
    case "7d":
      return 7;
    case "14d":
      return 14;
    case "30d":
      return 30;
  }
}

export function isWorkRecapWindow(raw: unknown): raw is WorkRecapWindow {
  return (
    typeof raw === "string" &&
    (WORK_RECAP_WINDOWS as readonly string[]).includes(raw)
  );
}
