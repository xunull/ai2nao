import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { openDatabase } from "../src/store/open.js";
import {
  extractClaudeSessionUsage,
  extractClaudeTokenEvents,
} from "../src/claudeCodeHistory/normalize.js";
import { parseJsonlText } from "../src/claudeCodeHistory/parseJsonl.js";
import { replaceClaudeTokenUsageEvents } from "../src/claudeTokenUsage/queries.js";
import { queryBucketsBySourceLegacy as queryBucketsBySource } from "../src/workTokensTrend/legacyShape.js";
import type { ClaudeTokenEvent } from "../src/claudeCodeHistory/normalize.js";

/**
 * Regression (2026-07-01 /investigate): a Claude Code session resumed across
 * many days keeps ONE session row whose cumulative lifetime total was bucketed
 * on `last_updated_at`, dumping weeks of tokens onto the last-touch day (7/01
 * had 15 sessions, only 1 created that day; the rest 2-31 days old). Fix: bucket
 * Claude tokens by each deduped message's own timestamp (claude_token_usage_event),
 * mirror of the Codex v30 fix.
 */

const PRIOR_TZ = process.env.TZ;
beforeAll(() => {
  process.env.TZ = "Asia/Shanghai";
});
afterAll(() => {
  process.env.TZ = PRIOR_TZ;
});

/** One assistant JSONL line. `input` is the raw (uncached) input; the extractor
 *  FUSES it with cache into `input_tokens`. */
function assistantLine(opts: {
  id: string | null;
  ts: string | null;
  input: number;
  output: number;
  cacheRead?: number;
  cacheCreation?: number;
}): string {
  const message: Record<string, unknown> = {
    role: "assistant",
    usage: {
      input_tokens: opts.input,
      output_tokens: opts.output,
      cache_read_input_tokens: opts.cacheRead ?? 0,
      cache_creation_input_tokens: opts.cacheCreation ?? 0,
    },
  };
  if (opts.id) message.id = opts.id;
  const rec: Record<string, unknown> = { type: "assistant", message };
  if (opts.ts) rec.timestamp = opts.ts;
  return JSON.stringify(rec);
}

describe("extractClaudeTokenEvents", () => {
  it("golden invariant: SUM(events, per field) == session total", () => {
    const transcript = [
      assistantLine({ id: "m1", ts: "2026-06-15T02:00:00.000Z", input: 100, output: 20, cacheRead: 60, cacheCreation: 10 }),
      assistantLine({ id: "m2", ts: "2026-06-16T03:00:00.000Z", input: 5, output: 8, cacheRead: 200, cacheCreation: 15 }),
    ].join("\n");
    const parse = parseJsonlText(transcript);
    const events = extractClaudeTokenEvents(parse, { fallbackIso: "2026-06-15T00:00:00.000Z" });
    const total = extractClaudeSessionUsage(parse)!;
    const sum = (f: keyof ClaudeTokenEvent) =>
      events.reduce((a, e) => a + (e[f] as number), 0);
    expect(sum("input_tokens")).toBe(total.totalInputTokens);
    expect(sum("output_tokens")).toBe(total.totalOutputTokens);
    expect(sum("cache_read_input_tokens")).toBe(total.totalCacheReadInputTokens);
    expect(sum("cache_creation_input_tokens")).toBe(total.totalCacheCreationInputTokens);
    // input_tokens is FUSED: 100+60+10 = 170 and 5+200+15 = 220.
    expect(events.find((e) => e.message_id === "m1")?.input_tokens).toBe(170);
    expect(events.find((e) => e.message_id === "m2")?.input_tokens).toBe(220);
  });

  it("dedupes streaming/content-block repeats by message.id — counts once", () => {
    // Same message.id repeated 3× (streaming lines): output grows, cache fixed.
    const transcript = [
      assistantLine({ id: "m1", ts: "2026-06-15T02:00:00.000Z", input: 10, output: 2, cacheRead: 500 }),
      assistantLine({ id: "m1", ts: "2026-06-15T02:00:01.000Z", input: 10, output: 5, cacheRead: 500 }),
      assistantLine({ id: "m1", ts: "2026-06-15T02:00:02.000Z", input: 10, output: 9, cacheRead: 500 }),
    ].join("\n");
    const events = extractClaudeTokenEvents(parseJsonlText(transcript), { fallbackIso: "2026-06-15T00:00:00.000Z" });
    expect(events).toHaveLength(1);
    // MAX per field: output final 9, cache_read counted ONCE (500, not 1500).
    expect(events[0].output_tokens).toBe(9);
    expect(events[0].cache_read_input_tokens).toBe(500);
    expect(events[0].input_tokens).toBe(510); // 10 + 500
  });

  it("carries each message's own timestamp", () => {
    const transcript = [
      assistantLine({ id: "m1", ts: "2026-06-15T02:00:00.000Z", input: 10, output: 4 }),
      assistantLine({ id: "m2", ts: "2026-06-16T03:00:00.000Z", input: 30, output: 9 }),
    ].join("\n");
    const events = extractClaudeTokenEvents(parseJsonlText(transcript), { fallbackIso: "2026-01-01T00:00:00.000Z" });
    expect(events.map((e) => e.event_at).sort()).toEqual([
      "2026-06-15T02:00:00.000Z",
      "2026-06-16T03:00:00.000Z",
    ]);
  });

  it("falls back to the provided created_at (never last_updated) when a message has no timestamp", () => {
    const transcript = assistantLine({ id: "m1", ts: null, input: 10, output: 4 });
    const events = extractClaudeTokenEvents(parseJsonlText(transcript), { fallbackIso: "2026-06-09T00:00:00.000Z" });
    expect(events[0].event_at).toBe("2026-06-09T00:00:00.000Z");
  });
});

describe("queryBucketsBySource — Claude multi-day session spreads by event day", () => {
  function freshDb(): Database.Database {
    const dir = mkdtempSync(join(tmpdir(), "ai2nao-claude-daily-"));
    return openDatabase(join(dir, "test.db"));
  }

  function seedClaudeSession(
    db: Database.Database,
    id: string,
    lastUpdated: string,
    opts: { tokenStatus?: string; missingSince?: string | null } = {}
  ): void {
    db.prepare(
      `INSERT INTO claude_session_token_usage
         (session_id, project_id, file_path, file_mtime_ms, file_size_bytes,
          cwd, project_key, project_path, identity_confidence, title,
          created_at, last_updated_at, input_tokens, output_tokens, total_tokens,
          cache_read_input_tokens, cache_creation_input_tokens, model,
          token_status, parse_error, missing_since, source_seen_at, updated_at,
          preview, message_count)
       VALUES (?, 'p', '/f', 0, 0, '/w', '/w', '/w', 'high', null,
               ?, ?, 0, 0, 0, 0, 0, null, ?, null, ?, ?, ?, null, 0)`
    ).run(
      id,
      lastUpdated,
      lastUpdated,
      opts.tokenStatus ?? "full",
      opts.missingSince ?? null,
      lastUpdated,
      lastUpdated
    );
  }

  function ev(session_id: string, event_at: string, input: number, output: number, cacheRead = 0, cacheCreation = 0): ClaudeTokenEvent & { session_id: string } {
    return { session_id, message_id: `${session_id}-${event_at}`, event_at, input_tokens: input, output_tokens: output, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: cacheCreation };
  }

  it("buckets tokens on the day consumed, not the last-updated day (regression)", () => {
    const db = freshDb();
    // Session created 6/09-ish, last-updated 6/18, consuming tokens 6/15..6/18.
    seedClaudeSession(db, "long-1", "2026-06-18T09:00:00Z");
    replaceClaudeTokenUsageEvents(db, "long-1", [
      ev("long-1", "2026-06-15T02:00:00Z", 100, 20, 60, 5),
      ev("long-1", "2026-06-16T02:00:00Z", 200, 30, 120, 7),
      ev("long-1", "2026-06-18T01:00:00Z", 50, 10, 20, 2),
    ]);

    const rows = queryBucketsBySource(
      db,
      "claude",
      new Date(2026, 5, 15, 0, 0, 0, 0),
      new Date(2026, 5, 19, 0, 0, 0, 0),
      "day"
    );
    const byDay = new Map(rows.map((r) => [r.bucket_key, r]));
    // NOT all collapsed onto 6/18.
    expect(byDay.get("2026-06-15")?.total_tokens).toBe(120);
    expect(byDay.get("2026-06-16")?.total_tokens).toBe(230);
    expect(byDay.get("2026-06-18")?.total_tokens).toBe(60);
    expect(byDay.has("2026-06-17")).toBe(false);
    // cache split preserved per day (powers the cache toggle + breakdown).
    expect(byDay.get("2026-06-16")?.input_tokens).toBe(200);
    expect(byDay.get("2026-06-16")?.cache_read_input_tokens).toBe(120);
    expect(byDay.get("2026-06-16")?.cache_creation_input_tokens).toBe(7);
  });

  it("token>0 with session_count=0 when the session was last touched in a later bucket", () => {
    const db = freshDb();
    seedClaudeSession(db, "long-2", "2026-06-20T09:00:00Z"); // last-updated 6/20
    replaceClaudeTokenUsageEvents(db, "long-2", [ev("long-2", "2026-06-15T02:00:00Z", 100, 20)]);
    const rows = queryBucketsBySource(db, "claude", new Date(2026, 5, 15, 0), new Date(2026, 5, 16, 0), "day");
    const d15 = rows.find((r) => r.bucket_key === "2026-06-15");
    expect(d15?.total_tokens).toBe(120);
    expect(d15?.session_count).toBe(0); // last touched 6/20, not 6/15 — honest
  });

  it("excludes events of missing / non-full sessions (JOIN re-applies filters)", () => {
    const db = freshDb();
    seedClaudeSession(db, "gone", "2026-06-16T09:00:00Z", { missingSince: "2026-06-17T00:00:00Z" });
    seedClaudeSession(db, "errored", "2026-06-16T09:00:00Z", { tokenStatus: "error" });
    replaceClaudeTokenUsageEvents(db, "gone", [ev("gone", "2026-06-16T02:00:00Z", 999, 9)]);
    replaceClaudeTokenUsageEvents(db, "errored", [ev("errored", "2026-06-16T02:00:00Z", 888, 8)]);
    const rows = queryBucketsBySource(db, "claude", new Date(2026, 5, 15, 0), new Date(2026, 5, 19, 0), "day");
    expect(rows.reduce((a, r) => a + r.total_tokens, 0)).toBe(0);
  });

  it("replace is idempotent — re-inserting a session's events does not double-count", () => {
    const db = freshDb();
    seedClaudeSession(db, "s", "2026-06-15T09:00:00Z");
    const events = [ev("s", "2026-06-15T02:00:00Z", 100, 20)];
    replaceClaudeTokenUsageEvents(db, "s", events);
    replaceClaudeTokenUsageEvents(db, "s", events); // second refresh, same data
    const rows = queryBucketsBySource(db, "claude", new Date(2026, 5, 15, 0), new Date(2026, 5, 16, 0), "day");
    expect(rows.find((r) => r.bucket_key === "2026-06-15")?.total_tokens).toBe(120);
  });
});
