import type Database from "better-sqlite3";

export type TopicGrain = "day" | "week" | "month";

/** Dense matrix for the streamgraph: categories (ys) x time buckets (xs). */
export type TopicStreamMatrix = {
  xs: string[];
  ys: string[];
  cells: number[][];
};

/** Week buckets start on Monday (bucket key = that week's Monday date). */
function bucketSql(grain: TopicGrain): string {
  if (grain === "month") return "substr(calendar_day, 1, 7)";
  if (grain === "week") {
    return "date(calendar_day, '-' || ((CAST(strftime('%w', calendar_day) AS INTEGER) + 6) % 7) || ' days')";
  }
  return "calendar_day";
}

export function getTopicStreamMatrix(
  db: Database.Database,
  args: {
    source: string;
    profile: string;
    grain?: TopicGrain;
    from?: string | null;
    to?: string | null;
  }
): TopicStreamMatrix {
  const grain = args.grain ?? "day";
  const clauses = ["source = ?", "profile = ?"];
  const params: unknown[] = [args.source, args.profile];
  if (args.from) {
    clauses.push("calendar_day >= ?");
    params.push(args.from);
  }
  if (args.to) {
    clauses.push("calendar_day < ?");
    params.push(args.to);
  }
  const rows = db
    .prepare(
      `SELECT category, ${bucketSql(grain)} AS bucket, COUNT(*) AS count
       FROM topic_stream
       WHERE ${clauses.join(" AND ")}
       GROUP BY category, bucket
       ORDER BY bucket ASC`
    )
    .all(...params) as { category: string; bucket: string; count: number }[];

  if (rows.length === 0) return { xs: [], ys: [], cells: [] };

  const xs = Array.from(new Set(rows.map((r) => r.bucket))).sort();
  const totalByCat = new Map<string, number>();
  for (const r of rows) {
    totalByCat.set(r.category, (totalByCat.get(r.category) ?? 0) + r.count);
  }
  const ys = [...totalByCat.keys()].sort(
    (a, b) => (totalByCat.get(b) ?? 0) - (totalByCat.get(a) ?? 0) || a.localeCompare(b)
  );
  const xIndex = new Map(xs.map((x, i) => [x, i] as const));
  const yIndex = new Map(ys.map((y, i) => [y, i] as const));
  const cells = ys.map(() => xs.map(() => 0));
  for (const r of rows) {
    const i = yIndex.get(r.category);
    const j = xIndex.get(r.bucket);
    if (i != null && j != null) cells[i][j] = r.count;
  }
  return { xs, ys, cells };
}

export type TopicDrilldownRow = {
  source_ref: string;
  session_id: string | null;
  category: string;
  calendar_day: string;
  event_time: number;
  url: string | null;
  title: string | null;
  host: string | null;
};

export type TopicDrilldownResult = { items: TopicDrilldownRow[]; nextCursor: string | null };

function localDay(d: Date): string {
  const y = d.getFullYear();
  const m = `${d.getMonth() + 1}`.padStart(2, "0");
  const day = `${d.getDate()}`.padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function addDays(day: string, n: number): string {
  const [y, m, d] = day.split("-").map(Number);
  return localDay(new Date(y, m - 1, d + n));
}

/**
 * Pages behind one category × time bucket. `bucket` is the same value returned
 * in `getTopicStreamMatrix().xs` for the given grain (a day, a Monday week-start,
 * or a `YYYY-MM` month). Keyset-paginated by `event_time DESC, source_ref DESC`.
 */
export function getTopicStreamDrilldown(
  db: Database.Database,
  args: {
    source: string;
    profile: string;
    category: string;
    bucket: string;
    grain?: TopicGrain;
    cursor?: string | null;
    perPage?: number;
  }
): TopicDrilldownResult {
  const grain = args.grain ?? "day";
  const perPage = Math.min(200, Math.max(1, args.perPage ?? 50));
  const clauses = ["source = ?", "profile = ?", "category = ?"];
  const params: unknown[] = [args.source, args.profile, args.category];
  if (grain === "day") {
    clauses.push("calendar_day = ?");
    params.push(args.bucket);
  } else if (grain === "month") {
    clauses.push("calendar_day LIKE ?");
    params.push(`${args.bucket}%`);
  } else {
    clauses.push("calendar_day >= ? AND calendar_day < ?");
    params.push(args.bucket, addDays(args.bucket, 7));
  }
  if (args.cursor) {
    const [t, ref] = args.cursor.split("|");
    if (t && ref && /^\d+$/.test(t)) {
      clauses.push("(event_time < ? OR (event_time = ? AND source_ref < ?))");
      params.push(Number(t), Number(t), ref);
    }
  }
  const rows = db
    .prepare(
      `SELECT source_ref, session_id, category, calendar_day, event_time, payload
       FROM topic_stream
       WHERE ${clauses.join(" AND ")}
       ORDER BY event_time DESC, source_ref DESC
       LIMIT ?`
    )
    .all(...params, perPage) as {
    source_ref: string;
    session_id: string | null;
    category: string;
    calendar_day: string;
    event_time: number;
    payload: string | null;
  }[];

  const items: TopicDrilldownRow[] = rows.map((r) => {
    let url: string | null = null;
    let title: string | null = null;
    let host: string | null = null;
    if (r.payload) {
      try {
        const p = JSON.parse(r.payload) as { url?: string; title?: string; host?: string };
        url = p.url ?? null;
        title = p.title ?? null;
        host = p.host ?? null;
      } catch {
        /* leave nulls */
      }
    }
    return {
      source_ref: r.source_ref,
      session_id: r.session_id,
      category: r.category,
      calendar_day: r.calendar_day,
      event_time: r.event_time,
      url,
      title,
      host,
    };
  });
  const last = items.length === perPage ? items[items.length - 1] : null;
  return {
    items,
    nextCursor: last ? `${last.event_time}|${last.source_ref}` : null,
  };
}
