import { describe, expect, it, beforeEach, beforeAll, afterAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { openDatabase } from "../src/store/open.js";
import {
  computeMonthRange,
  computePreviousWindowTotal,
  computeTotals,
  mergeAndZeroFill,
  queryBucketsBySource,
} from "../src/workTokensTrend/queries.js";

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
  status?: "full" | "unknown" | "error";
  updated: string; // ISO UTC
  missingSince?: string | null;
};

let seq = 0;
function seedSession(db: Database.Database, row: SeedRow): void {
  seq += 1;
  const id = row.session_id ?? `s-${seq}-${row.source}`;
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
          input_tokens, output_tokens, total_tokens, token_status,
          parse_error, missing_since, source_seen_at, updated_at)
       VALUES (?, ?, ?, 0, 0, ?, ?, ?, 'high',
               null, null, ?, 0, 0, ?, ?, null, ?, ?, ?)`
    ).run(
      id,
      row.project_id ?? "p-test",
      row.file_path ?? "/tmp/x.jsonl",
      row.cwd ?? "/tmp/test",
      row.project_key ?? "/tmp/test",
      row.project_path ?? "/tmp/test",
      row.updated,
      row.total,
      row.status ?? "full",
      row.missingSince ?? null,
      row.updated,
      row.updated
    );
    return;
  }
  // Codex
  db.prepare(
    `INSERT INTO codex_session_token_usage
       (session_id, rollout_path, rollout_mtime_ms, rollout_size_bytes,
        cwd, project_key, project_path, identity_confidence,
        title, model, git_branch, created_at, last_updated_at,
        input_tokens, output_tokens, total_tokens, token_status,
        parse_error, missing_since, source_seen_at, updated_at)
     VALUES (?, ?, 0, 0, ?, ?, ?, 'high', null, null, null, null, ?,
             0, 0, ?, ?, null, ?, ?, ?)`
  ).run(
    id,
    row.file_path ?? "/tmp/r.jsonl",
    row.cwd ?? "/tmp/test",
    row.project_key ?? "/tmp/test",
    row.project_path ?? "/tmp/test",
    row.updated,
    row.total,
    row.status ?? "full",
    row.missingSince ?? null,
    row.updated,
    row.updated
  );
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

    const rows = queryBucketsBySource(
      db,
      "claude",
      new Date(2026, 5, 10, 0, 0, 0, 0),
      new Date(2026, 5, 11, 0, 0, 0, 0),
      "day"
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].bucket_key).toBe("2026-06-10");
    expect(rows[0].total_tokens).toBe(1500);
    expect(rows[0].session_count).toBe(2);
    expect(rows[0].full_count).toBe(2);
  });

  it("T-A4 (F2): unknown and error session counts are separate fields", () => {
    seedSession(db, { source: "claude", total: 1000, status: "full", updated: "2026-06-09T16:30:00Z" });
    seedSession(db, { source: "claude", total: 0, status: "unknown", updated: "2026-06-09T16:35:00Z" });
    seedSession(db, { source: "claude", total: 0, status: "error", updated: "2026-06-09T16:40:00Z" });
    seedSession(db, { source: "claude", total: 0, status: "error", updated: "2026-06-09T16:45:00Z" });

    const rows = queryBucketsBySource(
      db,
      "claude",
      new Date(2026, 5, 10, 0, 0, 0, 0),
      new Date(2026, 5, 11, 0, 0, 0, 0),
      "day"
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].total_tokens).toBe(1000); // only `full` contributes
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

    const rows = queryBucketsBySource(
      db,
      "claude",
      new Date(2026, 5, 10, 0, 0, 0, 0),
      new Date(2026, 5, 11, 0, 0, 0, 0),
      "day"
    );
    expect(rows[0].total_tokens).toBe(1000);
    expect(rows[0].session_count).toBe(1);
  });

  it("T-B2 (F8): empty result returns empty array, does not throw", () => {
    const rows = queryBucketsBySource(
      db,
      "claude",
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
    const rows = queryBucketsBySource(
      db,
      "claude",
      new Date(2026, 5, 10, 0, 0, 0, 0),
      new Date(2026, 5, 11, 0, 0, 0, 0),
      "day"
    );
    expect(rows[0].total_tokens).toBe(100);
  });
});

describe("mergeAndZeroFill", () => {
  it("fills missing buckets with zeros for the missing source", () => {
    const buckets = [
      { key: "2026-06-10", start: new Date(2026, 5, 10), end: new Date(2026, 5, 11) },
      { key: "2026-06-11", start: new Date(2026, 5, 11), end: new Date(2026, 5, 12) },
    ];
    const merged = mergeAndZeroFill(
      buckets,
      [
        {
          bucket_key: "2026-06-10",
          total_tokens: 1000,
          session_count: 2,
          full_count: 2,
          unknown_count: 0,
          error_count: 0,
        },
      ],
      []
    );
    expect(merged).toHaveLength(2);
    expect(merged[0].claudeTokens).toBe(1000);
    expect(merged[0].codexTokens).toBe(0);
    expect(merged[1].claudeTokens).toBe(0);
    expect(merged[1].codexTokens).toBe(0);
  });
});

describe("computeTotals (3-state coverage)", () => {
  it("returns coverage='full' when all sessions have token_status='full'", () => {
    const t = computeTotals([
      {
        bucketStart: "x",
        bucketEnd: "y",
        claudeTokens: 1000,
        codexTokens: 500,
        claudeSessionCount: 1,
        codexSessionCount: 1,
        claudeCoveredSessionCount: 1,
        codexCoveredSessionCount: 1,
        claudeUnknownSessionCount: 0,
        codexUnknownSessionCount: 0,
        claudeErrorSessionCount: 0,
        codexErrorSessionCount: 0,
      },
    ]);
    expect(t.coverage).toBe("full");
    expect(t.totalTokens).toBe(1500);
    expect(t.claudeShare).toBeCloseTo(2 / 3);
    expect(t.coveredSessionCount).toBe(2);
    expect(t.unknownSessionCount).toBe(0);
    expect(t.errorSessionCount).toBe(0);
    expect(t.totalSessionCount).toBe(2);
  });

  it("returns coverage='partial' when mixed", () => {
    const t = computeTotals([
      {
        bucketStart: "x",
        bucketEnd: "y",
        claudeTokens: 1000,
        codexTokens: 0,
        claudeSessionCount: 2,
        codexSessionCount: 0,
        claudeCoveredSessionCount: 1,
        codexCoveredSessionCount: 0,
        claudeUnknownSessionCount: 1,
        codexUnknownSessionCount: 0,
        claudeErrorSessionCount: 0,
        codexErrorSessionCount: 0,
      },
    ]);
    expect(t.coverage).toBe("partial");
    expect(t.totalSessionCount).toBe(2);
    expect(t.coveredSessionCount).toBe(1);
    expect(t.unknownSessionCount).toBe(1);
  });

  it("returns coverage='unknown' when zero covered sessions but some sessions exist", () => {
    const t = computeTotals([
      {
        bucketStart: "x",
        bucketEnd: "y",
        claudeTokens: 0,
        codexTokens: 0,
        claudeSessionCount: 1,
        codexSessionCount: 0,
        claudeCoveredSessionCount: 0,
        codexCoveredSessionCount: 0,
        claudeUnknownSessionCount: 1,
        codexUnknownSessionCount: 0,
        claudeErrorSessionCount: 0,
        codexErrorSessionCount: 0,
      },
    ]);
    expect(t.coverage).toBe("unknown");
  });

  it("invariant: totalSessionCount = covered + unknown + error", () => {
    const t = computeTotals([
      {
        bucketStart: "x",
        bucketEnd: "y",
        claudeTokens: 0,
        codexTokens: 0,
        claudeSessionCount: 3,
        codexSessionCount: 2,
        claudeCoveredSessionCount: 1,
        codexCoveredSessionCount: 1,
        claudeUnknownSessionCount: 1,
        codexUnknownSessionCount: 0,
        claudeErrorSessionCount: 1,
        codexErrorSessionCount: 1,
      },
    ]);
    expect(t.totalSessionCount).toBe(
      t.coveredSessionCount + t.unknownSessionCount + t.errorSessionCount
    );
  });
});

describe("computePreviousWindowTotal (T-A5)", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = freshDb();
  });

  it("returns 0 (not null) when no prior sessions exist", () => {
    const t = computePreviousWindowTotal(
      db,
      new Date(2026, 5, 3),
      new Date(2026, 5, 10)
    );
    expect(t).toBe(0);
  });

  it("strictly non-overlapping: counts only sessions in [from-span, from)", () => {
    // Current window: 2026-06-03..2026-06-10 → prev: 2026-05-27..2026-06-03
    seedSession(db, { source: "claude", total: 200, updated: "2026-05-30T10:00:00Z" }); // prev
    seedSession(db, { source: "codex", total: 300, updated: "2026-06-01T10:00:00Z" }); // prev
    seedSession(db, { source: "claude", total: 999, updated: "2026-06-05T10:00:00Z" }); // CURRENT, must be excluded
    const t = computePreviousWindowTotal(
      db,
      new Date(2026, 5, 3),
      new Date(2026, 5, 10)
    );
    expect(t).toBe(500);
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
