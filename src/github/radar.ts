import type Database from "better-sqlite3";
import { parseTopicsSafe } from "./queries.js";

export const STAR_NOTE_STATUSES = [
  "new",
  "reviewed",
  "try_next",
  "ignore",
  "retired",
] as const;

export type StarNoteStatus = (typeof STAR_NOTE_STATUSES)[number];

export const RADAR_SIGNALS = [
  "archived",
  "stale",
  "needs_review",
  "missing_reason",
  "recently_starred",
  "active_recently",
] as const;

export type RadarSignal = (typeof RADAR_SIGNALS)[number];

export type GhStarNote = {
  repo_id: number;
  reason: string;
  status: StarNoteStatus;
  last_reviewed_at: string | null;
  source: "user";
  created_at: string;
  updated_at: string;
};

export type RadarRepo = {
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
  note: GhStarNote | null;
  effective_status: StarNoteStatus;
  signals: RadarSignal[];
};

export type RadarCluster = {
  tag: string;
  count: number;
  missing_reason_count: number;
  needs_review_count: number;
  stale_count: number;
  last_starred_at: string | null;
};

export type RadarOverview = {
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
  clusters: RadarCluster[];
  language_only: RadarCluster[];
  queues: {
    missing_reason: RadarRepo[];
    needs_review: RadarRepo[];
    stale: RadarRepo[];
    try_next: RadarRepo[];
    recently_starred: RadarRepo[];
  };
};

export type RadarOverviewArgs = {
  now?: () => Date;
  clusterLimit?: number;
  queueLimit?: number;
};

type Thresholds = RadarOverview["thresholds"];

type RadarDbRow = {
  repo_id: number;
  owner: string;
  name: string;
  full_name: string;
  description: string | null;
  html_url: string;
  language: string | null;
  topics_json: string;
  stargazers_count: number;
  starred_at: string;
  archived: number;
  pushed_at: string | null;
  reason: string | null;
  status: string | null;
  last_reviewed_at: string | null;
  source: string | null;
  note_created_at: string | null;
  note_updated_at: string | null;
};

type CountRow = {
  total_stars: number;
  missing_reason: number;
  needs_review: number;
  stale: number;
  archived: number;
  recently_starred: number;
  active_recently: number;
  try_next: number;
};

type ClusterDbRow = {
  tag: string;
  count: number;
  missing_reason_count: number;
  needs_review_count: number;
  stale_count: number;
  last_starred_at: string | null;
};

const DEFAULT_CLUSTER_LIMIT = 20;
const DEFAULT_QUEUE_LIMIT = 10;

export function isStarNoteStatus(v: unknown): v is StarNoteStatus {
  return typeof v === "string" && STAR_NOTE_STATUSES.includes(v as StarNoteStatus);
}

export function assertValidRepoId(repoId: number): void {
  if (!Number.isInteger(repoId) || repoId <= 0) {
    throw new Error("repo_id must be a positive integer");
  }
}

export function upsertStarNote(
  db: Database.Database,
  input: {
    repoId: number;
    reason?: string | null;
    status: StarNoteStatus;
    lastReviewedAt?: string | null;
    now?: () => Date;
  }
): GhStarNote {
  assertValidRepoId(input.repoId);
  if (!isStarNoteStatus(input.status)) {
    throw new Error(`status must be one of: ${STAR_NOTE_STATUSES.join(", ")}`);
  }
  const nowIso = (input.now ?? (() => new Date()))().toISOString();
  const reason = (input.reason ?? "").trim();
  const lastReviewedAt = normalizeOptionalIso(input.lastReviewedAt);

  db.prepare(
    `INSERT INTO gh_star_note (
       repo_id, reason, status, last_reviewed_at, source, created_at, updated_at
     ) VALUES (?, ?, ?, ?, 'user', ?, ?)
     ON CONFLICT(repo_id) DO UPDATE SET
       reason = excluded.reason,
       status = excluded.status,
       last_reviewed_at = excluded.last_reviewed_at,
       source = 'user',
       updated_at = excluded.updated_at`
  ).run(input.repoId, reason, input.status, lastReviewedAt, nowIso, nowIso);

  return getStarNote(db, input.repoId)!;
}

export function getStarNote(
  db: Database.Database,
  repoId: number
): GhStarNote | null {
  assertValidRepoId(repoId);
  const row = db
    .prepare(
      `SELECT repo_id, reason, status, last_reviewed_at, source, created_at, updated_at
       FROM gh_star_note WHERE repo_id = ?`
    )
    .get(repoId) as GhStarNote | undefined;
  return row ?? null;
}

export function getRadarOverview(
  db: Database.Database,
  args: RadarOverviewArgs = {}
): RadarOverview {
  const now = (args.now ?? (() => new Date()))();
  const thresholds = buildThresholds(now);
  const clusterLimit = clampLimit(args.clusterLimit, DEFAULT_CLUSTER_LIMIT, 50);
  const queueLimit = clampLimit(args.queueLimit, DEFAULT_QUEUE_LIMIT, 50);

  return {
    generated_at: now.toISOString(),
    thresholds,
    counts: getRadarCounts(db, thresholds),
    clusters: getRadarClusters(db, "topic", thresholds, clusterLimit),
    language_only: getRadarClusters(
      db,
      "language-fallback",
      thresholds,
      clusterLimit
    ),
    queues: {
      missing_reason: getRadarQueue(db, "missing_reason", thresholds, queueLimit),
      needs_review: getRadarQueue(db, "needs_review", thresholds, queueLimit),
      stale: getRadarQueue(db, "stale", thresholds, queueLimit),
      try_next: getRadarQueue(db, "try_next", thresholds, queueLimit),
      recently_starred: getRadarQueue(
        db,
        "recently_starred",
        thresholds,
        queueLimit
      ),
    },
  };
}

function buildThresholds(now: Date): Thresholds {
  return {
    stale_before: monthsBefore(now, 18),
    needs_review_before: monthsBefore(now, 12),
    recently_starred_since: daysBefore(now, 30),
    active_recently_since: daysBefore(now, 90),
  };
}

function monthsBefore(now: Date, months: number): string {
  const d = new Date(now.getTime());
  d.setUTCMonth(d.getUTCMonth() - months);
  return d.toISOString();
}

function daysBefore(now: Date, days: number): string {
  const d = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  return d.toISOString();
}

function normalizeOptionalIso(v: string | null | undefined): string | null {
  const t = (v ?? "").trim();
  return t.length > 0 ? t : null;
}

function clampLimit(raw: number | undefined, fallback: number, max: number): number {
  return Math.min(max, Math.max(1, raw ?? fallback));
}

function getRadarCounts(
  db: Database.Database,
  thresholds: Thresholds
): RadarOverview["counts"] {
  const row = db
    .prepare(
      `SELECT
         COUNT(*) AS total_stars,
         SUM(CASE WHEN n.repo_id IS NULL OR trim(n.reason) = '' THEN 1 ELSE 0 END) AS missing_reason,
         SUM(CASE WHEN n.last_reviewed_at IS NOT NULL AND n.last_reviewed_at < @needsReviewBefore THEN 1 ELSE 0 END) AS needs_review,
         SUM(CASE WHEN s.archived = 0 AND s.pushed_at IS NOT NULL AND s.pushed_at < @staleBefore THEN 1 ELSE 0 END) AS stale,
         SUM(CASE WHEN s.archived != 0 THEN 1 ELSE 0 END) AS archived,
         SUM(CASE WHEN s.starred_at >= @recentlyStarredSince THEN 1 ELSE 0 END) AS recently_starred,
         SUM(CASE WHEN s.pushed_at IS NOT NULL AND s.pushed_at >= @activeRecentlySince THEN 1 ELSE 0 END) AS active_recently,
         SUM(CASE WHEN n.status = 'try_next' THEN 1 ELSE 0 END) AS try_next
       FROM gh_star s
       LEFT JOIN gh_star_note n ON n.repo_id = s.repo_id`
    )
    .get(sqlParams(thresholds)) as CountRow | undefined;
  return {
    total_stars: row?.total_stars ?? 0,
    missing_reason: row?.missing_reason ?? 0,
    needs_review: row?.needs_review ?? 0,
    stale: row?.stale ?? 0,
    archived: row?.archived ?? 0,
    recently_starred: row?.recently_starred ?? 0,
    active_recently: row?.active_recently ?? 0,
    try_next: row?.try_next ?? 0,
  };
}

function getRadarClusters(
  db: Database.Database,
  source: "topic" | "language-fallback",
  thresholds: Thresholds,
  limit: number
): RadarCluster[] {
  const rows = db
    .prepare(
      `SELECT
         t.tag AS tag,
         COUNT(*) AS count,
         SUM(CASE WHEN n.repo_id IS NULL OR trim(n.reason) = '' THEN 1 ELSE 0 END) AS missing_reason_count,
         SUM(CASE WHEN n.last_reviewed_at IS NOT NULL AND n.last_reviewed_at < @needsReviewBefore THEN 1 ELSE 0 END) AS needs_review_count,
         SUM(CASE WHEN s.archived = 0 AND s.pushed_at IS NOT NULL AND s.pushed_at < @staleBefore THEN 1 ELSE 0 END) AS stale_count,
         MAX(s.starred_at) AS last_starred_at
       FROM gh_repo_tag t
       JOIN gh_star s ON s.repo_id = t.repo_id
       LEFT JOIN gh_star_note n ON n.repo_id = s.repo_id
       WHERE t.source = @source
       GROUP BY t.tag
       ORDER BY count DESC, last_starred_at DESC, t.tag ASC
       LIMIT @limit`
    )
    .all({ ...sqlParams(thresholds), source, limit }) as ClusterDbRow[];
  return rows.map((r) => ({
    tag: r.tag,
    count: r.count,
    missing_reason_count: r.missing_reason_count,
    needs_review_count: r.needs_review_count,
    stale_count: r.stale_count,
    last_starred_at: r.last_starred_at,
  }));
}

function getRadarQueue(
  db: Database.Database,
  queue:
    | "missing_reason"
    | "needs_review"
    | "stale"
    | "try_next"
    | "recently_starred",
  thresholds: Thresholds,
  limit: number
): RadarRepo[] {
  const where =
    queue === "missing_reason"
      ? "(n.repo_id IS NULL OR trim(n.reason) = '')"
      : queue === "needs_review"
        ? "n.last_reviewed_at IS NOT NULL AND n.last_reviewed_at < @needsReviewBefore"
        : queue === "stale"
          ? "s.archived = 0 AND s.pushed_at IS NOT NULL AND s.pushed_at < @staleBefore"
          : queue === "try_next"
            ? "n.status = 'try_next'"
            : "s.starred_at >= @recentlyStarredSince";
  const rows = db
    .prepare(`${BASE_RADAR_SELECT} WHERE ${where}
      ORDER BY s.starred_at DESC, s.repo_id DESC
      LIMIT @limit`)
    .all({ ...sqlParams(thresholds), limit }) as RadarDbRow[];
  return rows.map((r) => mapRadarRow(r, thresholds));
}

const BASE_RADAR_SELECT = `
  SELECT
    s.repo_id, s.owner, s.name, s.full_name, s.description, s.html_url,
    s.language, s.topics_json, s.stargazers_count, s.starred_at,
    s.archived, s.pushed_at,
    n.reason, n.status, n.last_reviewed_at, n.source,
    n.created_at AS note_created_at, n.updated_at AS note_updated_at
  FROM gh_star s
  LEFT JOIN gh_star_note n ON n.repo_id = s.repo_id
`;

function mapRadarRow(row: RadarDbRow, thresholds: Thresholds): RadarRepo {
  const note =
    row.status && isStarNoteStatus(row.status)
      ? {
          repo_id: row.repo_id,
          reason: row.reason ?? "",
          status: row.status,
          last_reviewed_at: row.last_reviewed_at,
          source: "user" as const,
          created_at: row.note_created_at ?? "",
          updated_at: row.note_updated_at ?? "",
        }
      : null;
  const effectiveStatus = note?.status ?? "new";
  return {
    repo_id: row.repo_id,
    owner: row.owner,
    name: row.name,
    full_name: row.full_name,
    description: row.description,
    html_url: row.html_url,
    language: row.language,
    topics: parseTopicsSafe(row.topics_json, `gh_star.repo_id=${row.repo_id}`),
    stargazers_count: row.stargazers_count,
    starred_at: row.starred_at,
    archived: row.archived !== 0,
    pushed_at: row.pushed_at,
    note,
    effective_status: effectiveStatus,
    signals: signalsForRow(row, thresholds),
  };
}

function signalsForRow(row: RadarDbRow, thresholds: Thresholds): RadarSignal[] {
  const signals: RadarSignal[] = [];
  if (row.archived !== 0) signals.push("archived");
  if (
    row.archived === 0 &&
    row.pushed_at != null &&
    row.pushed_at < thresholds.stale_before
  ) {
    signals.push("stale");
  }
  if (
    row.last_reviewed_at != null &&
    row.last_reviewed_at < thresholds.needs_review_before
  ) {
    signals.push("needs_review");
  }
  if (row.reason == null || row.reason.trim() === "") {
    signals.push("missing_reason");
  }
  if (row.starred_at >= thresholds.recently_starred_since) {
    signals.push("recently_starred");
  }
  if (
    row.pushed_at != null &&
    row.pushed_at >= thresholds.active_recently_since
  ) {
    signals.push("active_recently");
  }
  return signals;
}

function sqlParams(thresholds: Thresholds) {
  return {
    staleBefore: thresholds.stale_before,
    needsReviewBefore: thresholds.needs_review_before,
    recentlyStarredSince: thresholds.recently_starred_since,
    activeRecentlySince: thresholds.active_recently_since,
  };
}
