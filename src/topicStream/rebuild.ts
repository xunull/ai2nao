import type Database from "better-sqlite3";
import { chromeHistoryUrlIdentity } from "../chromeHistory/domain.js";
import { chromeWebkitUsToUnixMs } from "../chromeHistory/time.js";
import { OTHER_CATEGORY, classifyIdentity, type TopicCategory } from "./classify.js";
import { readTopicStreamConfig } from "./config.js";
import { sessionize } from "./sessionize.js";
import { coreTransition, isNoiseVisit } from "./transition.js";

/** Sentinel rule_version recorded when the taxonomy config fails to load. */
const CONFIG_ERROR_VERSION = "config_error";

/** Core transitions that make a visit a good "what was this session about" anchor. */
const ANCHOR_CORES = new Set(["typed", "generated", "keyword", "keyword_generated"]);

const US_PER_MINUTE = 60_000_000;

/** Source ids for the topic-stream adapters. */
export const CHROME_SOURCE = "chrome";
export const GIT_SOURCE = "git";
/** git has no per-profile concept; use the topic_stream no-profile convention. */
const GIT_PROFILE = "-";
/** Bump when the git band rule (Top-N / catch-all) changes, to trip freshness. */
const GIT_RULE_VERSION = "git-repo-v1";
/** Number of top repos kept as their own bands; the rest fold into 其他. */
const GIT_TOP_N = 12;

/** Conversation adapter (3rd source): AI-chat topic river from cleaned user messages. */
export const CONVERSATION_SOURCE = "conversation";
/** conversation has no per-profile concept; use the no-profile convention. */
export const CONVERSATION_PROFILE = "-";
/**
 * Active conversation codebook version. `cluster-vN` — bump (via --recluster on
 * a new N) reclusters and reshuffles bands; otherwise new sessions assign to the
 * frozen centroids of this version and bands stay stable across rebuilds.
 */
export const CONVERSATION_RULE_VERSION = "cluster-v1";

export type TopicStreamEvent = {
  sourceRef: string;
  sessionId: string | null;
  category: string;
  calendarDay: string;
  eventTime: number;
  payload: Record<string, unknown>;
};

export type TopicRebuildDiagnostic = {
  total_source: number;
  total_kept: number;
  filtered_non_web: number;
  filtered_transition: Record<string, number>;
  category_counts: Record<string, number>;
  other_share: number;
  top_unmatched_domains: { domain: string; count: number }[];
};

export type TopicStreamState = {
  source: string;
  profile: string;
  rule_version: string;
  last_rebuilt_at: string | null;
  last_error: string | null;
  source_event_count: number;
  derived_event_count: number;
  last_rebuild_duration_ms: number | null;
  updated_at: string;
};

export type TopicStreamStatus = {
  source: string;
  profile: string;
  ruleVersion: string;
  state: TopicStreamState | null;
  currentSourceCount: number;
  currentDerivedCount: number;
  fresh: boolean;
  staleReasons: string[];
};

export type RebuildTopicStreamResult = {
  source: string;
  profile: string;
  ruleVersion: string;
  sourceCount: number;
  derivedCount: number;
  durationMs: number;
  ok: boolean;
  error: string | null;
  diagnostic: TopicRebuildDiagnostic | null;
};

type ChromeVisitRow = {
  source_id: string;
  visit_id: number;
  from_visit: number;
  url: string;
  title: string | null;
  transition: number | null;
  calendar_day: string;
  visit_time: number;
};

export function nowIso(): string {
  return new Date().toISOString();
}

function chromeSourceCount(db: Database.Database, profile: string): number {
  const row = db
    .prepare(`SELECT COUNT(*) AS c FROM chrome_history_visits WHERE profile = ?`)
    .get(profile) as { c: number };
  return row.c;
}

export function derivedCount(db: Database.Database, source: string, profile: string): number {
  const row = db
    .prepare(`SELECT COUNT(*) AS c FROM topic_stream WHERE source = ? AND profile = ?`)
    .get(source, profile) as { c: number };
  return row.c;
}

function gitSourceCount(db: Database.Database): number {
  const row = db.prepare(`SELECT COUNT(*) AS c FROM git_commits`).get() as { c: number };
  return row.c;
}

/** Eligible conversation sessions = distinct (source, session) with human messages. */
function conversationSourceCount(db: Database.Database): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS c FROM (
         SELECT source, source_session_id FROM agent_user_messages
         WHERE is_human = 1 AND source IN ('claude', 'codex', 'opencode')
         GROUP BY source, source_session_id
       )`
    )
    .get() as { c: number };
  return row.c;
}

/** Local calendar day `YYYY-MM-DD` from an ISO/UTC timestamp (matches chrome's local day). */
export function localDayFromIso(iso: string): string {
  const d = new Date(iso);
  const y = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${mo}-${day}`;
}

/**
 * Build the kept, session-labelled topic events for the browsing adapter, plus
 * a diagnostic. Stage 2: segment visits into research sessions (from_visit +
 * gap) over the FULL set first, then drop transition noise, and label every
 * kept web visit with its session's ANCHOR category (the first typed/keyword
 * web visit of the session, else the first web visit).
 */
function buildChromeTopicEvents(
  db: Database.Database,
  profile: string,
  taxonomy: TopicCategory[],
  gapMinutes: number
): { events: TopicStreamEvent[]; sourceCount: number; diagnostic: TopicRebuildDiagnostic } {
  const rows = db
    .prepare(
      `SELECT v.source_id, v.id AS visit_id, v.from_visit, u.url, u.title,
              v.transition, v.calendar_day, v.visit_time
       FROM chrome_history_visits v
       INNER JOIN chrome_history_urls u
         ON u.profile = v.profile
        AND u.source_id = v.source_id
        AND u.id = v.url_id
       WHERE v.profile = ?
       ORDER BY v.source_id, v.visit_time, v.id`
    )
    .all(profile) as ChromeVisitRow[];

  const gapUs = Math.max(1, gapMinutes) * US_PER_MINUTE;

  // Group by source_id (from_visit ids are only meaningful within one import).
  const groups = new Map<string, ChromeVisitRow[]>();
  for (const row of rows) {
    const g = groups.get(row.source_id);
    if (g) g.push(row);
    else groups.set(row.source_id, [row]);
  }

  const events: TopicStreamEvent[] = [];
  const categoryCounts: Record<string, number> = {};
  const filteredTransition: Record<string, number> = {};
  const unmatched = new Map<string, number>();
  let filteredNonWeb = 0;

  for (const [sourceId, groupRows] of groups) {
    const sessionKey = sessionize(
      groupRows.map((r) => ({ id: r.visit_id, fromVisit: r.from_visit, visitTime: r.visit_time })),
      gapUs
    );
    const fullSession = (visitId: number): string => `${sourceId}:${sessionKey.get(visitId) ?? `s${visitId}`}`;

    // Anchor category per session: first typed/keyword web visit (in time order,
    // groupRows already sorted by visit_time), else first web visit.
    const anchor = new Map<string, { category: string; typed: boolean }>();
    for (const row of groupRows) {
      const identity = chromeHistoryUrlIdentity(row.url);
      if (identity.urlKind !== "web") continue;
      const sid = fullSession(row.visit_id);
      const isTyped = ANCHOR_CORES.has(coreTransition(row.transition));
      const existing = anchor.get(sid);
      if (!existing) {
        anchor.set(sid, {
          category: classifyIdentity(identity, row.title, taxonomy),
          typed: isTyped,
        });
      } else if (!existing.typed && isTyped) {
        anchor.set(sid, {
          category: classifyIdentity(identity, row.title, taxonomy),
          typed: true,
        });
      }
    }

    // Emit rows for kept (web, non-noise) visits, labelled by session category.
    for (const row of groupRows) {
      const identity = chromeHistoryUrlIdentity(row.url);
      if (identity.urlKind !== "web") {
        filteredNonWeb += 1;
        continue;
      }
      if (isNoiseVisit(row.transition)) {
        const core = coreTransition(row.transition);
        filteredTransition[core] = (filteredTransition[core] ?? 0) + 1;
        continue;
      }
      const sid = fullSession(row.visit_id);
      const category = anchor.get(sid)?.category ?? OTHER_CATEGORY;
      categoryCounts[category] = (categoryCounts[category] ?? 0) + 1;
      if (category === OTHER_CATEGORY && identity.domain) {
        unmatched.set(identity.domain, (unmatched.get(identity.domain) ?? 0) + 1);
      }
      events.push({
        sourceRef: `${sourceId}|${row.visit_id}`,
        sessionId: sid,
        category,
        calendarDay: row.calendar_day,
        eventTime: chromeWebkitUsToUnixMs(row.visit_time),
        payload: {
          host: identity.host,
          domain: identity.domain,
          url: row.url,
          title: row.title,
          transition: row.transition,
        },
      });
    }
  }

  const topUnmatched = [...unmatched.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 20)
    .map(([domain, count]) => ({ domain, count }));

  const totalKept = events.length;
  const otherShare = totalKept > 0 ? (categoryCounts[OTHER_CATEGORY] ?? 0) / totalKept : 0;

  return {
    events,
    sourceCount: rows.length,
    diagnostic: {
      total_source: rows.length,
      total_kept: totalKept,
      filtered_non_web: filteredNonWeb,
      filtered_transition: filteredTransition,
      category_counts: categoryCounts,
      other_share: otherShare,
      top_unmatched_domains: topUnmatched,
    },
  };
}

export function upsertState(
  db: Database.Database,
  source: string,
  profile: string,
  values: {
    ruleVersion: string;
    rebuiltAt: string | null;
    error: string | null;
    sourceCount: number;
    derivedCount: number;
    durationMs: number | null;
    updatedAt: string;
  }
): void {
  db.prepare(
    `INSERT INTO topic_stream_state (
       source, profile, rule_version, last_rebuilt_at, last_error,
       source_event_count, derived_event_count, last_rebuild_duration_ms, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(source, profile) DO UPDATE SET
       rule_version = excluded.rule_version,
       last_rebuilt_at = excluded.last_rebuilt_at,
       last_error = excluded.last_error,
       source_event_count = excluded.source_event_count,
       derived_event_count = excluded.derived_event_count,
       last_rebuild_duration_ms = excluded.last_rebuild_duration_ms,
       updated_at = excluded.updated_at`
  ).run(
    source,
    profile,
    values.ruleVersion,
    values.rebuiltAt,
    values.error,
    values.sourceCount,
    values.derivedCount,
    values.durationMs,
    values.updatedAt
  );
}

/** Shared: clear + reinsert one (source, profile) slice + upsert freshness, in one txn. */
export function persistTopicStream(
  db: Database.Database,
  args: {
    source: string;
    profile: string;
    ruleVersion: string;
    events: TopicStreamEvent[];
    sourceCount: number;
    started: number;
    updatedAt: string;
  }
): number {
  let derived = 0;
  const run = db.transaction(() => {
    db.prepare(`DELETE FROM topic_stream WHERE source = ? AND profile = ?`).run(
      args.source,
      args.profile
    );
    const insert = db.prepare(
      `INSERT INTO topic_stream (
        source, profile, source_ref, session_id, category, calendar_day, event_time,
        weight, payload, inserted_at
      ) VALUES (
        @source, @profile, @source_ref, @session_id, @category, @calendar_day, @event_time,
        1, @payload, @inserted_at
      )`
    );
    for (const ev of args.events) {
      insert.run({
        source: args.source,
        profile: args.profile,
        source_ref: ev.sourceRef,
        session_id: ev.sessionId,
        category: ev.category,
        calendar_day: ev.calendarDay,
        event_time: ev.eventTime,
        payload: JSON.stringify(ev.payload),
        inserted_at: args.updatedAt,
      });
      derived += 1;
    }
    upsertState(db, args.source, args.profile, {
      ruleVersion: args.ruleVersion,
      rebuiltAt: args.updatedAt,
      error: null,
      sourceCount: args.sourceCount,
      derivedCount: derived,
      durationMs: Date.now() - args.started,
      updatedAt: args.updatedAt,
    });
  });
  run();
  return derived;
}

/**
 * Rebuild the browsing topic stream for one profile. Clears + reinserts only
 * this `(chrome, profile)` slice inside a single transaction (multi-profile
 * safe). Idempotent: same source data + same taxonomy => same rows.
 */
export function rebuildChromeTopicStream(
  db: Database.Database,
  profile: string,
  configPath?: string
): RebuildTopicStreamResult {
  const started = Date.now();
  const updatedAt = nowIso();

  const cfg = readTopicStreamConfig(configPath);
  if (!cfg.ok) {
    // Invalid taxonomy config: do NOT touch existing rows (Atuin-style). Record
    // the error so the UI can show config_error and keep old analytics.
    const error = `config_error: ${cfg.issues
      .map((i) => `${i.path}: ${i.message}`)
      .join("; ")}`;
    const sourceCount = chromeSourceCount(db, profile);
    let derived = 0;
    try {
      derived = derivedCount(db, CHROME_SOURCE, profile);
    } catch {
      derived = 0;
    }
    upsertState(db, CHROME_SOURCE, profile, {
      ruleVersion: CONFIG_ERROR_VERSION,
      rebuiltAt: null,
      error,
      sourceCount,
      derivedCount: derived,
      durationMs: Date.now() - started,
      updatedAt,
    });
    return {
      source: CHROME_SOURCE,
      profile,
      ruleVersion: CONFIG_ERROR_VERSION,
      sourceCount,
      derivedCount: derived,
      durationMs: Date.now() - started,
      ok: false,
      error,
      diagnostic: null,
    };
  }
  const taxonomy = cfg.categories;
  const ruleVersion = cfg.hash;
  const gapMinutes = cfg.gapMinutes;
  try {
    const built = buildChromeTopicEvents(db, profile, taxonomy, gapMinutes);
    const derived = persistTopicStream(db, {
      source: CHROME_SOURCE,
      profile,
      ruleVersion,
      events: built.events,
      sourceCount: built.sourceCount,
      started,
      updatedAt,
    });
    return {
      source: CHROME_SOURCE,
      profile,
      ruleVersion,
      sourceCount: built.sourceCount,
      derivedCount: derived,
      durationMs: Date.now() - started,
      ok: true,
      error: null,
      diagnostic: built.diagnostic,
    };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    const sourceCount = chromeSourceCount(db, profile);
    let derived = 0;
    try {
      derived = derivedCount(db, CHROME_SOURCE, profile);
    } catch {
      derived = 0;
    }
    upsertState(db, CHROME_SOURCE, profile, {
      ruleVersion,
      rebuiltAt: null,
      error,
      sourceCount,
      derivedCount: derived,
      durationMs: Date.now() - started,
      updatedAt: nowIso(),
    });
    return {
      source: CHROME_SOURCE,
      profile,
      ruleVersion,
      sourceCount,
      derivedCount: derived,
      durationMs: Date.now() - started,
      ok: false,
      error,
      diagnostic: null,
    };
  }
}

type GitCommitRow = {
  repo_key: string;
  commit_hash: string;
  author_date_utc: string;
  subject: string | null;
  added: number;
  deleted: number;
  files_changed: number;
};

/**
 * Build git commit events: band = repo_key (Top-N by commit count, the rest fold
 * into 其他). One commit = one event. event_time is Unix ms (source-agnostic).
 */
function buildGitTopicEvents(
  db: Database.Database
): { events: TopicStreamEvent[]; sourceCount: number; diagnostic: TopicRebuildDiagnostic } {
  const rows = db
    .prepare(
      `SELECT repo_key, commit_hash, author_date_utc, subject, added, deleted, files_changed
       FROM git_commits
       ORDER BY author_date_utc, commit_hash`
    )
    .all() as GitCommitRow[];

  // Band = repo basename (short + avoids leaking absolute home paths into the UI).
  const bandOf = (repoKey: string): string => {
    const parts = repoKey.replace(/[/\\]+$/, "").split(/[/\\]/);
    return parts[parts.length - 1] || repoKey;
  };

  const counts = new Map<string, number>();
  for (const r of rows) {
    const band = bandOf(r.repo_key);
    counts.set(band, (counts.get(band) ?? 0) + 1);
  }
  const topRepos = new Set(
    [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, GIT_TOP_N)
      .map(([k]) => k)
  );

  const events: TopicStreamEvent[] = [];
  const categoryCounts: Record<string, number> = {};
  for (const r of rows) {
    const band = bandOf(r.repo_key);
    const category = topRepos.has(band) ? band : OTHER_CATEGORY;
    categoryCounts[category] = (categoryCounts[category] ?? 0) + 1;
    const ms = Date.parse(r.author_date_utc);
    events.push({
      sourceRef: `${r.repo_key}|${r.commit_hash}`,
      sessionId: null,
      category,
      calendarDay: localDayFromIso(r.author_date_utc),
      eventTime: Number.isFinite(ms) ? ms : 0,
      payload: {
        // Shared display keys the generic drilldown reads (title/host/url),
        // plus git-specific fields.
        title: r.subject,
        host: band,
        url: null,
        repo: band,
        sha: r.commit_hash,
        added: r.added,
        deleted: r.deleted,
        files_changed: r.files_changed,
      },
    });
  }

  const totalKept = events.length;
  const otherShare = totalKept > 0 ? (categoryCounts[OTHER_CATEGORY] ?? 0) / totalKept : 0;
  const folded = [...counts.entries()]
    .filter(([k]) => !topRepos.has(k))
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 20)
    .map(([domain, count]) => ({ domain, count }));

  return {
    events,
    sourceCount: rows.length,
    diagnostic: {
      total_source: rows.length,
      total_kept: totalKept,
      filtered_non_web: 0,
      filtered_transition: {},
      category_counts: categoryCounts,
      other_share: otherShare,
      top_unmatched_domains: folded,
    },
  };
}

/** Rebuild the git commit topic stream (band = repo, Top-N + 其他). git has no profile. */
export function rebuildGitTopicStream(db: Database.Database): RebuildTopicStreamResult {
  const started = Date.now();
  const updatedAt = nowIso();
  try {
    const built = buildGitTopicEvents(db);
    const derived = persistTopicStream(db, {
      source: GIT_SOURCE,
      profile: GIT_PROFILE,
      ruleVersion: GIT_RULE_VERSION,
      events: built.events,
      sourceCount: built.sourceCount,
      started,
      updatedAt,
    });
    return {
      source: GIT_SOURCE,
      profile: GIT_PROFILE,
      ruleVersion: GIT_RULE_VERSION,
      sourceCount: built.sourceCount,
      derivedCount: derived,
      durationMs: Date.now() - started,
      ok: true,
      error: null,
      diagnostic: built.diagnostic,
    };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    const sourceCount = gitSourceCount(db);
    let derived = 0;
    try {
      derived = derivedCount(db, GIT_SOURCE, GIT_PROFILE);
    } catch {
      derived = 0;
    }
    upsertState(db, GIT_SOURCE, GIT_PROFILE, {
      ruleVersion: GIT_RULE_VERSION,
      rebuiltAt: null,
      error,
      sourceCount,
      derivedCount: derived,
      durationMs: Date.now() - started,
      updatedAt: nowIso(),
    });
    return {
      source: GIT_SOURCE,
      profile: GIT_PROFILE,
      ruleVersion: GIT_RULE_VERSION,
      sourceCount,
      derivedCount: derived,
      durationMs: Date.now() - started,
      ok: false,
      error,
      diagnostic: null,
    };
  }
}

export function getTopicStreamStatus(
  db: Database.Database,
  source: string,
  profile: string,
  configPath?: string
): TopicStreamStatus {
  const state = db
    .prepare(
      `SELECT source, profile, rule_version, last_rebuilt_at, last_error,
              source_event_count, derived_event_count,
              last_rebuild_duration_ms, updated_at
       FROM topic_stream_state
       WHERE source = ? AND profile = ?`
    )
    .get(source, profile) as TopicStreamState | undefined;
  let ruleVersion: string;
  if (source === GIT_SOURCE) {
    ruleVersion = GIT_RULE_VERSION;
  } else if (source === CONVERSATION_SOURCE) {
    ruleVersion = CONVERSATION_RULE_VERSION;
  } else {
    const cfg = readTopicStreamConfig(configPath);
    ruleVersion = cfg.ok ? cfg.hash : CONFIG_ERROR_VERSION;
  }
  const currentSourceCount =
    source === CHROME_SOURCE
      ? chromeSourceCount(db, profile)
      : source === GIT_SOURCE
        ? gitSourceCount(db)
        : source === CONVERSATION_SOURCE
          ? conversationSourceCount(db)
          : 0;
  const currentDerivedCount = derivedCount(db, source, profile);
  const staleReasons: string[] = [];
  if (!state) staleReasons.push("not_built");
  if (state && state.rule_version !== ruleVersion) staleReasons.push("rule_version_mismatch");
  if (state?.last_error) staleReasons.push("last_rebuild_error");
  if (state && state.source_event_count !== currentSourceCount) {
    staleReasons.push("source_count_changed");
  }
  if (state && state.derived_event_count !== currentDerivedCount) {
    staleReasons.push("derived_count_changed");
  }
  return {
    source,
    profile,
    ruleVersion,
    state: state ?? null,
    currentSourceCount,
    currentDerivedCount,
    fresh: staleReasons.length === 0,
    staleReasons,
  };
}
