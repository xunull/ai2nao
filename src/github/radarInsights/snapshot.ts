import type Database from "better-sqlite3";
import { buildEvidenceForRepo, listRadarCandidates } from "./evidence.js";
import { scanCurrentGitContext, sha1 } from "./currentWork.js";
import { listIndexedProjectSources } from "./projectContext.js";
import {
  applyFeedbackEffects,
  insightFromRepo,
  tasteProfileInsight,
  type FeedbackRow,
} from "./rank.js";
import type {
  RadarFeedbackInput,
  RadarInsight,
  RadarInsightRefreshResult,
  RadarInsightSnapshot,
  RadarInsightSourceFingerprint,
  RadarInsightWarning,
  RadarInsightsResponse,
} from "./types.js";

let refreshRunning = false;

type SnapshotRow = {
  id: number;
  generated_at: string;
  status: RadarInsightSnapshot["status"];
  source_fingerprint_json: string;
  error_code: RadarInsightSnapshot["error_code"];
  duration_ms: number;
  stars_scanned: number;
  docs_scanned: number;
  docs_skipped: number;
  candidate_count: number;
  insight_count: number;
  warnings_json: string;
};

type InsightRow = {
  id: number;
  fingerprint: string;
  kind: RadarInsight["kind"];
  title: string;
  summary: string;
  health: RadarInsight["health"];
  health_reason: string;
  score: number;
  repo_ids_json: string;
  terms_json: string;
  evidence_json: string;
};

export type RefreshRadarInsightsArgs = {
  cwd?: string;
  now?: () => Date;
  candidateLimit?: number;
};

export function getRadarInsights(db: Database.Database): RadarInsightsResponse {
  const snapshot = readLatestSnapshot(db);
  const legacyAvailable = hasStars(db);
  if (!snapshot) {
    return {
      meta: {
        status: legacyAvailable ? "stale" : "empty",
        generated_at: null,
        error_code: legacyAvailable ? null : "no_stars",
        warnings: [],
        metrics: null,
      },
      current_clues: [],
      rediscovered: [],
      retire_candidates: [],
      taste_profile: null,
      legacy_available: legacyAvailable,
    };
  }
  return snapshotToResponse(snapshot, legacyAvailable);
}

export function refreshRadarInsights(
  db: Database.Database,
  args: RefreshRadarInsightsArgs = {}
): RadarInsightRefreshResult {
  if (refreshRunning) {
    return {
      ok: false,
      status: "refresh_in_progress",
      error: "refresh_in_progress",
      previousSnapshot: readLatestSnapshot(db),
      warnings: [],
    };
  }
  refreshRunning = true;
  const started = Date.now();
  const now = (args.now ?? (() => new Date()))();
  try {
    const starStats = getStarStats(db);
    if (starStats.stars_count === 0) {
      const snapshot = writeSnapshot(db, {
        generatedAt: now.toISOString(),
        status: "empty",
        fingerprint: baseFingerprint(starStats, null, null, feedbackHash(db)),
        warnings: [{ code: "no_stars", message: "No GitHub Star rows are available." }],
        errorCode: "no_stars",
        metrics: {
          duration_ms: Date.now() - started,
          stars_scanned: 0,
          docs_scanned: 0,
          docs_skipped: 0,
          candidate_count: 0,
          insight_count: 0,
        },
        insights: [],
      });
      return { ok: true, status: "empty", snapshot, warnings: snapshot.warnings };
    }

    const projectContext = listIndexedProjectSources(db);
    const gitContext = scanCurrentGitContext({ cwd: args.cwd });
    const sources = [...projectContext.sources, ...gitContext.sources];
    const warnings = [...projectContext.warnings, ...gitContext.warnings];
    const candidates = listRadarCandidates(db, args.candidateLimit ?? 200);
    const feedback = loadFeedbackRows(db);
    const built: RadarInsight[] = [];
    for (const repo of candidates) {
      const evidence = buildEvidenceForRepo(repo, sources);
      const hasCurrent = evidence.some((e) =>
        e.source_kind === "todo" ||
        e.source_kind === "doc" ||
        e.source_kind === "git_commit" ||
        e.source_kind === "branch"
      );
      if (hasCurrent) {
        built.push(insightFromRepo("recommended_now", repo, evidence, warnings.length, now));
      }
      if (!repo.archived && repo.pushed_at && olderThan(repo.starred_at, now, 365) && !olderThan(repo.pushed_at, now, 180)) {
        built.push(insightFromRepo("rediscovered", repo, evidence, warnings.length, now));
      }
      if (repo.archived || (repo.pushed_at && olderThan(repo.pushed_at, now, 730))) {
        built.push(insightFromRepo("retire_candidate", repo, evidence, warnings.length, now));
      }
    }
    const taste = tasteProfileInsight(loadTopTags(db));
    if (taste) built.push(taste);
    const ranked = applyFeedbackEffects(built, feedback, now)
      .filter((i) => i.health !== "suppressed")
      .slice(0, 60);
    const fingerprint = baseFingerprint(
      starStats,
      projectContext.project_context_hash,
      gitContext.git_context_hash,
      feedbackHash(db)
    );
    const snapshot = writeSnapshot(db, {
      generatedAt: now.toISOString(),
      status: warnings.length > 0 ? "partial" : "fresh",
      fingerprint,
      warnings,
      errorCode: null,
      metrics: {
        duration_ms: Date.now() - started,
        stars_scanned: starStats.stars_count,
        docs_scanned: projectContext.docs_scanned,
        docs_skipped: projectContext.docs_skipped,
        candidate_count: candidates.length,
        insight_count: ranked.length,
      },
      insights: ranked,
    });
    return {
      ok: true,
      status: snapshot.status === "partial" ? "partial" : "fresh",
      snapshot,
      warnings,
    };
  } catch {
    const previousSnapshot = readLatestSnapshot(db);
    return {
      ok: false,
      status: "error",
      error: "snapshot_write_failed",
      previousSnapshot,
      warnings: [{ code: "snapshot_write_failed", message: "Insight refresh failed before a new snapshot could be committed." }],
    };
  } finally {
    refreshRunning = false;
  }
}

export function saveRadarInsightFeedback(
  db: Database.Database,
  input: RadarFeedbackInput,
  now: Date = new Date()
): { ok: true } {
  const createdAt = now.toISOString();
  const expiresAt = feedbackExpiresAt(input.feedback, now);
  db.prepare(
    `INSERT INTO gh_radar_insight_feedback (
       target_type, target_id, feedback, insight_fingerprint, repo_id,
       terms_json, expires_at, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    input.target_type,
    input.target_id,
    input.feedback,
    input.insight_fingerprint ?? null,
    input.repo_id ?? null,
    JSON.stringify((input.terms ?? []).slice(0, 16)),
    expiresAt,
    createdAt
  );
  return { ok: true };
}

function readLatestSnapshot(db: Database.Database): RadarInsightSnapshot | null {
  const row = db
    .prepare(
      `SELECT * FROM gh_radar_insight_snapshot
       ORDER BY generated_at DESC, id DESC
       LIMIT 1`
    )
    .get() as SnapshotRow | undefined;
  if (!row) return null;
  const insightRows = db
    .prepare(
      `SELECT id, fingerprint, kind, title, summary, health, health_reason,
              score, repo_ids_json, terms_json, evidence_json
       FROM gh_radar_insight
       WHERE snapshot_id = ?
       ORDER BY kind ASC, score DESC, id ASC`
    )
    .all(row.id) as InsightRow[];
  try {
    return {
      id: row.id,
      generated_at: row.generated_at,
      status: row.status,
      source_fingerprint: JSON.parse(row.source_fingerprint_json) as RadarInsightSourceFingerprint,
      error_code: row.error_code,
      warnings: JSON.parse(row.warnings_json) as RadarInsightWarning[],
      metrics: {
        duration_ms: row.duration_ms,
        stars_scanned: row.stars_scanned,
        docs_scanned: row.docs_scanned,
        docs_skipped: row.docs_skipped,
        candidate_count: row.candidate_count,
        insight_count: row.insight_count,
      },
      insights: insightRows.map((r) => ({
        id: r.id,
        fingerprint: r.fingerprint,
        kind: r.kind,
        title: r.title,
        summary: r.summary,
        health: r.health,
        health_reason: r.health_reason,
        score: r.score,
        repo_ids: JSON.parse(r.repo_ids_json) as number[],
        terms: JSON.parse(r.terms_json) as string[],
        evidence: JSON.parse(r.evidence_json) as RadarInsight["evidence"],
      })),
    };
  } catch {
    return {
      id: row.id,
      generated_at: row.generated_at,
      status: "error",
      source_fingerprint: baseFingerprint(getStarStats(db), null, null, null),
      error_code: "snapshot_parse_failed",
      warnings: [{ code: "snapshot_parse_failed", message: "Stored insight snapshot could not be parsed." }],
      metrics: {
        duration_ms: row.duration_ms,
        stars_scanned: row.stars_scanned,
        docs_scanned: row.docs_scanned,
        docs_skipped: row.docs_skipped,
        candidate_count: row.candidate_count,
        insight_count: row.insight_count,
      },
      insights: [],
    };
  }
}

function writeSnapshot(
  db: Database.Database,
  input: {
    generatedAt: string;
    status: RadarInsightSnapshot["status"];
    fingerprint: RadarInsightSourceFingerprint;
    warnings: RadarInsightWarning[];
    errorCode: RadarInsightSnapshot["error_code"];
    metrics: RadarInsightSnapshot["metrics"];
    insights: RadarInsight[];
  }
): RadarInsightSnapshot {
  const tx = db.transaction(() => {
    const snapshot = db
      .prepare(
        `INSERT INTO gh_radar_insight_snapshot (
           generated_at, status, source_fingerprint_json, error_code,
           duration_ms, stars_scanned, docs_scanned, docs_skipped,
           candidate_count, insight_count, warnings_json
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        input.generatedAt,
        input.status,
        JSON.stringify(input.fingerprint),
        input.errorCode,
        input.metrics.duration_ms,
        input.metrics.stars_scanned,
        input.metrics.docs_scanned,
        input.metrics.docs_skipped,
        input.metrics.candidate_count,
        input.metrics.insight_count,
        JSON.stringify(input.warnings)
      );
    const snapshotId = Number(snapshot.lastInsertRowid);
    const insert = db.prepare(
      `INSERT INTO gh_radar_insight (
         snapshot_id, fingerprint, kind, title, summary, health, health_reason,
         score, repo_ids_json, terms_json, evidence_json, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const insight of input.insights) {
      insert.run(
        snapshotId,
        insight.fingerprint,
        insight.kind,
        insight.title,
        insight.summary,
        insight.health,
        insight.health_reason,
        insight.score,
        JSON.stringify(insight.repo_ids),
        JSON.stringify(insight.terms),
        JSON.stringify(insight.evidence),
        input.generatedAt
      );
    }
    return snapshotId;
  });
  const snapshotId = tx();
  const snapshot = readLatestSnapshot(db);
  if (!snapshot || snapshot.id !== snapshotId) {
    throw new Error("snapshot_write_failed");
  }
  return snapshot;
}

function snapshotToResponse(
  snapshot: RadarInsightSnapshot,
  legacyAvailable: boolean
): RadarInsightsResponse {
  return {
    meta: {
      status: snapshot.status,
      generated_at: snapshot.generated_at,
      error_code: snapshot.error_code,
      warnings: snapshot.warnings,
      metrics: snapshot.metrics,
    },
    current_clues: snapshot.insights
      .filter((i) => i.kind === "recommended_now")
      .slice(0, 3),
    rediscovered: snapshot.insights.filter((i) => i.kind === "rediscovered"),
    retire_candidates: snapshot.insights.filter((i) => i.kind === "retire_candidate"),
    taste_profile:
      snapshot.insights.find((i) => i.kind === "taste_profile") ?? null,
    legacy_available: legacyAvailable,
  };
}

function hasStars(db: Database.Database): boolean {
  const row = db.prepare("SELECT COUNT(*) AS c FROM gh_star").get() as { c: number };
  return row.c > 0;
}

function getStarStats(db: Database.Database): {
  stars_count: number;
  max_starred_at: string | null;
  max_star_pushed_at: string | null;
} {
  return db
    .prepare(
      `SELECT COUNT(*) AS stars_count,
              MAX(starred_at) AS max_starred_at,
              MAX(pushed_at) AS max_star_pushed_at
       FROM gh_star`
    )
    .get() as {
      stars_count: number;
      max_starred_at: string | null;
      max_star_pushed_at: string | null;
    };
}

function baseFingerprint(
  starStats: {
    stars_count: number;
    max_starred_at: string | null;
    max_star_pushed_at: string | null;
  },
  projectContextHash: string | null,
  gitContextHash: string | null,
  feedbackHashValue: string | null
): RadarInsightSourceFingerprint {
  return {
    stars_count: starStats.stars_count,
    max_starred_at: starStats.max_starred_at,
    max_star_pushed_at: starStats.max_star_pushed_at,
    project_context_hash: projectContextHash,
    git_context_hash: gitContextHash,
    feedback_hash: feedbackHashValue,
    version: "2026-05-04.1",
  };
}

function loadFeedbackRows(db: Database.Database): FeedbackRow[] {
  const rows = db
    .prepare(
      `SELECT target_type, target_id, feedback, insight_fingerprint, repo_id,
              terms_json, expires_at
       FROM gh_radar_insight_feedback
       ORDER BY created_at DESC`
    )
    .all() as Array<Omit<FeedbackRow, "terms"> & { terms_json: string }>;
  return rows.map((r) => ({
    target_type: r.target_type,
    target_id: r.target_id,
    feedback: r.feedback,
    insight_fingerprint: r.insight_fingerprint,
    repo_id: r.repo_id,
    terms: safeJsonArray(r.terms_json),
    expires_at: r.expires_at,
  }));
}

function loadTopTags(db: Database.Database): { tag: string; count: number }[] {
  return db
    .prepare(
      `SELECT tag, COUNT(*) AS count
       FROM gh_repo_tag
       GROUP BY tag
       ORDER BY count DESC, tag ASC
       LIMIT 12`
    )
    .all() as { tag: string; count: number }[];
}

function feedbackHash(db: Database.Database): string | null {
  const rows = db
    .prepare(
      `SELECT target_type, target_id, feedback, insight_fingerprint, repo_id,
              terms_json, expires_at, created_at
       FROM gh_radar_insight_feedback
       ORDER BY id ASC`
    )
    .all();
  return rows.length > 0 ? sha1(JSON.stringify(rows)) : null;
}

function safeJsonArray(raw: string): string[] {
  try {
    const v = JSON.parse(raw) as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function olderThan(iso: string, now: Date, days: number): boolean {
  return now.getTime() - new Date(iso).getTime() > days * 86_400_000;
}

function feedbackExpiresAt(feedback: string, now: Date): string | null {
  const days =
    feedback === "wrong" ? 30 : feedback === "later" ? 14 : feedback === "ignore" ? 90 : 0;
  if (days === 0) return null;
  return new Date(now.getTime() + days * 86_400_000).toISOString();
}
