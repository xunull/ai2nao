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
  status: "full" | "unknown" | "error" = "full",
  io?: { input: number; output: number; cacheRead?: number; cacheCreation?: number }
): void {
  const input = io?.input ?? total;
  const output = io?.output ?? 0;
  const cacheRead = io?.cacheRead ?? 0;
  const cacheCreation = io?.cacheCreation ?? 0;
  db.prepare(
    `INSERT INTO claude_session_token_usage
       (session_id, project_id, file_path, file_mtime_ms, file_size_bytes,
        cwd, project_key, project_path, identity_confidence,
        title, created_at, last_updated_at,
        input_tokens, output_tokens, total_tokens,
        cache_read_input_tokens, cache_creation_input_tokens, token_status,
        parse_error, missing_since, source_seen_at, updated_at)
     VALUES (?, 'p', '/x', 0, 0, '/x', '/x', '/x', 'high',
             null, null, ?, ?, ?, ?, ?, ?, ?, null, null, ?, ?)`
  ).run(
    id,
    updated,
    input,
    output,
    total,
    cacheRead,
    cacheCreation,
    status,
    updated,
    updated
  );
}

function seedCodex(
  db: Database.Database,
  id: string,
  total: number,
  updated: string,
  io?: { input: number; output: number; reasoning?: number }
): void {
  const input = io?.input ?? total;
  const output = io?.output ?? 0;
  const reasoning = io?.reasoning ?? 0;
  db.prepare(
    `INSERT INTO codex_session_token_usage
       (session_id, rollout_path, rollout_mtime_ms, rollout_size_bytes,
        cwd, project_key, project_path, identity_confidence,
        title, model, git_branch, created_at, last_updated_at,
        input_tokens, output_tokens, total_tokens, reasoning_output_tokens, token_status,
        parse_error, missing_since, source_seen_at, updated_at)
     VALUES (?, '/r', 0, 0, '/x', '/x', '/x', 'high', null, null, null, null, ?,
             ?, ?, ?, ?, 'full', null, null, ?, ?)`
  ).run(id, updated, input, output, total, reasoning, updated, updated);
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

describe("generateTrend — input/output breakdown totals", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = freshDb();
  });

  it("window mode: totals expose per-source input/output + grand invariant", () => {
    seedClaude(db, "c1", 1000, "2026-06-09T16:30:00Z", "full", {
      input: 900,
      output: 100,
    });
    seedCodex(db, "x1", 600, "2026-06-09T17:00:00Z", {
      input: 550,
      output: 50,
    });
    const r = generateTrend(db, {
      window: "1w",
      now: new Date(2026, 5, 10, 12, 0, 0, 0),
    });
    if (r.mode !== "window") throw new Error("type narrow");
    expect(r.totals.claudeInputTokens).toBe(900);
    expect(r.totals.claudeOutputTokens).toBe(100);
    expect(r.totals.codexInputTokens).toBe(550);
    expect(r.totals.codexOutputTokens).toBe(50);
    expect(
      r.totals.claudeInputTokens +
        r.totals.claudeOutputTokens +
        r.totals.codexInputTokens +
        r.totals.codexOutputTokens
    ).toBe(r.totals.totalTokens);
  });

  it("month mode: totals also expose per-source input/output", () => {
    seedClaude(db, "c1", 1000, "2026-06-09T16:30:00Z", "full", {
      input: 800,
      output: 200,
    });
    const r = generateTrend(db, {
      month: "2026-06",
      now: new Date(2026, 5, 11, 12, 0, 0, 0),
    });
    if (r.mode !== "month") throw new Error("type narrow");
    expect(r.totals.claudeInputTokens).toBe(800);
    expect(r.totals.claudeOutputTokens).toBe(200);
    expect(r.totals.codexInputTokens).toBe(0);
    expect(r.totals.codexOutputTokens).toBe(0);
  });

  it("empty DB: breakdown is all-zero, no NaN", () => {
    const r = generateTrend(db, {
      window: "1w",
      now: new Date(2026, 5, 10, 12, 0, 0, 0),
    });
    if (r.mode !== "window") throw new Error("type narrow");
    expect(r.totals.claudeInputTokens).toBe(0);
    expect(r.totals.codexOutputTokens).toBe(0);
    expect(Number.isNaN(r.totals.claudeInputTokens)).toBe(false);
  });

  it("Claude cache split surfaces in totals; codex contributes 0", () => {
    // Claude: fused input 70585 = fresh 6 + creation 47655 + read 22924
    seedClaude(db, "c1", 70837, "2026-06-09T16:30:00Z", "full", {
      input: 70585,
      output: 252,
      cacheRead: 22924,
      cacheCreation: 47655,
    });
    // Codex has no cache concept — must not add to the cache totals
    seedCodex(db, "x1", 600, "2026-06-09T17:00:00Z", {
      input: 550,
      output: 50,
    });
    const r = generateTrend(db, {
      window: "1w",
      now: new Date(2026, 5, 10, 12, 0, 0, 0),
    });
    if (r.mode !== "window") throw new Error("type narrow");
    expect(r.totals.claudeCacheReadInputTokens).toBe(22924);
    expect(r.totals.claudeCacheCreationInputTokens).toBe(47655);
    // 真实新增 = claudeInput - read - creation
    const fresh =
      r.totals.claudeInputTokens -
      r.totals.claudeCacheReadInputTokens -
      r.totals.claudeCacheCreationInputTokens;
    expect(fresh).toBe(6);
    // cache fields are a subset of claude input (never exceed it)
    expect(
      r.totals.claudeCacheReadInputTokens +
        r.totals.claudeCacheCreationInputTokens
    ).toBeLessThanOrEqual(r.totals.claudeInputTokens);
  });

  it("Codex reasoning surfaces in totals; claude contributes 0", () => {
    // Codex output 600 includes 200 reasoning (subset)
    seedCodex(db, "x1", 600, "2026-06-09T17:00:00Z", {
      input: 550,
      output: 600,
      reasoning: 200,
    });
    // Claude has no reasoning concept — must not add to the reasoning total
    seedClaude(db, "c1", 1000, "2026-06-09T16:30:00Z", "full", {
      input: 900,
      output: 100,
    });
    const r = generateTrend(db, {
      window: "1w",
      now: new Date(2026, 5, 10, 12, 0, 0, 0),
    });
    if (r.mode !== "window") throw new Error("type narrow");
    expect(r.totals.codexReasoningOutputTokens).toBe(200);
    // reasoning is a subset of codex output (never exceeds it)
    expect(r.totals.codexReasoningOutputTokens).toBeLessThanOrEqual(
      r.totals.codexOutputTokens
    );
    // 正常输出 = output - reasoning
    expect(r.totals.codexOutputTokens - r.totals.codexReasoningOutputTokens).toBe(400);
  });

  it("month mode also exposes Codex reasoning", () => {
    seedCodex(db, "x1", 1000, "2026-06-09T16:30:00Z", {
      input: 400,
      output: 600,
      reasoning: 250,
    });
    const r = generateTrend(db, {
      month: "2026-06",
      now: new Date(2026, 5, 11, 12, 0, 0, 0),
    });
    if (r.mode !== "month") throw new Error("type narrow");
    expect(r.totals.codexReasoningOutputTokens).toBe(250);
  });

  it("month mode also exposes Claude cache split", () => {
    seedClaude(db, "c1", 1000, "2026-06-09T16:30:00Z", "full", {
      input: 1000,
      output: 0,
      cacheRead: 600,
      cacheCreation: 300,
    });
    const r = generateTrend(db, {
      month: "2026-06",
      now: new Date(2026, 5, 11, 12, 0, 0, 0),
    });
    if (r.mode !== "month") throw new Error("type narrow");
    expect(r.totals.claudeCacheReadInputTokens).toBe(600);
    expect(r.totals.claudeCacheCreationInputTokens).toBe(300);
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
