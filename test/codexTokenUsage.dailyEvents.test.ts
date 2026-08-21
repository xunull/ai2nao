import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { openDatabase } from "../src/store/open.js";
import {
  extractCodexSessionUsage,
  extractCodexUsageEvents,
} from "../src/codexHistory/normalize.js";
import { parseJsonlText } from "../src/localJsonl/parse.js";
import { replaceCodexTokenUsageEvents } from "../src/codexTokenUsage/queries.js";
import { ADAPTERS } from "../src/workTokensTrend/adapters.js";
import { rowInput, rowTotal } from "./fixtures/sourceRow.js";

/**
 * Regression (2026-06-18 /investigate): a Codex session resumed across many
 * days appends to ONE rollout, so bucketing its total on `last_updated_at`
 * collapsed a week of usage onto the final day — recent-days views showed
 * "no Codex" even when Codex ran heavily every day. Fix: bucket Codex tokens
 * by each `token_count` event's own timestamp (codex_token_usage_event).
 */

const PRIOR_TZ = process.env.TZ;
beforeAll(() => {
  process.env.TZ = "Asia/Shanghai";
});
afterAll(() => {
  process.env.TZ = PRIOR_TZ;
});

function tokenCountTotal(
  ts: string,
  input: number,
  output: number,
  reasoning = 0,
  cached = 0
) {
  return JSON.stringify({
    type: "event_msg",
    timestamp: ts,
    payload: {
      type: "token_count",
      info: {
        total_token_usage: {
          input_tokens: input,
          output_tokens: output,
          reasoning_output_tokens: reasoning,
          cached_input_tokens: cached,
        },
      },
    },
  });
}

describe("extractCodexUsageEvents", () => {
  it("per-event deltas sum to the session total (口径一致)", () => {
    // Cumulative totals across 3 events on 2 different local days.
    const transcript = [
      JSON.stringify({ type: "session_meta", timestamp: "2026-06-15T01:00:00.000Z", payload: { cwd: "/w" } }),
      tokenCountTotal("2026-06-15T02:00:00.000Z", 10, 4, 2, 6),
      tokenCountTotal("2026-06-15T10:00:00.000Z", 30, 9, 5, 18),
      tokenCountTotal("2026-06-16T03:00:00.000Z", 55, 14, 6, 33),
    ].join("\n");
    const parse = parseJsonlText(transcript);

    const events = extractCodexUsageEvents(parse);
    expect(events).toHaveLength(3);

    const sumInput = events.reduce((a, e) => a + e.usage.inputTokens, 0);
    const sumOutput = events.reduce((a, e) => a + e.usage.outputTokens, 0);
    const sumReason = events.reduce((a, e) => a + e.usage.reasoningOutputTokens, 0);
    const sumCached = events.reduce((a, e) => a + e.usage.cachedInputTokens, 0);

    const total = extractCodexSessionUsage(parse);
    expect(sumInput).toBe(total?.totalInputTokens);
    expect(sumOutput).toBe(total?.totalOutputTokens);
    expect(sumReason).toBe(total?.totalReasoningOutputTokens);
    expect(sumCached).toBe(total?.totalCachedInputTokens);
    // sanity: cumulative 55/14 → final totals; cached delta 6 + 12 + 15 = 33.
    expect(total).toEqual({
      totalInputTokens: 55,
      totalOutputTokens: 14,
      totalReasoningOutputTokens: 6,
      totalCachedInputTokens: 33,
    });
  });

  it("carries each event's own timestamp", () => {
    const transcript = [
      tokenCountTotal("2026-06-15T02:00:00.000Z", 10, 4),
      tokenCountTotal("2026-06-16T03:00:00.000Z", 30, 9),
    ].join("\n");
    const events = extractCodexUsageEvents(parseJsonlText(transcript));
    expect(events.map((e) => e.at)).toEqual([
      "2026-06-15T02:00:00.000Z",
      "2026-06-16T03:00:00.000Z",
    ]);
  });
});

describe("queryBucketsBySource — Codex multi-day session spreads by event day", () => {
  function freshDb(): Database.Database {
    const dir = mkdtempSync(join(tmpdir(), "ai2nao-codex-daily-"));
    return openDatabase(join(dir, "test.db"));
  }

  function seedCodexSession(db: Database.Database, id: string, lastUpdated: string): void {
    db.prepare(
      `INSERT INTO codex_session_token_usage
         (session_id, rollout_path, rollout_mtime_ms, rollout_size_bytes,
          cwd, project_key, project_path, identity_confidence,
          title, model, git_branch, created_at, last_updated_at,
          input_tokens, output_tokens, total_tokens, reasoning_output_tokens, token_status,
          parse_error, missing_since, source_seen_at, updated_at)
       VALUES (?, '/r', 0, 0, '/w', '/w', '/w', 'high', null, null, null, null, ?,
               0, 0, 0, 0, 'full', null, null, ?, ?)`
    ).run(id, lastUpdated, lastUpdated, lastUpdated);
  }

  it("buckets tokens on the day consumed, not the last-updated day", () => {
    const db = freshDb();
    // One session last-updated 6/18, but consuming tokens 6/15..6/18.
    seedCodexSession(db, "long-1", "2026-06-18T09:00:00Z");
    replaceCodexTokenUsageEvents(db, "long-1", [
      // Local Asia/Shanghai: UTC 6/15 02:00 → local 6/15 10:00
      { session_id: "long-1", event_at: "2026-06-15T02:00:00Z", input_tokens: 100, output_tokens: 20, reasoning_output_tokens: 5, cached_input_tokens: 60 },
      { session_id: "long-1", event_at: "2026-06-16T02:00:00Z", input_tokens: 200, output_tokens: 30, reasoning_output_tokens: 7, cached_input_tokens: 120 },
      { session_id: "long-1", event_at: "2026-06-18T01:00:00Z", input_tokens: 50, output_tokens: 10, reasoning_output_tokens: 2, cached_input_tokens: 20 },
    ]);

    const rows = ADAPTERS.codex.queryBuckets(
      db,
      new Date(2026, 5, 15, 0, 0, 0, 0),
      new Date(2026, 5, 19, 0, 0, 0, 0),
      "day"
    );
    const byDay = new Map(rows.map((r) => [r.bucket_key, r]));

    // 6/15: 100+20, 6/16: 200+30, 6/18: 50+10 — NOT all collapsed onto 6/18.
    expect(rowTotal(byDay.get("2026-06-15")!)).toBe(120);
    expect(rowTotal(byDay.get("2026-06-16")!)).toBe(230);
    expect(rowTotal(byDay.get("2026-06-18")!)).toBe(60);
    // 6/17 had no events → absent from rows (zero-filled later by the service).
    expect(byDay.has("2026-06-17")).toBe(false);

    // input/output/reasoning split is preserved per day.
    expect(rowInput(byDay.get("2026-06-16")!)).toBe(200);
    expect(byDay.get("2026-06-16")!.output).toBe(30);
    expect(byDay.get("2026-06-16")!.reasoning_output).toBe(7);
    expect(byDay.get("2026-06-16")!.cache_read_input).toBe(120);

    // grand total across days equals the session's full consumption.
    const grand = rows.reduce((a, r) => a + rowTotal(r), 0);
    expect(grand).toBe(120 + 230 + 60);
  });

  it("excludes events of missing / non-full sessions (JOIN re-applies filters)", () => {
    const db = freshDb();
    seedCodexSession(db, "gone", "2026-06-16T09:00:00Z");
    db.prepare(
      "UPDATE codex_session_token_usage SET missing_since = ? WHERE session_id = 'gone'"
    ).run("2026-06-17T00:00:00Z");
    replaceCodexTokenUsageEvents(db, "gone", [
      { session_id: "gone", event_at: "2026-06-16T02:00:00Z", input_tokens: 999, output_tokens: 9, reasoning_output_tokens: 0, cached_input_tokens: 0 },
    ]);

    const rows = ADAPTERS.codex.queryBuckets(
      db,
      new Date(2026, 5, 15, 0, 0, 0, 0),
      new Date(2026, 5, 19, 0, 0, 0, 0),
      "day"
    );
    const total = rows.reduce((a, r) => a + rowTotal(r), 0);
    expect(total).toBe(0);
  });
});
