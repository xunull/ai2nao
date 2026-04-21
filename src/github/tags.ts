/**
 * Tag-pivot queries and mutations. Three concerns:
 *
 *   1. Alias CRUD (`gh_tag_alias`) + seed.
 *   2. `gh_repo_tag` rebuild (full or by-repo-id), called from sync.ts at
 *      the end of a run and from the `github tags rebuild` CLI command.
 *   3. Read queries for `/api/github/tags/*` — top ranking, 2D tag × time
 *      heatmap, and keyset-paginated filtered repo list with AND/OR mode.
 *
 * All write paths run inside synchronous `db.transaction(...)` blocks. No
 * network I/O here. Callers that need network (e.g. sync) MUST fetch first
 * and then call rebuild — same pattern as sync.ts's upsert loop.
 *
 * V1 scope: stars only (per design doc Premise 1). `repo_id` in every
 * query here means `gh_star.repo_id`. We DO NOT read `gh_repo.topics_json`
 * for tag rebuilds; the starred repos you care about are mostly not your
 * own, so they only exist in `gh_star`.
 */

import type Database from "better-sqlite3";
import { parseTopicsSafe } from "./queries.js";
import { TAG_ALIAS_SEED } from "./tagAliasSeed.js";

// ---------- Types ----------

export type TagAliasRow = {
  from_tag: string;
  to_tag: string;
  source: "preset" | "user";
  note: string | null;
  created_at: string;
};

export type TopTagRow = {
  tag: string;
  count: number;
  last_starred_at: string | null;
};

export type HeatmapCell = {
  tag: string;
  bucket: string;
  count: number;
};

export type TagHeatmapResult = {
  xs: string[];
  ys: string[];
  cells: number[][];
};

export type TaggedRepoRow = {
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

export type TaggedReposResult = {
  items: TaggedRepoRow[];
  nextCursor: string | null;
};

// ---------- Helpers ----------

/**
 * Lowercase + trim a topic before alias lookup. Empty strings are dropped.
 * Matches GitHub's own topic normalization rule (topics are always lowercase
 * on API responses), so the runtime lowercase here is defensive against
 * synthetic data / manual SQL inserts.
 */
function normalizeTopic(raw: string): string | null {
  const t = raw.trim().toLowerCase();
  return t.length > 0 ? t : null;
}

function nowIso(): string {
  return new Date().toISOString();
}

// ---------- Alias CRUD ----------

/**
 * Idempotent seed. Returns the number of new rows actually inserted.
 * `INSERT OR IGNORE` respects existing rows — user edits to any `from_tag`
 * that overlaps with the preset dictionary are preserved.
 */
export function seedTagAliases(db: Database.Database): number {
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO gh_tag_alias (from_tag, to_tag, source, note, created_at)
     VALUES (?, ?, 'preset', ?, ?)`
  );
  const ts = nowIso();
  const tx = db.transaction((entries: typeof TAG_ALIAS_SEED) => {
    let inserted = 0;
    for (const e of entries) {
      const from = e.from.trim().toLowerCase();
      const to = e.to.trim().toLowerCase();
      if (!from || !to) continue;
      const r = stmt.run(from, to, e.note ?? null, ts);
      if (r.changes > 0) inserted++;
    }
    return inserted;
  });
  return tx(TAG_ALIAS_SEED);
}

export function listTagAliases(
  db: Database.Database,
  source?: "preset" | "user"
): TagAliasRow[] {
  const sql = source
    ? "SELECT from_tag, to_tag, source, note, created_at FROM gh_tag_alias WHERE source = ? ORDER BY from_tag"
    : "SELECT from_tag, to_tag, source, note, created_at FROM gh_tag_alias ORDER BY from_tag";
  const rows = source
    ? (db.prepare(sql).all(source) as TagAliasRow[])
    : (db.prepare(sql).all() as TagAliasRow[]);
  return rows;
}

/**
 * Upsert a user-authored alias. `source` is forced to `'user'` regardless of
 * pre-existing row so a user overwrite promotes a preset entry into their
 * control (handy for tracking "I overrode this").
 */
export function upsertUserAlias(
  db: Database.Database,
  from: string,
  to: string,
  note: string | null
): void {
  const f = from.trim().toLowerCase();
  const t = to.trim().toLowerCase();
  if (!f || !t) {
    throw new Error("alias from/to must be non-empty");
  }
  db.prepare(
    `INSERT INTO gh_tag_alias (from_tag, to_tag, source, note, created_at)
     VALUES (?, ?, 'user', ?, ?)
     ON CONFLICT(from_tag) DO UPDATE SET
       to_tag = excluded.to_tag,
       source = 'user',
       note = excluded.note`
  ).run(f, t, note, nowIso());
}

export function removeAlias(db: Database.Database, from: string): boolean {
  const f = from.trim().toLowerCase();
  const r = db.prepare("DELETE FROM gh_tag_alias WHERE from_tag = ?").run(f);
  return r.changes > 0;
}

// ---------- Rebuild ----------

/**
 * Load the alias map in one shot. 1-hop resolution: if a user writes
 * `a → b` and `b → c`, a topic `a` resolves to `b`, not `c`. We deliberately
 * do NOT follow chains: chain resolution requires cycle detection and a
 * topological pass, which is overkill for V1. Users who want `a → c` can
 * write that directly. (Documented in design doc "Open Questions #5".)
 */
function loadAliasMap(db: Database.Database): Map<string, string> {
  const rows = db
    .prepare("SELECT from_tag, to_tag FROM gh_tag_alias")
    .all() as { from_tag: string; to_tag: string }[];
  return new Map(rows.map((r) => [r.from_tag, r.to_tag]));
}

type StarRow = {
  repo_id: number;
  topics_json: string;
  language: string | null;
};

/**
 * Compute the set of canonical tags for one star row. Returns an array of
 * (tag, source) pairs. If the repo has no topics, falls back to
 * `language:<lang>` with source='language-fallback'. If it has neither, the
 * repo contributes zero rows — that's fine, it just won't show up in any
 * tag pivot (but will still appear in `/github` if browsed directly).
 */
function canonicalTagsForStar(
  star: StarRow,
  aliasMap: Map<string, string>
): { tag: string; source: "topic" | "language-fallback" }[] {
  const topics = parseTopicsSafe(
    star.topics_json,
    `gh_star.repo_id=${star.repo_id}`
  );
  const seen = new Set<string>();
  const out: { tag: string; source: "topic" | "language-fallback" }[] = [];
  for (const raw of topics) {
    const norm = normalizeTopic(raw);
    if (!norm) continue;
    const canonical = aliasMap.get(norm) ?? norm;
    if (seen.has(canonical)) continue;
    seen.add(canonical);
    out.push({ tag: canonical, source: "topic" });
  }
  if (out.length === 0 && star.language) {
    const lang = star.language.trim().toLowerCase();
    if (lang) {
      out.push({
        tag: `language:${lang}`,
        source: "language-fallback",
      });
    }
  }
  return out;
}

export type RebuildStats = {
  starsScanned: number;
  tagsInserted: number;
  reposWithNoTags: number;
};

/**
 * Full rebuild: nuke `gh_repo_tag` and repopulate from every row in
 * `gh_star`. Used by `ai2nao github tags rebuild` and by full syncs.
 * Wrapped in a single transaction: 10k stars × ~3 tags each = ~30k inserts,
 * which better-sqlite3 handles in well under a second.
 */
export function rebuildAllRepoTags(db: Database.Database): RebuildStats {
  const aliasMap = loadAliasMap(db);
  const stars = db
    .prepare("SELECT repo_id, topics_json, language FROM gh_star")
    .all() as StarRow[];

  const stats: RebuildStats = {
    starsScanned: stars.length,
    tagsInserted: 0,
    reposWithNoTags: 0,
  };

  const insertStmt = db.prepare(
    "INSERT OR REPLACE INTO gh_repo_tag (repo_id, tag, source) VALUES (?, ?, ?)"
  );

  const tx = db.transaction(() => {
    db.exec("DELETE FROM gh_repo_tag");
    for (const s of stars) {
      const tags = canonicalTagsForStar(s, aliasMap);
      if (tags.length === 0) {
        stats.reposWithNoTags++;
        continue;
      }
      for (const { tag, source } of tags) {
        insertStmt.run(s.repo_id, tag, source);
        stats.tagsInserted++;
      }
    }
  });
  tx();
  return stats;
}

/**
 * Incremental rebuild for a specific set of repo_ids. Called by incremental
 * sync so we don't touch tag rows for repos whose `gh_star` row didn't
 * change. Deletes existing tag rows for those repos, then re-inserts.
 *
 * Returns stats same shape as `rebuildAllRepoTags` but scoped.
 */
export function rebuildRepoTagsForIds(
  db: Database.Database,
  repoIds: Iterable<number>
): RebuildStats {
  const ids = Array.from(new Set(repoIds));
  const stats: RebuildStats = {
    starsScanned: 0,
    tagsInserted: 0,
    reposWithNoTags: 0,
  };
  if (ids.length === 0) return stats;

  const aliasMap = loadAliasMap(db);

  const insertStmt = db.prepare(
    "INSERT OR REPLACE INTO gh_repo_tag (repo_id, tag, source) VALUES (?, ?, ?)"
  );
  const deleteStmt = db.prepare(
    "DELETE FROM gh_repo_tag WHERE repo_id = ?"
  );
  const selectStmt = db.prepare(
    "SELECT repo_id, topics_json, language FROM gh_star WHERE repo_id = ?"
  );

  const tx = db.transaction(() => {
    for (const id of ids) {
      const s = selectStmt.get(id) as StarRow | undefined;
      deleteStmt.run(id);
      if (!s) continue;
      stats.starsScanned++;
      const tags = canonicalTagsForStar(s, aliasMap);
      if (tags.length === 0) {
        stats.reposWithNoTags++;
        continue;
      }
      for (const { tag, source } of tags) {
        insertStmt.run(s.repo_id, tag, source);
        stats.tagsInserted++;
      }
    }
  });
  tx();
  return stats;
}

// ---------- Read queries ----------

export type TopTagsArgs = {
  limit?: number;
  /** "all" = since beginning of time; "12m" = last 12 months from now. */
  window?: "all" | "12m";
  /** If true, include `language:*` fallback tags in the result. Default false. */
  includeLanguageFallback?: boolean;
  /** Clock override for tests. */
  now?: () => Date;
};

/**
 * Top-N tag ranking by count of starred repos, joined against `gh_star` so
 * we can window by `starred_at`. `last_starred_at` is returned so the UI
 * can show "last seen X months ago" per tag.
 */
export function getTopTags(
  db: Database.Database,
  args: TopTagsArgs = {}
): TopTagRow[] {
  const limit = Math.min(500, Math.max(1, args.limit ?? 50));
  const includeFallback = args.includeLanguageFallback ?? false;
  const now = args.now ?? (() => new Date());

  const filters: string[] = [];
  const params: unknown[] = [];
  if (!includeFallback) {
    filters.push("t.source = 'topic'");
  }
  if (args.window === "12m") {
    const cutoff = new Date(now());
    cutoff.setMonth(cutoff.getMonth() - 12);
    filters.push("s.starred_at >= ?");
    params.push(cutoff.toISOString());
  }
  const where = filters.length > 0 ? ` WHERE ${filters.join(" AND ")}` : "";

  const sql = `
    SELECT t.tag AS tag,
           COUNT(*) AS count,
           MAX(s.starred_at) AS last_starred_at
    FROM gh_repo_tag t
    JOIN gh_star s ON s.repo_id = t.repo_id${where}
    GROUP BY t.tag
    ORDER BY count DESC, last_starred_at DESC
    LIMIT ?`;
  params.push(limit);
  return db.prepare(sql).all(...params) as TopTagRow[];
}

export type HeatmapArgs = {
  /** Top-N tags to include (computed from the same window). */
  topN?: number;
  grain?: "month" | "quarter" | "year";
  from?: string | null;
  to?: string | null;
  includeLanguageFallback?: boolean;
  /** Explicit tag list overrides topN computation. Useful when the UI has
   *  already filtered and wants the heatmap to reflect exactly that set. */
  tags?: string[];
};

/**
 * Aggregate `gh_repo_tag ⋈ gh_star` into a tag × time-bucket matrix.
 * Returns `xs` (time buckets, ascending) and `ys` (tags, sorted by total
 * count desc) plus a dense 2D `cells` array for direct SVG consumption.
 *
 * Bucket keys use lexicographically-sortable prefixes:
 *   month   → 'YYYY-MM'
 *   quarter → 'YYYY-Qn'  (Q1/Q2/Q3/Q4 sort correctly as plain strings)
 *   year    → 'YYYY'
 */
export function getTagTimeHeatmap(
  db: Database.Database,
  args: HeatmapArgs = {}
): TagHeatmapResult {
  const grain = args.grain ?? "month";
  const topN = Math.min(50, Math.max(1, args.topN ?? 15));
  const includeFallback = args.includeLanguageFallback ?? false;

  const baseFilters: string[] = [];
  const baseParams: unknown[] = [];
  if (!includeFallback) {
    baseFilters.push("t.source = 'topic'");
  }
  if (args.from) {
    baseFilters.push("s.starred_at >= ?");
    baseParams.push(args.from);
  }
  if (args.to) {
    baseFilters.push("s.starred_at < ?");
    baseParams.push(args.to);
  }
  let tags: string[];
  if (args.tags && args.tags.length > 0) {
    tags = Array.from(new Set(args.tags.map((t) => t.toLowerCase())));
  } else {
    const tagFilters = [...baseFilters];
    const tagParams = [...baseParams];
    const tagWhere =
      tagFilters.length > 0 ? ` WHERE ${tagFilters.join(" AND ")}` : "";
    const topRows = db
      .prepare(
        `SELECT t.tag AS tag, COUNT(*) AS count
         FROM gh_repo_tag t
         JOIN gh_star s ON s.repo_id = t.repo_id${tagWhere}
         GROUP BY t.tag
         ORDER BY count DESC
         LIMIT ?`
      )
      .all(...tagParams, topN) as { tag: string; count: number }[];
    tags = topRows.map((r) => r.tag);
  }
  if (tags.length === 0) {
    return { xs: [], ys: [], cells: [] };
  }

  const bucketSql =
    grain === "year"
      ? "substr(s.starred_at, 1, 4)"
      : grain === "quarter"
        ? "substr(s.starred_at, 1, 4) || '-Q' || ((CAST(substr(s.starred_at, 6, 2) AS INTEGER) - 1) / 3 + 1)"
        : "substr(s.starred_at, 1, 7)";

  const placeholders = tags.map(() => "?").join(", ");
  const whereClauses = [...baseFilters, `t.tag IN (${placeholders})`];
  const whereParams = [...baseParams, ...tags];
  const where =
    whereClauses.length > 0 ? ` WHERE ${whereClauses.join(" AND ")}` : "";

  const rows = db
    .prepare(
      `SELECT t.tag AS tag, ${bucketSql} AS bucket, COUNT(*) AS count
       FROM gh_repo_tag t
       JOIN gh_star s ON s.repo_id = t.repo_id${where}
       GROUP BY t.tag, bucket
       ORDER BY bucket ASC`
    )
    .all(...whereParams) as HeatmapCell[];

  const bucketSet = new Set<string>();
  for (const r of rows) bucketSet.add(r.bucket);
  const xs = Array.from(bucketSet).sort();

  const totalByTag = new Map<string, number>();
  for (const r of rows) {
    totalByTag.set(r.tag, (totalByTag.get(r.tag) ?? 0) + r.count);
  }
  const ys = [...tags].sort(
    (a, b) => (totalByTag.get(b) ?? 0) - (totalByTag.get(a) ?? 0)
  );

  const xIndex = new Map(xs.map((x, i) => [x, i] as const));
  const yIndex = new Map(ys.map((y, i) => [y, i] as const));
  const cells: number[][] = ys.map(() => xs.map(() => 0));
  for (const r of rows) {
    const i = yIndex.get(r.tag);
    const j = xIndex.get(r.bucket);
    if (i != null && j != null) cells[i][j] = r.count;
  }

  return { xs, ys, cells };
}

export type TaggedReposArgs = {
  tags: string[];
  /** 'or' = union (any match), 'and' = intersection (all required). */
  mode?: "or" | "and";
  from?: string | null;
  to?: string | null;
  /** Keyset cursor = last row's `starred_at`. Omit for first page. */
  cursor?: string | null;
  perPage?: number;
};

type TaggedStarDbRow = {
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
  matched_tags: string;
};

/**
 * Keyset-paginated repo list filtered by tag set + time window.
 *
 * OR (union): EXISTS subquery against `gh_repo_tag` where tag IN (...).
 * AND (intersection): GROUP BY repo_id HAVING COUNT(DISTINCT tag) = N.
 *
 * We also emit `matched_tags` per row (the subset of the user's selected
 * tags that this repo actually has) so the UI can render "matched: [python,
 * agent]" chips under each card. This costs one extra JOIN + GROUP_CONCAT
 * but saves the UI from making a second round-trip.
 */
export function listTaggedRepos(
  db: Database.Database,
  args: TaggedReposArgs
): TaggedReposResult {
  const perPage = Math.min(100, Math.max(1, args.perPage ?? 30));
  const mode = args.mode ?? "or";
  const tags = Array.from(
    new Set(args.tags.map((t) => t.trim().toLowerCase()).filter((t) => t.length > 0))
  );
  if (tags.length === 0) {
    return { items: [], nextCursor: null };
  }

  const placeholders = tags.map(() => "?").join(", ");
  const filters: string[] = [];
  const params: unknown[] = [];

  if (args.from) {
    filters.push("s.starred_at >= ?");
    params.push(args.from);
  }
  if (args.to) {
    filters.push("s.starred_at < ?");
    params.push(args.to);
  }
  if (args.cursor) {
    filters.push("s.starred_at < ?");
    params.push(args.cursor);
  }

  const idSubquery =
    mode === "and"
      ? `SELECT repo_id FROM gh_repo_tag WHERE tag IN (${placeholders})
         GROUP BY repo_id HAVING COUNT(DISTINCT tag) = ?`
      : `SELECT DISTINCT repo_id FROM gh_repo_tag WHERE tag IN (${placeholders})`;
  const idSubParams: unknown[] = mode === "and" ? [...tags, tags.length] : [...tags];

  filters.push(`s.repo_id IN (${idSubquery})`);
  params.push(...idSubParams);

  const where = filters.length > 0 ? ` WHERE ${filters.join(" AND ")}` : "";

  const matchedTagsSubquery = `(
    SELECT GROUP_CONCAT(tag, ',') FROM gh_repo_tag
    WHERE repo_id = s.repo_id AND tag IN (${placeholders})
  )`;
  const matchedParams: unknown[] = [...tags];

  const sql = `
    SELECT s.repo_id, s.owner, s.name, s.full_name, s.description, s.html_url,
           s.language, s.topics_json, s.stargazers_count, s.starred_at,
           ${matchedTagsSubquery} AS matched_tags
    FROM gh_star s${where}
    ORDER BY s.starred_at DESC, s.repo_id DESC
    LIMIT ?`;
  const allParams = [...matchedParams, ...params, perPage];
  const rows = db.prepare(sql).all(...allParams) as TaggedStarDbRow[];

  const items: TaggedRepoRow[] = rows.map((r) => ({
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
    matched_tags: (r.matched_tags ?? "")
      .split(",")
      .map((t) => t.trim())
      .filter((t) => t.length > 0),
  }));
  const nextCursor =
    rows.length === perPage ? rows[rows.length - 1].starred_at : null;
  return { items, nextCursor };
}
