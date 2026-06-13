import { describe, expect, it, beforeEach, beforeAll, afterAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { openDatabase } from "../src/store/open.js";
import { generateTrend } from "../src/workTokensTrend/service.js";

const PRIOR_TZ = process.env.TZ;
beforeAll(() => {
  process.env.TZ = "Asia/Shanghai";
});
afterAll(() => {
  process.env.TZ = PRIOR_TZ;
});

function freshDb(): Database.Database {
  const dir = mkdtempSync(join(tmpdir(), "ai2nao-tokens-trend-s-"));
  return openDatabase(join(dir, "test.db"));
}

function seedClaude(
  db: Database.Database,
  id: string,
  total: number,
  updated: string,
  status: "full" | "unknown" | "error" = "full"
): void {
  db.prepare(
    `INSERT INTO claude_session_token_usage
       (session_id, project_id, file_path, file_mtime_ms, file_size_bytes,
        cwd, project_key, project_path, identity_confidence,
        title, created_at, last_updated_at,
        input_tokens, output_tokens, total_tokens, token_status,
        parse_error, missing_since, source_seen_at, updated_at)
     VALUES (?, 'p', '/x', 0, 0, '/x', '/x', '/x', 'high',
             null, null, ?, 0, 0, ?, ?, null, null, ?, ?)`
  ).run(id, updated, total, status, updated, updated);
}

describe("generateTrend — window mode (happy)", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = freshDb();
  });

  it("default-to-1w when no params provided", () => {
    const r = generateTrend(db, { now: new Date(2026, 5, 10, 12, 0, 0, 0) });
    expect(r.mode).toBe("window");
    if (r.mode !== "window") throw new Error("type narrow");
    expect(r.windowKey).toBe("1w");
    expect(r.bucketGranularity).toBe("day");
    expect(r.buckets.length).toBeGreaterThan(0);
  });

  it("respects explicit window=1d → 24 hour buckets", () => {
    const r = generateTrend(db, {
      window: "1d",
      now: new Date(2026, 5, 10, 12, 0, 0, 0),
    });
    if (r.mode !== "window") throw new Error("type narrow");
    expect(r.windowKey).toBe("1d");
    expect(r.bucketGranularity).toBe("hour");
    expect(r.buckets.length).toBe(24);
  });

  it("returns previousWindowTotal=0 and deltaRatio=null with empty DB", () => {
    const r = generateTrend(db, {
      window: "1w",
      now: new Date(2026, 5, 10, 12, 0, 0, 0),
    });
    if (r.mode !== "window") throw new Error("type narrow");
    expect(r.previousWindowTotal).toBe(0);
    expect(r.deltaRatio).toBeNull();
  });
});

describe("generateTrend — month mode (happy)", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = freshDb();
  });

  it("returns day-bucketed response for a given month", () => {
    seedClaude(db, "s1", 1000, "2026-06-09T16:30:00Z");
    const r = generateTrend(db, {
      month: "2026-06",
      now: new Date(2026, 5, 11, 12, 0, 0, 0),
    });
    expect(r.mode).toBe("month");
    if (r.mode !== "month") throw new Error("type narrow");
    expect(r.monthKey).toBe("2026-06");
    expect(r.bucketGranularity).toBe("day");
    expect(r.buckets.length).toBe(30); // June has 30 days
    expect(r.totals.totalTokens).toBe(1000);
  });
});

describe("generateTrend — param validation", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = freshDb();
  });

  it("T-B3 (F8): month wins when both window and month are passed", () => {
    const r = generateTrend(db, {
      window: "1d",
      month: "2026-05",
      now: new Date(2026, 5, 11),
    });
    expect(r.mode).toBe("month");
    if (r.mode !== "month") throw new Error("type narrow");
    expect(r.monthKey).toBe("2026-05");
  });

  it("throws on invalid window value", () => {
    expect(() =>
      generateTrend(db, { window: "99d" as never })
    ).toThrow(/invalid window/);
  });

  it("throws on invalid month format", () => {
    expect(() => generateTrend(db, { month: "2026-13" })).toThrow();
  });

  it("T-B4 (F8): rejects month older than 24 months back", () => {
    expect(() =>
      generateTrend(db, {
        month: "2023-05",
        now: new Date(2026, 5, 11),
      })
    ).toThrow(/older than 24/);
  });
});

describe("generateTrend — diagnostics (source-level resilience)", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = freshDb();
  });

  it("returns empty buckets + zero totals when both tables are empty", () => {
    const r = generateTrend(db, {
      window: "1w",
      now: new Date(2026, 5, 10, 12, 0, 0, 0),
    });
    expect(r.totals.totalTokens).toBe(0);
    expect(r.totals.coverage).toBe("full"); // zero sessions = trivially full
    expect(r.diagnostics).toEqual([]);
  });
});
