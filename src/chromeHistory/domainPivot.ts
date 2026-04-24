import type Database from "better-sqlite3";
import {
  DOMAIN_RULE_VERSION,
  chromeHistoryUrlIdentity,
  type ChromeHistoryUrlKind,
} from "./domain.js";

export type ChromeHistoryDomainState = {
  profile: string;
  rule_version: number;
  last_rebuilt_at: string | null;
  last_error: string | null;
  source_visit_count: number;
  derived_visit_count: number;
  last_rebuild_duration_ms: number | null;
  updated_at: string;
};

export type ChromeHistoryDomainStatus = {
  profile: string;
  ruleVersion: number;
  state: ChromeHistoryDomainState | null;
  currentSourceVisitCount: number;
  currentDerivedVisitCount: number;
  fresh: boolean;
  staleReasons: string[];
};

export type RebuildChromeHistoryDomainsResult = {
  profile: string;
  ruleVersion: number;
  sourceVisitCount: number;
  derivedVisitCount: number;
  durationMs: number;
  ok: boolean;
  error: string | null;
};

export type ChromeHistoryDomainKind = ChromeHistoryUrlKind | "all";

type DomainSourceRow = {
  profile: string;
  source_id: string;
  visit_id: number;
  url_id: number;
  content_key: string;
  url: string;
  calendar_day: string;
  visit_time: number;
};

function nowIso(): string {
  return new Date().toISOString();
}

function sourceVisitCount(db: Database.Database, profile: string): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS c
       FROM chrome_history_visits
       WHERE profile = ?`
    )
    .get(profile) as { c: number };
  return row.c;
}

function derivedVisitCount(db: Database.Database, profile: string): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS c
       FROM chrome_history_visit_domains
       WHERE profile = ?`
    )
    .get(profile) as { c: number };
  return row.c;
}

function upsertDomainState(
  db: Database.Database,
  profile: string,
  values: {
    rebuiltAt: string | null;
    error: string | null;
    sourceCount: number;
    derivedCount: number;
    durationMs: number | null;
    updatedAt: string;
  }
): void {
  db.prepare(
    `INSERT INTO chrome_history_domain_state (
       profile, rule_version, last_rebuilt_at, last_error, source_visit_count,
       derived_visit_count, last_rebuild_duration_ms, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(profile) DO UPDATE SET
       rule_version = excluded.rule_version,
       last_rebuilt_at = excluded.last_rebuilt_at,
       last_error = excluded.last_error,
       source_visit_count = excluded.source_visit_count,
       derived_visit_count = excluded.derived_visit_count,
       last_rebuild_duration_ms = excluded.last_rebuild_duration_ms,
       updated_at = excluded.updated_at`
  ).run(
    profile,
    DOMAIN_RULE_VERSION,
    values.rebuiltAt,
    values.error,
    values.sourceCount,
    values.derivedCount,
    values.durationMs,
    values.updatedAt
  );
}

export function rebuildChromeHistoryVisitDomains(
  db: Database.Database,
  profile: string
): RebuildChromeHistoryDomainsResult {
  const started = Date.now();
  const updatedAt = nowIso();
  try {
    let sourceCount = 0;
    let derivedCount = 0;
    const run = db.transaction(() => {
      db.prepare("DELETE FROM chrome_history_visit_domains WHERE profile = ?").run(profile);
      const rows = db
        .prepare(
          `SELECT v.profile, v.source_id, v.id AS visit_id, v.url_id,
                  v.content_key, u.url, v.calendar_day, v.visit_time
           FROM chrome_history_visits v
           INNER JOIN chrome_history_urls u
             ON u.profile = v.profile
            AND u.source_id = v.source_id
            AND u.id = v.url_id
           WHERE v.profile = ?
           ORDER BY v.source_id, v.id`
        )
        .all(profile) as DomainSourceRow[];
      sourceCount = rows.length;
      const insert = db.prepare(
        `INSERT INTO chrome_history_visit_domains (
          profile, source_id, visit_id, url_id, content_key, url_kind, scheme,
          host, domain, origin, calendar_day, visit_time, inserted_at
        ) VALUES (
          @profile, @source_id, @visit_id, @url_id, @content_key, @url_kind,
          @scheme, @host, @domain, @origin, @calendar_day, @visit_time, @inserted_at
        )`
      );
      for (const row of rows) {
        const ident = chromeHistoryUrlIdentity(row.url);
        insert.run({
          profile: row.profile,
          source_id: row.source_id,
          visit_id: row.visit_id,
          url_id: row.url_id,
          content_key: row.content_key,
          url_kind: ident.urlKind,
          scheme: ident.scheme,
          host: ident.host,
          domain: ident.domain,
          origin: ident.origin,
          calendar_day: row.calendar_day,
          visit_time: row.visit_time,
          inserted_at: updatedAt,
        });
        derivedCount += 1;
      }
      upsertDomainState(db, profile, {
        rebuiltAt: updatedAt,
        error: null,
        sourceCount,
        derivedCount,
        durationMs: Date.now() - started,
        updatedAt,
      });
    });
    run();
    return {
      profile,
      ruleVersion: DOMAIN_RULE_VERSION,
      sourceVisitCount: sourceCount,
      derivedVisitCount: derivedCount,
      durationMs: Date.now() - started,
      ok: true,
      error: null,
    };
  } catch (e) {
    const sourceCount = sourceVisitCount(db, profile);
    let derivedCount = 0;
    try {
      derivedCount = derivedVisitCount(db, profile);
    } catch {
      derivedCount = 0;
    }
    const error = e instanceof Error ? e.message : String(e);
    upsertDomainState(db, profile, {
      rebuiltAt: null,
      error,
      sourceCount,
      derivedCount,
      durationMs: Date.now() - started,
      updatedAt: nowIso(),
    });
    return {
      profile,
      ruleVersion: DOMAIN_RULE_VERSION,
      sourceVisitCount: sourceCount,
      derivedVisitCount: derivedCount,
      durationMs: Date.now() - started,
      ok: false,
      error,
    };
  }
}

export function getChromeHistoryDomainStatus(
  db: Database.Database,
  profile: string
): ChromeHistoryDomainStatus {
  const state = db
    .prepare(
      `SELECT profile, rule_version, last_rebuilt_at, last_error,
              source_visit_count, derived_visit_count,
              last_rebuild_duration_ms, updated_at
       FROM chrome_history_domain_state
       WHERE profile = ?`
    )
    .get(profile) as ChromeHistoryDomainState | undefined;
  const currentSourceVisitCount = sourceVisitCount(db, profile);
  const currentDerivedVisitCount = derivedVisitCount(db, profile);
  const staleReasons: string[] = [];
  if (!state) staleReasons.push("not_built");
  if (state && state.rule_version !== DOMAIN_RULE_VERSION) {
    staleReasons.push("rule_version_mismatch");
  }
  if (state?.last_error) staleReasons.push("last_rebuild_error");
  if (state && state.source_visit_count !== currentSourceVisitCount) {
    staleReasons.push("source_count_changed");
  }
  if (state && state.derived_visit_count !== currentDerivedVisitCount) {
    staleReasons.push("derived_count_changed");
  }
  if (
    state &&
    !state.last_error &&
    currentSourceVisitCount !== currentDerivedVisitCount
  ) {
    staleReasons.push("source_derived_count_mismatch");
  }
  return {
    profile,
    ruleVersion: DOMAIN_RULE_VERSION,
    state: state ?? null,
    currentSourceVisitCount,
    currentDerivedVisitCount,
    fresh: staleReasons.length === 0,
    staleReasons,
  };
}

type DomainFilterArgs = {
  profile: string;
  from?: string | null;
  to?: string | null;
  kind?: ChromeHistoryDomainKind;
};

function addDomainFilters(
  args: DomainFilterArgs,
  alias?: string
): { where: string; params: unknown[] } {
  const col = (name: string) => (alias ? `${alias}.${name}` : name);
  const clauses = [`${col("profile")} = ?`];
  const params: unknown[] = [args.profile];
  if (args.kind && args.kind !== "all") {
    clauses.push(`${col("url_kind")} = ?`);
    params.push(args.kind);
  }
  if (args.from) {
    clauses.push(`${col("calendar_day")} >= ?`);
    params.push(args.from);
  }
  if (args.to) {
    clauses.push(`${col("calendar_day")} < ?`);
    params.push(args.to);
  }
  return { where: `WHERE ${clauses.join(" AND ")}`, params };
}

export type ChromeHistoryDomainSummary = {
  unique_domains: number;
  total_visits: number;
  top_domain: { domain: string; count: number } | null;
};

export function getChromeHistoryDomainSummary(
  db: Database.Database,
  args: DomainFilterArgs
): ChromeHistoryDomainSummary {
  const { where, params } = addDomainFilters({ ...args, kind: args.kind ?? "web" });
  const summary = db
    .prepare(
      `SELECT COUNT(DISTINCT domain) AS unique_domains, COUNT(*) AS total_visits
       FROM chrome_history_visit_domains
       ${where}
         AND domain IS NOT NULL`
    )
    .get(...params) as { unique_domains: number; total_visits: number };
  const top = db
    .prepare(
      `SELECT domain, COUNT(*) AS count
       FROM chrome_history_visit_domains
       ${where}
         AND domain IS NOT NULL
       GROUP BY domain
       ORDER BY count DESC, MAX(calendar_day) DESC, domain ASC
       LIMIT 1`
    )
    .get(...params) as { domain: string; count: number } | undefined;
  return {
    unique_domains: summary.unique_domains,
    total_visits: summary.total_visits,
    top_domain: top ?? null,
  };
}

export type ChromeHistoryTopDomain = {
  domain: string;
  count: number;
  first_visit_day: string;
  last_visit_day: string;
};

export function getTopChromeHistoryDomains(
  db: Database.Database,
  args: DomainFilterArgs & { limit?: number }
): ChromeHistoryTopDomain[] {
  const limit = Math.min(500, Math.max(1, args.limit ?? 50));
  const { where, params } = addDomainFilters({ ...args, kind: args.kind ?? "web" });
  return db
    .prepare(
      `SELECT domain, COUNT(*) AS count,
              MIN(calendar_day) AS first_visit_day,
              MAX(calendar_day) AS last_visit_day
       FROM chrome_history_visit_domains
       ${where}
         AND domain IS NOT NULL
       GROUP BY domain
       ORDER BY count DESC, last_visit_day DESC, domain ASC
       LIMIT ?`
    )
    .all(...params, limit) as ChromeHistoryTopDomain[];
}

export type ChromeHistoryTimelineGrain = "day" | "week" | "month";

export type ChromeHistoryDomainTimeline = {
  xs: string[];
  ys: string[];
  cells: number[][];
};

function bucketSql(grain: ChromeHistoryTimelineGrain): string {
  if (grain === "month") return "substr(calendar_day, 1, 7)";
  if (grain === "week") {
    return "date(calendar_day, '-' || ((CAST(strftime('%w', calendar_day) AS INTEGER) + 6) % 7) || ' days')";
  }
  return "calendar_day";
}

export function getChromeHistoryDomainTimeline(
  db: Database.Database,
  args: DomainFilterArgs & {
    grain?: ChromeHistoryTimelineGrain;
    domains?: string[];
    top?: number;
  }
): ChromeHistoryDomainTimeline {
  const grain = args.grain ?? "day";
  const top = Math.min(50, Math.max(1, args.top ?? 15));
  const normalizedDomains = Array.from(
    new Set((args.domains ?? []).map((d) => d.trim().toLowerCase()).filter(Boolean))
  );
  const base = addDomainFilters({ ...args, kind: args.kind ?? "web" });
  let domains = normalizedDomains;
  if (domains.length === 0) {
    const topRows = db
      .prepare(
        `SELECT domain, COUNT(*) AS count, MAX(calendar_day) AS last_visit_day
         FROM chrome_history_visit_domains
         ${base.where}
           AND domain IS NOT NULL
         GROUP BY domain
         ORDER BY count DESC, last_visit_day DESC, domain ASC
         LIMIT ?`
      )
      .all(...base.params, top) as { domain: string }[];
    domains = topRows.map((r) => r.domain);
  }
  if (domains.length === 0) return { xs: [], ys: [], cells: [] };

  const placeholders = domains.map(() => "?").join(", ");
  const sqlBucket = bucketSql(grain);
  const rows = db
    .prepare(
      `SELECT domain, ${sqlBucket} AS bucket, COUNT(*) AS count
       FROM chrome_history_visit_domains
       ${base.where}
         AND domain IN (${placeholders})
       GROUP BY domain, bucket
       ORDER BY bucket ASC`
    )
    .all(...base.params, ...domains) as {
    domain: string;
    bucket: string;
    count: number;
  }[];

  const xs = Array.from(new Set(rows.map((r) => r.bucket))).sort();
  const totalByDomain = new Map<string, number>();
  for (const row of rows) {
    totalByDomain.set(row.domain, (totalByDomain.get(row.domain) ?? 0) + row.count);
  }
  const ys = [...domains].sort(
    (a, b) => (totalByDomain.get(b) ?? 0) - (totalByDomain.get(a) ?? 0) || a.localeCompare(b)
  );
  const xIndex = new Map(xs.map((x, i) => [x, i] as const));
  const yIndex = new Map(ys.map((y, i) => [y, i] as const));
  const cells = ys.map(() => xs.map(() => 0));
  for (const row of rows) {
    const i = yIndex.get(row.domain);
    const j = xIndex.get(row.bucket);
    if (i != null && j != null) cells[i][j] = row.count;
  }
  return { xs, ys, cells };
}

export type ChromeHistoryDomainVisit = {
  visit_id: number;
  source_id: string;
  url_id: number;
  domain: string | null;
  url_kind: ChromeHistoryUrlKind;
  url: string;
  title: string | null;
  visit_time: number;
  transition: number | null;
  calendar_day: string;
  inserted_at: string;
};

export type ListChromeHistoryDomainVisitsResult = {
  items: ChromeHistoryDomainVisit[];
  nextCursor: string | null;
};

export function listChromeHistoryDomainVisits(
  db: Database.Database,
  args: DomainFilterArgs & {
    domain?: string | null;
    q?: string | null;
    cursor?: string | null;
    perPage?: number;
  }
): ListChromeHistoryDomainVisitsResult {
  const perPage = Math.min(100, Math.max(1, args.perPage ?? 50));
  const filters = addDomainFilters({ ...args, kind: args.kind ?? "web" }, "d");
  const clauses = [filters.where.replace(/^WHERE /, "")];
  const params = [...filters.params];
  if (args.domain) {
    clauses.push("d.domain = ?");
    params.push(args.domain.trim().toLowerCase());
  }
  if (args.cursor) {
    const [visitTime, sourceId, visitId] = args.cursor.split("|");
    if (visitTime && sourceId && visitId && /^\d+$/.test(visitTime) && /^\d+$/.test(visitId)) {
      clauses.push(
        `(d.visit_time < ? OR (d.visit_time = ? AND (d.source_id < ? OR (d.source_id = ? AND d.visit_id < ?))))`
      );
      params.push(Number(visitTime), Number(visitTime), sourceId, sourceId, Number(visitId));
    }
  }
  if (args.q?.trim()) {
    const like = `%${args.q.trim()}%`;
    clauses.push("(u.url LIKE ? OR u.title LIKE ?)");
    params.push(like, like);
  }
  const rows = db
    .prepare(
      `SELECT d.visit_id, d.source_id, d.url_id, d.domain, d.url_kind,
              u.url, u.title, d.visit_time, v.transition, d.calendar_day,
              v.inserted_at
       FROM chrome_history_visit_domains d
       INNER JOIN chrome_history_urls u
         ON u.profile = d.profile AND u.source_id = d.source_id AND u.id = d.url_id
       INNER JOIN chrome_history_visits v
         ON v.profile = d.profile AND v.source_id = d.source_id AND v.id = d.visit_id
       WHERE ${clauses.join(" AND ")}
       ORDER BY d.visit_time DESC, d.source_id DESC, d.visit_id DESC
       LIMIT ?`
    )
    .all(...params, perPage) as ChromeHistoryDomainVisit[];
  const last = rows.length === perPage ? rows[rows.length - 1] : null;
  return {
    items: rows,
    nextCursor: last ? `${last.visit_time}|${last.source_id}|${last.visit_id}` : null,
  };
}
