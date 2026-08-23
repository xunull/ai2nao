import { describe, expect, it, beforeEach, beforeAll, afterAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { openDatabase } from "../src/store/open.js";
import { computeMonthRange } from "../src/workTokensTrend/queries.js";
import { ADAPTERS } from "../src/workTokensTrend/adapters.js";
import {
  computePreviousWindow,
  computeTotals,
  mergeAndZeroFill,
} from "../src/workTokensTrend/queries.js";
import { inputTokens, totalTokens, TOKEN_SOURCES } from "../src/workTokensTrend/types.js";
import { rowInput, rowTotal } from "./fixtures/sourceRow.js";
import type { SourceBucketRow } from "../src/workTokensTrend/adapters.js";
import {
  emptyUsage,
  type SourceUsage,
  type WorkTokensTrendBucket,
} from "../src/workTokensTrend/types.js";

const PRIOR_TZ = process.env.TZ;
beforeAll(() => {
  process.env.TZ = "Asia/Shanghai";
});
afterAll(() => {
  process.env.TZ = PRIOR_TZ;
});

function freshDb(): Database.Database {
  const dir = mkdtempSync(join(tmpdir(), "ai2nao-tokens-trend-q-"));
  return openDatabase(join(dir, "test.db"));
}

type SeedRow = {
  source: "claude" | "codex";
  session_id?: string;
  project_id?: string;
  file_path?: string;
  cwd?: string;
  project_key?: string;
  project_path?: string;
  total: number;
  /** Optional input/output split. Default: input=total, output=0 (keeps the
   *  per-row invariant total = input + output true for existing tests). */
  input?: number;
  output?: number;
  /** Claude-only cache split (ignored for codex — no such columns). */
  cacheRead?: number;
  cacheCreation?: number;
  /** Codex-only reasoning output (ignored for claude — no such column). */
  reasoning?: number;
  status?: "full" | "unknown" | "error";
  updated: string; // ISO UTC
  missingSince?: string | null;
};

let seq = 0;
function seedSession(db: Database.Database, row: SeedRow): void {
  seq += 1;
  const id = row.session_id ?? `s-${seq}-${row.source}`;
  const seedInput = row.input ?? row.total;
  const seedOutput = row.output ?? 0;
  const cacheRead = row.cacheRead ?? 0;
  const cacheCreation = row.cacheCreation ?? 0;
  const table =
    row.source === "claude"
      ? "claude_session_token_usage"
      : "codex_session_token_usage";
  if (row.source === "claude") {
    db.prepare(
      `INSERT INTO claude_session_token_usage
         (session_id, project_id, file_path, file_mtime_ms, file_size_bytes,
          cwd, project_key, project_path, identity_confidence,
          title, created_at, last_updated_at,
          input_tokens, output_tokens, total_tokens,
          cache_read_input_tokens, cache_creation_input_tokens, token_status,
          parse_error, missing_since, source_seen_at, updated_at)
       VALUES (?, ?, ?, 0, 0, ?, ?, ?, 'high',
               null, null, ?, ?, ?, ?, ?, ?, ?, null, ?, ?, ?)`
    ).run(
      id,
      row.project_id ?? "p-test",
      row.file_path ?? "/tmp/x.jsonl",
      row.cwd ?? "/tmp/test",
      row.project_key ?? "/tmp/test",
      row.project_path ?? "/tmp/test",
      row.updated,
      seedInput,
      seedOutput,
      row.total,
      cacheRead,
      cacheCreation,
      row.status ?? "full",
      row.missingSince ?? null,
      row.updated,
      row.updated
    );
    // Claude trend token sums now read from the per-message-day timeline. Mirror
    // this single-day session as one event at `updated` (event_at == last_updated
    // here, so the day bucket is unchanged). The JOIN re-applies the
    // token_status='full' + missing_since filters.
    db.prepare(
      `INSERT INTO claude_token_usage_event
         (session_id, message_id, event_at, input_tokens, output_tokens,
          cache_read_input_tokens, cache_creation_input_tokens)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(id, `${id}-m`, row.updated, seedInput, seedOutput, cacheRead, cacheCreation);
    return;
  }
  // Codex
  db.prepare(
    `INSERT INTO codex_session_token_usage
       (session_id, rollout_path, rollout_mtime_ms, rollout_size_bytes,
        cwd, project_key, project_path, identity_confidence,
        title, model, git_branch, created_at, last_updated_at,
        input_tokens, output_tokens, total_tokens, reasoning_output_tokens, token_status,
        parse_error, missing_since, source_seen_at, updated_at)
     VALUES (?, ?, 0, 0, ?, ?, ?, 'high', null, null, null, null, ?,
             ?, ?, ?, ?, ?, null, ?, ?, ?)`
  ).run(
    id,
    row.file_path ?? "/tmp/r.jsonl",
    row.cwd ?? "/tmp/test",
    row.project_key ?? "/tmp/test",
    row.project_path ?? "/tmp/test",
    row.updated,
    seedInput,
    seedOutput,
    row.total,
    row.reasoning ?? 0,
    row.status ?? "full",
    row.missingSince ?? null,
    row.updated,
    row.updated
  );
  // Codex trend token sums read from the per-event timeline. Mirror this
  // session as a single event at `updated` (the JOIN re-applies the
  // token_status='full' + missing_since filters, so unknown/error/missing
  // sessions still contribute 0).
  db.prepare(
    `INSERT INTO codex_token_usage_event
       (session_id, event_at, input_tokens, output_tokens, reasoning_output_tokens)
     VALUES (?, ?, ?, ?, ?)`
  ).run(id, row.updated, seedInput, seedOutput, row.reasoning ?? 0);
  void table;
}

describe("queryBucketsBySource", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = freshDb();
  });

  it("aggregates Claude tokens by day bucket and excludes other sources", () => {
    // Local 2026-06-10 in Asia/Shanghai is 2026-06-09 16:00 UTC.
    seedSession(db, { source: "claude", total: 1000, updated: "2026-06-09T16:30:00Z" });
    seedSession(db, { source: "claude", total: 500, updated: "2026-06-09T18:00:00Z" });
    // Codex same day, should not appear in claude rows
    seedSession(db, { source: "codex", total: 9999, updated: "2026-06-09T17:00:00Z" });

    const rows = ADAPTERS.claude.queryBuckets(
      db,
      new Date(2026, 5, 10, 0, 0, 0, 0),
      new Date(2026, 5, 11, 0, 0, 0, 0),
      "day"
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].bucket_key).toBe("2026-06-10");
    expect(rowTotal(rows[0]!)).toBe(1500);
    expect(rows[0].session_count).toBe(2);
    expect(rows[0].full_count).toBe(2);
  });

  it("T-A4 (F2): unknown and error session counts are separate fields", () => {
    seedSession(db, { source: "claude", total: 1000, status: "full", updated: "2026-06-09T16:30:00Z" });
    seedSession(db, { source: "claude", total: 0, status: "unknown", updated: "2026-06-09T16:35:00Z" });
    seedSession(db, { source: "claude", total: 0, status: "error", updated: "2026-06-09T16:40:00Z" });
    seedSession(db, { source: "claude", total: 0, status: "error", updated: "2026-06-09T16:45:00Z" });

    const rows = ADAPTERS.claude.queryBuckets(
      db,
      new Date(2026, 5, 10, 0, 0, 0, 0),
      new Date(2026, 5, 11, 0, 0, 0, 0),
      "day"
    );
    expect(rows).toHaveLength(1);
    expect(rowTotal(rows[0]!)).toBe(1000); // only `full` contributes
    expect(rows[0].full_count).toBe(1);
    expect(rows[0].unknown_count).toBe(1);
    expect(rows[0].error_count).toBe(2);
    expect(rows[0].session_count).toBe(4);
  });

  it("T-B1 (F8): missing_since IS NOT NULL rows are filtered out", () => {
    seedSession(db, { source: "claude", total: 1000, updated: "2026-06-09T16:30:00Z" });
    seedSession(db, {
      source: "claude",
      total: 5000,
      updated: "2026-06-09T17:00:00Z",
      missingSince: "2026-06-10T01:00:00Z",
    });

    const rows = ADAPTERS.claude.queryBuckets(
      db,
      new Date(2026, 5, 10, 0, 0, 0, 0),
      new Date(2026, 5, 11, 0, 0, 0, 0),
      "day"
    );
    expect(rowTotal(rows[0]!)).toBe(1000);
    expect(rows[0].session_count).toBe(1);
  });

  it("T-B2 (F8): empty result returns empty array, does not throw", () => {
    const rows = ADAPTERS.claude.queryBuckets(
      db,
      new Date(2026, 5, 10, 0, 0, 0, 0),
      new Date(2026, 5, 11, 0, 0, 0, 0),
      "day"
    );
    expect(rows).toEqual([]);
  });

  it("respects half-open range boundary (rows at `to` excluded)", () => {
    // Boundary: row exactly at the cutoff should NOT appear.
    seedSession(db, { source: "claude", total: 100, updated: "2026-06-09T16:00:00Z" });
    seedSession(db, { source: "claude", total: 200, updated: "2026-06-10T16:00:00Z" });
    const rows = ADAPTERS.claude.queryBuckets(
      db,
      new Date(2026, 5, 10, 0, 0, 0, 0),
      new Date(2026, 5, 11, 0, 0, 0, 0),
      "day"
    );
    expect(rowTotal(rows[0]!)).toBe(100);
  });
});

describe("mergeAndZeroFill", () => {
  const buckets = [
    { key: "2026-06-10", start: new Date("2026-06-10T00:00:00Z"), end: new Date("2026-06-11T00:00:00Z") },
    { key: "2026-06-11", start: new Date("2026-06-11T00:00:00Z"), end: new Date("2026-06-12T00:00:00Z") },
  ];
  const row = (o: Partial<SourceBucketRow> & { bucket_key: string }): SourceBucketRow => ({
    fresh_input: 0, cache_read_input: 0, cache_creation_input: 0, output: 0,
    reasoning_output: 0, session_count: 0, full_count: 0, unknown_count: 0, error_count: 0,
    ...o,
  });
  const empty = () => new Map<string, SourceBucketRow>();
  const allOk = { claude: "ok", codex: "ok", minimax: "ok", kimi: "ok", opencode: "ok" } as const;

  it("某个源缺某个桶时补零,不是丢桶", () => {
    const merged = mergeAndZeroFill(
      buckets,
      {
        claude: new Map([["2026-06-10", row({ bucket_key: "2026-06-10", fresh_input: 800, output: 200, session_count: 2, full_count: 2 })]]),
        codex: empty(),
        minimax: empty(),
        kimi: empty(),
        opencode: empty(),
      },
      allOk
    );
    expect(merged).toHaveLength(2);
    expect(totalTokens(merged[0]!.sources.claude)).toBe(1000);
    expect(totalTokens(merged[0]!.sources.codex)).toBe(0);
    // 第二个桶两个源都没有 → 全零,但桶还在
    expect(totalTokens(merged[1]!.sources.claude)).toBe(0);
    expect(merged[1]!.bucketStart).toBe(buckets[1]!.start.toISOString());
  });

  it("逐源分量各自带过来,互不串味", () => {
    const merged = mergeAndZeroFill(
      buckets,
      {
        claude: new Map([["2026-06-10", row({ bucket_key: "2026-06-10", fresh_input: 300, cache_read_input: 400, cache_creation_input: 100, output: 200 })]]),
        codex: new Map([["2026-06-10", row({ bucket_key: "2026-06-10", fresh_input: 250, cache_read_input: 300, output: 50, reasoning_output: 20 })]]),
        minimax: empty(),
        kimi: empty(),
        opencode: empty(),
      },
      allOk
    );
    const c = merged[0]!.sources.claude;
    const x = merged[0]!.sources.codex;
    expect(inputTokens(c)).toBe(800);
    expect(c.cacheCreationInput).toBe(100);
    expect(inputTokens(x)).toBe(550);
    // codex 没有 cache 写入概念 —— 这里是 0 且 capabilities 会说明它不适用
    expect(x.cacheCreationInput).toBe(0);
    expect(x.reasoningOutput).toBe(20);
    // claude 不该沾上 codex 的 reasoning
    expect(c.reasoningOutput).toBe(0);
  });

  it("state 逐源带下去 —— failed 不会被补零成 ok", () => {
    const merged = mergeAndZeroFill(
      buckets,
      { claude: empty(), codex: empty(), minimax: empty(), kimi: empty(), opencode: empty() },
      { claude: "ok", codex: "failed", minimax: "absent", kimi: "absent" }
    );
    expect(merged[0]!.sources.claude.state).toBe("ok");
    expect(merged[0]!.sources.codex.state).toBe("failed");
    expect(merged[0]!.sources.minimax.state).toBe("absent");
  });
});
describe("input/output breakdown (2×3 matrix data)", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = freshDb();
  });

  it("queryBucketsBySource sums Claude cache split; codex returns 0", () => {
    seedSession(db, {
      source: "claude",
      total: 70837,
      input: 70585,
      output: 252,
      cacheRead: 22924,
      cacheCreation: 47655,
      updated: "2026-06-09T16:30:00Z",
    });
    seedSession(db, {
      source: "codex",
      total: 600,
      input: 550,
      output: 50,
      updated: "2026-06-09T17:00:00Z",
    });

    const claudeRows = ADAPTERS.claude.queryBuckets(
      db,
      new Date(2026, 5, 10, 0, 0, 0, 0),
      new Date(2026, 5, 11, 0, 0, 0, 0),
      "day"
    );
    expect(claudeRows[0].cache_read_input).toBe(22924);
    expect(claudeRows[0].cache_creation_input).toBe(47655);

    const codexRows = ADAPTERS.codex.queryBuckets(
      db,
      new Date(2026, 5, 10, 0, 0, 0, 0),
      new Date(2026, 5, 11, 0, 0, 0, 0),
      "day"
    );
    // codex table has no cache columns → literal 0
    expect(codexRows[0].cache_read_input).toBe(0);
    expect(codexRows[0].cache_creation_input).toBe(0);
  });

  it("queryBucketsBySource sums Codex reasoning; claude returns 0", () => {
    // mirror of the cache test, opposite direction
    seedSession(db, {
      source: "codex",
      total: 600,
      input: 550,
      output: 600,
      reasoning: 200,
      updated: "2026-06-09T17:00:00Z",
    });
    seedSession(db, {
      source: "claude",
      total: 1000,
      input: 900,
      output: 100,
      updated: "2026-06-09T16:30:00Z",
    });

    const codexRows = ADAPTERS.codex.queryBuckets(
      db,
      new Date(2026, 5, 10, 0, 0, 0, 0),
      new Date(2026, 5, 11, 0, 0, 0, 0),
      "day"
    );
    expect(codexRows[0].reasoning_output).toBe(200);

    const claudeRows = ADAPTERS.claude.queryBuckets(
      db,
      new Date(2026, 5, 10, 0, 0, 0, 0),
      new Date(2026, 5, 11, 0, 0, 0, 0),
      "day"
    );
    // claude table has no reasoning column → literal 0
    expect(claudeRows[0].reasoning_output).toBe(0);
  });

  it("queryBucketsBySource sums input/output split, full-only", () => {
    // 2 full claude sessions + 1 unknown (must NOT contribute to input/output)
    seedSession(db, {
      source: "claude",
      total: 1000,
      input: 900,
      output: 100,
      updated: "2026-06-09T16:30:00Z",
    });
    seedSession(db, {
      source: "claude",
      total: 500,
      input: 480,
      output: 20,
      updated: "2026-06-09T17:00:00Z",
    });
    seedSession(db, {
      source: "claude",
      total: 0,
      input: 0,
      output: 0,
      status: "unknown",
      updated: "2026-06-09T17:30:00Z",
    });

    const rows = ADAPTERS.claude.queryBuckets(
      db,
      new Date(2026, 5, 10, 0, 0, 0, 0),
      new Date(2026, 5, 11, 0, 0, 0, 0),
      "day"
    );
    expect(rows).toHaveLength(1);
    expect(rowInput(rows[0]!)).toBe(1380); // 900 + 480
    expect(rows[0].output).toBe(120); // 100 + 20
    expect(rowTotal(rows[0]!)).toBe(1500);
    // bucket-level invariant
    expect(rowInput(rows[0]!) + rows[0]!.output).toBe(
      rowTotal(rows[0]!)
    );
  });

  it("computeTotals 逐源汇总,且 totalTokens == 各源之和", () => {
    const mk = (o: Partial<SourceUsage>): SourceUsage => ({ ...emptyUsage("ok"), ...o });
    const t = computeTotals([
      {
        bucketStart: "x",
        bucketEnd: "y",
        sources: {
          claude: mk({ freshInput: 900, output: 100 }),
          codex: mk({ freshInput: 550, output: 50 }),
          minimax: mk({}),
          kimi: mk({}),
          opencode: mk({}),
        },
      },
    ]);
    expect(inputTokens(t.sources.claude)).toBe(900);
    expect(t.sources.claude.output).toBe(100);
    expect(inputTokens(t.sources.codex)).toBe(550);
    expect(t.sources.codex.output).toBe(50);
    // 不变式:合计 == 逐源 totalTokens 之和(加源自动成立)
    expect(t.totalTokens).toBe(
      TOKEN_SOURCES.reduce((n, k) => n + totalTokens(t.sources[k]), 0)
    );
    expect(t.totalTokens).toBe(1600);
  });
  it("empty input → all-zero matrix, no NaN", () => {
    const t = computeTotals([]);
    expect(inputTokens(t.sources.claude)).toBe(0);
    expect(t.sources.claude.output).toBe(0);
    expect(inputTokens(t.sources.codex)).toBe(0);
    expect(t.sources.codex.output).toBe(0);
    expect(Number.isNaN(inputTokens(t.sources.claude))).toBe(false);
  });
});

describe("computeTotals —— 三态覆盖", () => {
  /** 造一个只有 claude/codex 计数的桶。省掉不关心的分量。 */
  const bucket = (
    c: Partial<SourceUsage>,
    x: Partial<SourceUsage> = {}
  ): WorkTokensTrendBucket => ({
    bucketStart: "x",
    bucketEnd: "y",
    sources: {
      claude: { ...emptyUsage("ok"), ...c },
      codex: { ...emptyUsage("ok"), ...x },
      minimax: emptyUsage("absent"),
      kimi: emptyUsage("absent"),
      opencode: emptyUsage("absent"),
    },
  });

  it("全部 full → coverage=full", () => {
    const t = computeTotals([
      bucket(
        { freshInput: 1000, sessionCount: 1, coveredSessionCount: 1 },
        { freshInput: 500, sessionCount: 1, coveredSessionCount: 1 }
      ),
    ]);
    expect(t.coverage).toBe("full");
    expect(t.totalTokens).toBe(1500);
    expect(t.sources.claude.share).toBeCloseTo(2 / 3);
    expect(t.coveredSessionCount).toBe(2);
    expect(t.totalSessionCount).toBe(2);
  });

  it("混合 → coverage=partial", () => {
    const t = computeTotals([
      bucket(
        { freshInput: 1000, sessionCount: 1, coveredSessionCount: 1 },
        { sessionCount: 1, unknownSessionCount: 1 }
      ),
    ]);
    expect(t.coverage).toBe("partial");
    expect(t.coveredSessionCount).toBe(1);
    expect(t.unknownSessionCount).toBe(1);
  });

  it("有会话但零覆盖 → coverage=unknown", () => {
    const t = computeTotals([
      bucket({ sessionCount: 2, unknownSessionCount: 1, errorSessionCount: 1 }),
    ]);
    expect(t.coverage).toBe("unknown");
    expect(t.coveredSessionCount).toBe(0);
  });

  it("零会话 → coverage=full(该记的都记了,不是「不知道」)", () => {
    const t = computeTotals([bucket({})]);
    expect(t.coverage).toBe("full");
    expect(t.totalSessionCount).toBe(0);
  });

  it("不变式:totalSessionCount == covered + unknown + error", () => {
    const t = computeTotals([
      bucket(
        { sessionCount: 3, coveredSessionCount: 1, unknownSessionCount: 1, errorSessionCount: 1 },
        { sessionCount: 2, coveredSessionCount: 2 }
      ),
    ]);
    expect(t.totalSessionCount).toBe(
      t.coveredSessionCount + t.unknownSessionCount + t.errorSessionCount
    );
    expect(t.totalSessionCount).toBe(5);
  });

  it("只有 session 单位的源参与汇总 —— minimax 没有覆盖概念", () => {
    const t = computeTotals([
      {
        bucketStart: "x",
        bucketEnd: "y",
        sources: {
          claude: { ...emptyUsage("ok"), sessionCount: 1, coveredSessionCount: 1 },
          codex: emptyUsage("ok"),
          // 即使给了计数也不该进汇总:它的 coverageUnit 是 null
          minimax: { ...emptyUsage("ok"), sessionCount: 99, coveredSessionCount: 99 },
          kimi: emptyUsage("absent"),
          opencode: emptyUsage("absent"),
        },
      },
    ]);
    expect(t.totalSessionCount).toBe(1);
    expect(t.coverageUnit).toBe("session");
  });
});

describe("computePreviousWindow (T-A5)", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = freshDb();
  });

  it("returns 0 (not null) when no prior sessions exist", () => {
    const t = computePreviousWindow(
      db,
      new Date(2026, 5, 3),
      new Date(2026, 5, 10)
    );
    expect(t.totalTokens).toBe(0);
    expect(t.bySource.claude.cacheReadInput).toBe(0);
  });

  it("strictly non-overlapping: counts only sessions in [from-span, from)", () => {
    // Current window: 2026-06-03..2026-06-10 → prev: 2026-05-27..2026-06-03
    seedSession(db, { source: "claude", total: 200, updated: "2026-05-30T10:00:00Z" }); // prev
    seedSession(db, { source: "codex", total: 300, updated: "2026-06-01T10:00:00Z" }); // prev
    seedSession(db, { source: "claude", total: 999, updated: "2026-06-05T10:00:00Z" }); // CURRENT, must be excluded
    const t = computePreviousWindow(
      db,
      new Date(2026, 5, 3),
      new Date(2026, 5, 10)
    );
    expect(t.totalTokens).toBe(500);
  });

  it("also returns Claude cache_read summed over the prior window (cache toggle)", () => {
    // prev window 2026-05-27..2026-06-03: one claude session with cache_read.
    seedSession(db, {
      source: "claude",
      total: 1000,
      cacheRead: 700,
      updated: "2026-05-30T10:00:00Z",
    });
    seedSession(db, { source: "codex", total: 300, updated: "2026-06-01T10:00:00Z" }); // no cache field
    const t = computePreviousWindow(
      db,
      new Date(2026, 5, 3),
      new Date(2026, 5, 10)
    );
    expect(t.totalTokens).toBe(1300);
    expect(t.bySource.claude.cacheReadInput).toBe(700); // only Claude contributes
  });
});

describe("computeMonthRange (T-B6)", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = freshDb();
  });

  it("returns earliest/latest YYYY-MM from token tables", () => {
    seedSession(db, { source: "claude", total: 0, updated: "2024-12-15T10:00:00Z" });
    seedSession(db, { source: "codex", total: 0, updated: "2026-06-10T10:00:00Z" });
    seedSession(db, { source: "claude", total: 0, updated: "2025-03-20T10:00:00Z" });
    const r = computeMonthRange(db, new Date(2026, 5, 11));
    // Local Shanghai: Dec 15 UTC → Dec 15 local, Jun 10 UTC → Jun 10 local.
    expect(r.earliest).toBe("2024-12");
    expect(r.latest).toBe("2026-06");
  });

  it("T-B6: returns current month for both bounds when tables are empty", () => {
    const r = computeMonthRange(db, new Date(2026, 5, 11));
    expect(r.earliest).toBe("2026-06");
    expect(r.latest).toBe("2026-06");
  });
});
