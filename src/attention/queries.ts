import type Database from "better-sqlite3";
import { chromeWebkitUsToUnixMs } from "../chromeHistory/time.js";

/**
 * Something that happened inside an app while it held the foreground.
 *
 * The point of the attention layer is not "you spent 3h in Cursor" — Screen
 * Time has said that for a decade. It is that ai2nao already knows what
 * happened *inside* those three hours, and nothing else does.
 */
export type CrossEventKind = "commit" | "visit" | "token" | "message";

export type CrossEvent = {
  kind: CrossEventKind;
  atMs: number;
  label: string;
  detail?: string;
  /**
   * How many raw events this row stands for. 1 unless token events were rolled
   * up — a busy agent emits one per API call, and 64 identical "Claude" lines
   * in a panel is noise, not evidence.
   */
  count?: number;
};

export type AttentionSpan = {
  id: number;
  bundleId: string;
  appName: string | null;
  startMs: number;
  endMs: number;
  durationMs: number;
  partIndex: number;
  /** How many stored rows this span stands for. 1 unless adjacent rows merged. */
  mergedFrom: number;
  events: CrossEvent[];
};

export type BundleTotal = {
  bundleId: string;
  appName: string | null;
  totalMs: number;
  spanCount: number;
};

export type AttentionDay = {
  localDay: string;
  totalMs: number;
  spanCount: number;
  spans: AttentionSpan[];
  byBundle: BundleTotal[];
  eventCounts: Record<CrossEventKind, number>;
  /** Events inside the day that fell outside every span (screen off, etc). */
  unattributedEvents: number;
};

/**
 * Sources that cannot be crossed yet, with the reason. Surfaced to the UI so a
 * missing row reads as a known boundary rather than as "nothing happened".
 */
export const UNSUPPORTED_SOURCES = [
  {
    source: "atuin",
    reason:
      "atuin_directory_activity_commands is an aggregate of (cwd, command) with counts, not an event log — it can say when a command last ran, not which commands ran inside a window. Crossing shell activity needs the raw Atuin history.",
  },
] as const;

const DAY_MS = 86_400_000;

/**
 * Everything worth knowing about one local day.
 *
 * Fetches each source **once for the whole day** and buckets in memory, rather
 * than querying per span. Three of the four source tables do not lead their
 * index with the time column, so a per-span query would full-scan once per
 * span; with ~500 spans a day that is 500 scans of a 52k-row table to render
 * one screen.
 */
export function getAttentionDay(
  db: Database.Database,
  localDay: string
): AttentionDay {
  const spanRows = db
    .prepare(
      `SELECT id, bundle_id, start_ms, end_ms, duration_ms, part_index
         FROM attention_focus_spans
        WHERE local_day = ?
        ORDER BY start_ms ASC`
    )
    .all(localDay) as {
    id: number;
    bundle_id: string;
    start_ms: number;
    end_ms: number;
    duration_ms: number;
    part_index: number;
  }[];

  const names = appNameMap(db);
  const spans: AttentionSpan[] = mergeAdjacent(spanRows).map((r) => ({
    id: r.id,
    bundleId: r.bundle_id,
    appName: names.get(r.bundle_id) ?? null,
    startMs: r.start_ms,
    endMs: r.end_ms,
    durationMs: r.duration_ms,
    partIndex: r.part_index,
    mergedFrom: r.merged_from,
    events: [],
  }));

  const eventCounts: Record<CrossEventKind, number> = {
    commit: 0,
    visit: 0,
    token: 0,
    message: 0,
  };

  if (spans.length === 0) {
    return {
      localDay,
      totalMs: 0,
      spanCount: 0,
      spans: [],
      byBundle: [],
      eventCounts,
      unattributedEvents: 0,
    };
  }

  const fromMs = spans[0]!.startMs;
  const toMs = Math.max(...spans.map((s) => s.endMs));
  const events = [
    ...readCommits(db, fromMs, toMs),
    ...readVisits(db, localDay, fromMs, toMs),
    ...readTokens(db, fromMs, toMs),
    ...readMessages(db, fromMs, toMs),
  ].sort((a, b) => a.atMs - b.atMs);

  let unattributed = 0;
  for (const ev of events) {
    eventCounts[ev.kind] += 1;
    const span = findSpan(spans, ev.atMs);
    if (span) span.events.push(ev);
    else unattributed += 1;
  }

  // Counts above stay raw; what the panel shows gets token rows rolled up.
  for (const s of spans) s.events = rollUpTokens(s.events);

  const byBundle = new Map<string, BundleTotal>();
  let totalMs = 0;
  for (const s of spans) {
    totalMs += s.durationMs;
    const cur = byBundle.get(s.bundleId);
    if (cur) {
      cur.totalMs += s.durationMs;
      cur.spanCount += 1;
    } else {
      byBundle.set(s.bundleId, {
        bundleId: s.bundleId,
        appName: s.appName,
        totalMs: s.durationMs,
        spanCount: 1,
      });
    }
  }

  return {
    localDay,
    totalMs,
    spanCount: spans.length,
    spans,
    byBundle: [...byBundle.values()].sort((a, b) => b.totalMs - a.totalMs),
    eventCounts,
    unattributedEvents: unattributed,
  };
}

/**
 * Collapse token events per source into one row carrying the totals.
 *
 * An agent working hard emits one token event per API call — a single 10-minute
 * span was measured holding 64 of them. Listing each individually buries the
 * commits and questions that actually say what was going on. Commits, visits
 * and questions are never rolled up: each one is distinct and carries meaning.
 */
function rollUpTokens(events: CrossEvent[]): CrossEvent[] {
  const tokens = events.filter((e) => e.kind === "token");
  if (tokens.length < 2) return events;

  const bySource = new Map<string, { atMs: number; count: number; inTok: number; outTok: number }>();
  for (const t of tokens) {
    const m = /in (\d+) \/ out (\d+)/.exec(t.detail ?? "");
    const cur = bySource.get(t.label);
    const inTok = m ? Number.parseInt(m[1]!, 10) : 0;
    const outTok = m ? Number.parseInt(m[2]!, 10) : 0;
    if (cur) {
      cur.count += 1;
      cur.inTok += inTok;
      cur.outTok += outTok;
      cur.atMs = Math.min(cur.atMs, t.atMs);
    } else {
      bySource.set(t.label, { atMs: t.atMs, count: 1, inTok, outTok });
    }
  }

  const rolled: CrossEvent[] = [...bySource.entries()].map(([label, v]) => ({
    kind: "token" as const,
    atMs: v.atMs,
    label: v.count > 1 ? `${label} × ${v.count}` : label,
    detail: `in ${v.inTok.toLocaleString()} / out ${v.outTok.toLocaleString()}`,
    count: v.count,
  }));

  return [...events.filter((e) => e.kind !== "token"), ...rolled].sort(
    (a, b) => a.atMs - b.atMs
  );
}

/**
 * Gap tolerated when merging two stored rows of the same app into one span.
 *
 * Measured: consecutive `/app/usage` rows are flush (one ends exactly where the
 * next begins), so real gaps come from rows dropped in between — the zero-length
 * flickers filtered at ingest. Two seconds absorbs those without swallowing a
 * genuine switch away and back, which carries information worth keeping.
 */
const MERGE_GAP_MS = 2000;

type StoredSpan = {
  id: number;
  bundle_id: string;
  start_ms: number;
  end_ms: number;
  duration_ms: number;
  part_index: number;
  merged_from: number;
};

/**
 * Fold consecutive rows of the same app into one span — **for display only**.
 *
 * Deliberately not done at ingest: the stored uniqueness key is
 * (source, instance, source_row_id, part_index), one row per source row. Merging
 * on the way in would leave the second row's `source_row_id` unrecorded, and a
 * source reset would then re-insert it as new. Keeping storage 1:1 also means
 * this threshold can change without re-ingesting anything.
 *
 * Rows arrive ordered by start_ms (the query says so), so one pass is enough.
 */
function mergeAdjacent(
  rows: Omit<StoredSpan, "merged_from">[]
): StoredSpan[] {
  const out: StoredSpan[] = [];
  for (const r of rows) {
    const prev = out[out.length - 1];
    if (
      prev &&
      prev.bundle_id === r.bundle_id &&
      r.start_ms - prev.end_ms <= MERGE_GAP_MS &&
      r.start_ms >= prev.start_ms
    ) {
      prev.end_ms = Math.max(prev.end_ms, r.end_ms);
      prev.duration_ms = prev.end_ms - prev.start_ms;
      prev.merged_from += 1;
      continue;
    }
    out.push({ ...r, merged_from: 1 });
  }
  return out;
}

/** Binary search: spans are disjoint and ordered by start. */
function findSpan(spans: AttentionSpan[], atMs: number): AttentionSpan | null {
  let lo = 0;
  let hi = spans.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const s = spans[mid]!;
    if (atMs < s.startMs) hi = mid - 1;
    else if (atMs >= s.endMs) lo = mid + 1;
    else return s;
  }
  return null;
}

function appNameMap(db: Database.Database): Map<string, string> {
  // The source carries only bundle ids; display names live in mac_apps, which
  // is why no app_name column is stored on the span itself.
  const rows = db
    .prepare("SELECT bundle_id, name FROM mac_apps WHERE bundle_id IS NOT NULL")
    .all() as { bundle_id: string; name: string }[];
  return new Map(rows.map((r) => [r.bundle_id, r.name]));
}

const iso = (ms: number): string => new Date(ms).toISOString();

function readCommits(
  db: Database.Database,
  fromMs: number,
  toMs: number
): CrossEvent[] {
  const rows = db
    .prepare(
      `SELECT repo_key, subject, author_date_utc, added, deleted
         FROM git_commits
        WHERE author_date_utc >= ? AND author_date_utc <= ?`
    )
    .all(iso(fromMs), iso(toMs)) as {
    repo_key: string;
    subject: string | null;
    author_date_utc: string;
    added: number | null;
    deleted: number | null;
  }[];
  return rows.map((r) => ({
    kind: "commit" as const,
    atMs: Date.parse(r.author_date_utc),
    label: r.subject ?? "(no subject)",
    detail: `${r.repo_key} +${r.added ?? 0}/-${r.deleted ?? 0}`,
  }));
}

function readVisits(
  db: Database.Database,
  localDay: string,
  fromMs: number,
  toMs: number
): CrossEvent[] {
  // calendar_day is indexed and narrows 85k rows to one day before the range
  // filter runs. A span can spill past midnight into the neighbouring day, so
  // both days are considered.
  const nextDay = new Date(Date.parse(`${localDay}T00:00:00Z`) + DAY_MS)
    .toISOString()
    .slice(0, 10);
  // The join is a three-part key, and getting it wrong is silent: `source_id`
  // is the *data source instance* (`chrome-<uuid>`), not a URL id, and it is
  // TEXT while `visits.url_id` is INTEGER — so `u.source_id = v.url_id` is
  // always false and every title comes back null. The real URL id is `urls.id`.
  // This shape also hits the primary key (profile, source_id, id).
  const rows = db
    .prepare(
      `SELECT v.visit_time, u.url, u.title
         FROM chrome_history_visits v
         LEFT JOIN chrome_history_urls u
                ON u.profile = v.profile
               AND u.source_id = v.source_id
               AND u.id = v.url_id
        WHERE v.calendar_day IN (?, ?)`
    )
    .all(localDay, nextDay) as {
    visit_time: number;
    url: string | null;
    title: string | null;
  }[];
  const out: CrossEvent[] = [];
  for (const r of rows) {
    const atMs = chromeWebkitUsToUnixMs(r.visit_time);
    if (atMs < fromMs || atMs > toMs) continue;
    out.push({
      kind: "visit",
      atMs,
      label: r.title || r.url || "(untitled)",
      detail: r.url ?? undefined,
    });
  }
  return out;
}

function readTokens(
  db: Database.Database,
  fromMs: number,
  toMs: number
): CrossEvent[] {
  const out: CrossEvent[] = [];
  for (const [table, source] of [
    ["claude_token_usage_event", "Claude"],
    ["codex_token_usage_event", "Codex"],
  ] as const) {
    const rows = db
      .prepare(
        `SELECT event_at, input_tokens, output_tokens
           FROM ${table}
          WHERE event_at >= ? AND event_at <= ?`
      )
      .all(iso(fromMs), iso(toMs)) as {
      event_at: string;
      input_tokens: number | null;
      output_tokens: number | null;
    }[];
    for (const r of rows) {
      out.push({
        kind: "token",
        atMs: Date.parse(r.event_at),
        label: source,
        detail: `in ${r.input_tokens ?? 0} / out ${r.output_tokens ?? 0}`,
      });
    }
  }
  return out;
}

function readMessages(
  db: Database.Database,
  fromMs: number,
  toMs: number
): CrossEvent[] {
  const rows = db
    .prepare(
      `SELECT source, project, cleaned_text, raw_text, event_at_utc
         FROM agent_user_messages
        WHERE is_human = 1 AND event_at_utc >= ? AND event_at_utc <= ?`
    )
    .all(iso(fromMs), iso(toMs)) as {
    source: string;
    project: string | null;
    cleaned_text: string | null;
    raw_text: string | null;
    event_at_utc: string;
  }[];
  return rows.map((r) => {
    const text = (r.cleaned_text || r.raw_text || "").replace(/\s+/g, " ").trim();
    return {
      kind: "message" as const,
      atMs: Date.parse(r.event_at_utc),
      label: text.length > 90 ? `${text.slice(0, 90)}…` : text || "(empty)",
      detail: r.project ? `${r.source} · ${r.project}` : r.source,
    };
  });
}
