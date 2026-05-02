/**
 * Read/write queries against the gh_* tables created in migration v5. Split
 * into three concerns:
 *
 *   1. Row types + `parseTopicsSafe` (shared shape between API and sync)
 *   2. `upsertRepo` / `upsertStar` / `upsertCommitCount` — used by sync.ts
 *      inside a synchronous `db.transaction(...)` block; network I/O MUST
 *      happen in the caller before the tx runs (see AGENTS pattern in
 *      src/chromeHistory/sync.ts).
 *   3. List queries for `/api/github/*` endpoints. Pagination uses id-based
 *      keyset cursors so 10k+ star lists stay O(log N + page).
 */

import type Database from "better-sqlite3";
import type { GithubApiRepo, GithubApiStar, CommitCountResult } from "./fetcher.js";

export type GhRepoRow = {
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

export type GhStarRow = {
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

/**
 * Parse `topics_json` without crashing the whole API on a single corrupted row.
 * Historically added after an eng review: `JSON.parse` on bad input throws
 * SyntaxError, which turns `listRepos` into a 500 for one bad row out of
 * thousands. Returning `[]` + a stderr warning preserves the rest of the page.
 */
export function parseTopicsSafe(raw: string, context?: string): string[] {
  try {
    const v = JSON.parse(raw) as unknown;
    if (Array.isArray(v) && v.every((x) => typeof x === "string")) {
      return v;
    }
    return [];
  } catch (e) {
    if (context) {
      console.error(
        `github: topics_json parse failed (${context}): ${e instanceof Error ? e.message : String(e)}`
      );
    }
    return [];
  }
}

type RepoDbRow = {
  id: number;
  owner: string;
  name: string;
  full_name: string;
  description: string | null;
  private: number;
  fork: number;
  archived: number;
  default_branch: string | null;
  html_url: string;
  clone_url: string | null;
  language: string | null;
  topics_json: string;
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

function mapRepoRow(r: RepoDbRow): GhRepoRow {
  return {
    id: r.id,
    owner: r.owner,
    name: r.name,
    full_name: r.full_name,
    description: r.description,
    private: r.private !== 0,
    fork: r.fork !== 0,
    archived: r.archived !== 0,
    default_branch: r.default_branch,
    html_url: r.html_url,
    clone_url: r.clone_url,
    language: r.language,
    topics: parseTopicsSafe(r.topics_json, `gh_repo.id=${r.id}`),
    stargazers_count: r.stargazers_count,
    forks_count: r.forks_count,
    open_issues_count: r.open_issues_count,
    size_kb: r.size_kb,
    created_at: r.created_at,
    updated_at: r.updated_at,
    pushed_at: r.pushed_at,
    commit_count: r.commit_count,
    commit_count_error: r.commit_count_error,
    commit_count_checked_at: r.commit_count_checked_at,
  };
}

const SELECT_REPO_JOIN = `
  SELECT r.id, r.owner, r.name, r.full_name, r.description,
         r.private, r.fork, r.archived,
         r.default_branch, r.html_url, r.clone_url, r.language,
         r.topics_json, r.stargazers_count, r.forks_count,
         r.open_issues_count, r.size_kb,
         r.created_at, r.updated_at, r.pushed_at,
         c.count AS commit_count,
         c.error AS commit_count_error,
         c.checked_at AS commit_count_checked_at
  FROM gh_repo r
  LEFT JOIN gh_commit_count c ON c.repo_id = r.id
`;

export type ListReposArgs = {
  /** Keyset cursor: last seen id (exclusive). Omit for first page. */
  cursor?: number | null;
  perPage?: number;
  /** Sort key for the list endpoint; heatmap uses a separate query. */
  sort?: "created_at" | "updated_at" | "pushed_at";
};

export type ListReposResult = {
  items: GhRepoRow[];
  nextCursor: number | null;
};

/**
 * Keyset-paginated repo list, default sort `created_at DESC`. We encode the
 * cursor as the last row's `id` so clients never have to send ISO strings.
 * Works because we also secondary-sort by id, which is unique and ordinal in
 * GitHub's numbering system (strictly monotonic over time per user account).
 */
export function listRepos(db: Database.Database, args: ListReposArgs = {}): ListReposResult {
  const perPage = Math.min(100, Math.max(1, args.perPage ?? 30));
  const sort = args.sort ?? "created_at";
  const sortCol =
    sort === "updated_at" ? "r.updated_at" : sort === "pushed_at" ? "r.pushed_at" : "r.created_at";
  const cursorSql = args.cursor != null ? " WHERE r.id < ?" : "";
  const sql = `${SELECT_REPO_JOIN}${cursorSql}
    ORDER BY ${sortCol} DESC, r.id DESC
    LIMIT ?`;
  const params: unknown[] = args.cursor != null ? [args.cursor, perPage] : [perPage];
  const rows = db.prepare(sql).all(...params) as RepoDbRow[];
  const items = rows.map(mapRepoRow);
  const nextCursor = rows.length === perPage ? rows[rows.length - 1].id : null;
  return { items, nextCursor };
}

export function getRepoById(db: Database.Database, id: number): GhRepoRow | null {
  const row = db
    .prepare(`${SELECT_REPO_JOIN} WHERE r.id = ?`)
    .get(id) as RepoDbRow | undefined;
  return row ? mapRepoRow(row) : null;
}

type StarDbRow = {
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
};

function mapStarRow(r: StarDbRow): GhStarRow {
  return {
    repo_id: r.repo_id,
    owner: r.owner,
    name: r.name,
    full_name: r.full_name,
    description: r.description,
    html_url: r.html_url,
    language: r.language,
    topics: parseTopicsSafe(r.topics_json, `gh_star.repo_id=${r.repo_id}`),
    stargazers_count: r.stargazers_count,
    starred_at: r.starred_at,
    archived: r.archived !== 0,
    pushed_at: r.pushed_at,
  };
}

export type ListStarsArgs = {
  /** Keyset cursor is `starred_at` (ISO8601) here because stars are sorted by
   *  date, not by id, and repo_id is not monotonic (old stars can re-appear). */
  cursor?: string | null;
  perPage?: number;
};

export type ListStarsResult = {
  items: GhStarRow[];
  nextCursor: string | null;
};

export function listStars(db: Database.Database, args: ListStarsArgs = {}): ListStarsResult {
  const perPage = Math.min(100, Math.max(1, args.perPage ?? 30));
  const cursorSql = args.cursor != null ? " WHERE starred_at < ?" : "";
  const sql = `SELECT repo_id, owner, name, full_name, description, html_url, language,
                      topics_json, stargazers_count, starred_at, archived, pushed_at
               FROM gh_star${cursorSql}
               ORDER BY starred_at DESC, repo_id DESC
               LIMIT ?`;
  const params: unknown[] = args.cursor != null ? [args.cursor, perPage] : [perPage];
  const rows = db.prepare(sql).all(...params) as StarDbRow[];
  const items = rows.map(mapStarRow);
  const nextCursor = rows.length === perPage ? rows[rows.length - 1].starred_at : null;
  return { items, nextCursor };
}

export type HeatmapBucket = {
  day: string;
  repo_count: number;
  star_count: number;
};

/**
 * Day-level bucket counts for the calendar heatmap. Aggregates BOTH repo
 * creation dates and star timestamps in a single query so the UI only makes
 * one network call. Day keys are UTC `YYYY-MM-DD` because that matches
 * GitHub's timestamp format — local-day bucketing would require rewriting
 * every timestamp on read and would break quietly across DST.
 */
export function getHeatmapBuckets(
  db: Database.Database,
  sinceIso: string | null,
  untilIso: string | null
): HeatmapBucket[] {
  const filters: string[] = [];
  const params: unknown[] = [];
  if (sinceIso) {
    filters.push("day >= ?");
    params.push(sinceIso.slice(0, 10));
  }
  if (untilIso) {
    filters.push("day <= ?");
    params.push(untilIso.slice(0, 10));
  }
  const where = filters.length > 0 ? ` WHERE ${filters.join(" AND ")}` : "";
  const sql = `
    SELECT day, SUM(repo_count) AS repo_count, SUM(star_count) AS star_count FROM (
      SELECT substr(created_at, 1, 10) AS day,
             COUNT(*) AS repo_count, 0 AS star_count
      FROM gh_repo
      GROUP BY day
      UNION ALL
      SELECT substr(starred_at, 1, 10) AS day,
             0 AS repo_count, COUNT(*) AS star_count
      FROM gh_star
      GROUP BY day
    )${where}
    GROUP BY day
    ORDER BY day ASC`;
  const rows = db.prepare(sql).all(...params) as {
    day: string;
    repo_count: number;
    star_count: number;
  }[];
  return rows;
}

export function getMaxRepoUpdatedAt(db: Database.Database): string | null {
  const row = db
    .prepare("SELECT MAX(updated_at) AS v FROM gh_repo")
    .get() as { v: string | null };
  return row?.v ?? null;
}

export function getMaxStarredAt(db: Database.Database): string | null {
  const row = db
    .prepare("SELECT MAX(starred_at) AS v FROM gh_star")
    .get() as { v: string | null };
  return row?.v ?? null;
}

export function getSyncStateValue(db: Database.Database, key: string): string | null {
  const row = db
    .prepare("SELECT value FROM gh_sync_state WHERE key = ?")
    .get(key) as { value: string | null } | undefined;
  return row?.value ?? null;
}

export function setSyncStateValue(
  db: Database.Database,
  key: string,
  value: string | null
): void {
  db.prepare(
    "INSERT INTO gh_sync_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).run(key, value);
}

export function getSyncState(db: Database.Database): GhSyncState {
  const rows = db.prepare("SELECT key, value FROM gh_sync_state").all() as {
    key: string;
    value: string | null;
  }[];
  const map = new Map(rows.map((r) => [r.key, r.value] as const));
  const num = (v: string | null | undefined): number | null => {
    if (v == null) return null;
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? n : null;
  };
  return {
    last_full_sync_at: map.get("last_full_sync_at") ?? null,
    last_full_sync_duration_ms: num(map.get("last_full_sync_duration_ms")),
    last_full_sync_error: map.get("last_full_sync_error") ?? null,
    last_incremental_sync_at: map.get("last_incremental_sync_at") ?? null,
    last_incremental_sync_duration_ms: num(map.get("last_incremental_sync_duration_ms")),
    last_incremental_sync_error: map.get("last_incremental_sync_error") ?? null,
    last_repos_updated_at: map.get("last_repos_updated_at") ?? null,
    last_starred_at: map.get("last_starred_at") ?? null,
    in_progress: (map.get("in_progress") ?? "0") === "1",
  };
}

// ---------- Upsert (used inside synchronous db.transaction blocks) ----------

function boolToInt(b: boolean): number {
  return b ? 1 : 0;
}

export function upsertRepo(
  db: Database.Database,
  r: GithubApiRepo,
  nowIso: string
): void {
  db.prepare(
    `INSERT INTO gh_repo (
      id, owner, name, full_name, description, private, fork, archived,
      default_branch, html_url, clone_url, language, topics_json,
      stargazers_count, forks_count, open_issues_count, size_kb,
      created_at, updated_at, pushed_at, inserted_at, last_synced_at
    ) VALUES (
      @id, @owner, @name, @full_name, @description, @private, @fork, @archived,
      @default_branch, @html_url, @clone_url, @language, @topics_json,
      @stargazers_count, @forks_count, @open_issues_count, @size_kb,
      @created_at, @updated_at, @pushed_at, @inserted_at, @last_synced_at
    )
    ON CONFLICT(id) DO UPDATE SET
      owner = excluded.owner,
      name = excluded.name,
      full_name = excluded.full_name,
      description = excluded.description,
      private = excluded.private,
      fork = excluded.fork,
      archived = excluded.archived,
      default_branch = excluded.default_branch,
      html_url = excluded.html_url,
      clone_url = excluded.clone_url,
      language = excluded.language,
      topics_json = excluded.topics_json,
      stargazers_count = excluded.stargazers_count,
      forks_count = excluded.forks_count,
      open_issues_count = excluded.open_issues_count,
      size_kb = excluded.size_kb,
      updated_at = excluded.updated_at,
      pushed_at = excluded.pushed_at,
      last_synced_at = excluded.last_synced_at`
  ).run({
    id: r.id,
    owner: r.owner.login,
    name: r.name,
    full_name: r.full_name,
    description: r.description,
    private: boolToInt(r.private),
    fork: boolToInt(r.fork),
    archived: boolToInt(r.archived),
    default_branch: r.default_branch,
    html_url: r.html_url,
    clone_url: r.clone_url,
    language: r.language,
    topics_json: JSON.stringify(r.topics ?? []),
    stargazers_count: r.stargazers_count,
    forks_count: r.forks_count,
    open_issues_count: r.open_issues_count,
    size_kb: r.size,
    created_at: r.created_at,
    updated_at: r.updated_at,
    pushed_at: r.pushed_at,
    inserted_at: nowIso,
    last_synced_at: nowIso,
  });
}

export function upsertStar(
  db: Database.Database,
  s: GithubApiStar,
  nowIso: string
): void {
  db.prepare(
    `INSERT INTO gh_star (
      repo_id, owner, name, full_name, description, html_url, language,
      topics_json, stargazers_count, starred_at, inserted_at, archived, pushed_at
    ) VALUES (
      @repo_id, @owner, @name, @full_name, @description, @html_url, @language,
      @topics_json, @stargazers_count, @starred_at, @inserted_at, @archived, @pushed_at
    )
    ON CONFLICT(repo_id) DO UPDATE SET
      owner = excluded.owner,
      name = excluded.name,
      full_name = excluded.full_name,
      description = excluded.description,
      html_url = excluded.html_url,
      language = excluded.language,
      topics_json = excluded.topics_json,
      stargazers_count = excluded.stargazers_count,
      starred_at = excluded.starred_at,
      archived = excluded.archived,
      pushed_at = excluded.pushed_at`
  ).run({
    repo_id: s.repo.id,
    owner: s.repo.owner.login,
    name: s.repo.name,
    full_name: s.repo.full_name,
    description: s.repo.description,
    html_url: s.repo.html_url,
    language: s.repo.language,
    topics_json: JSON.stringify(s.repo.topics ?? []),
    stargazers_count: s.repo.stargazers_count,
    starred_at: s.starred_at,
    inserted_at: nowIso,
    archived: boolToInt(s.repo.archived),
    pushed_at: s.repo.pushed_at,
  });
}

export function upsertCommitCount(
  db: Database.Database,
  repoId: number,
  result: CommitCountResult,
  nowIso: string
): void {
  db.prepare(
    `INSERT INTO gh_commit_count (repo_id, count, default_branch, error, checked_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(repo_id) DO UPDATE SET
       count = excluded.count,
       default_branch = excluded.default_branch,
       error = excluded.error,
       checked_at = excluded.checked_at`
  ).run(repoId, result.count, result.defaultBranch, result.error, nowIso);
}

export function listRepoIdsNeedingCommitCount(
  db: Database.Database,
  options?: { onlyMissing?: boolean; staleOlderThan?: string }
): { id: number; full_name: string; default_branch: string | null; owner: string; name: string }[] {
  const onlyMissing = options?.onlyMissing ?? false;
  const stale = options?.staleOlderThan;
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (onlyMissing) {
    clauses.push("c.repo_id IS NULL");
  } else if (stale) {
    clauses.push("(c.repo_id IS NULL OR c.checked_at < ?)");
    params.push(stale);
  }
  const where = clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "";
  const sql = `SELECT r.id, r.full_name, r.default_branch, r.owner, r.name
               FROM gh_repo r
               LEFT JOIN gh_commit_count c ON c.repo_id = r.id${where}
               ORDER BY r.updated_at DESC`;
  return db.prepare(sql).all(...params) as {
    id: number;
    full_name: string;
    default_branch: string | null;
    owner: string;
    name: string;
  }[];
}

export function countRepos(db: Database.Database): number {
  return (db.prepare("SELECT COUNT(*) AS c FROM gh_repo").get() as { c: number }).c;
}

export function countStars(db: Database.Database): number {
  return (db.prepare("SELECT COUNT(*) AS c FROM gh_star").get() as { c: number }).c;
}
