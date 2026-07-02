import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { openDatabase } from "../src/store/open.js";
import {
  refreshMinimaxTokenUsage,
  parseChargeRecord,
  type MinimaxAmountFetch,
} from "../src/minimaxTokenUsage/refresh.js";
import { queryBucketsBySource } from "../src/workTokensTrend/queries.js";
import { generateTrend } from "../src/workTokensTrend/service.js";

const PRIOR_TZ = process.env.TZ;
beforeAll(() => {
  process.env.TZ = "Asia/Shanghai";
});
afterAll(() => {
  process.env.TZ = PRIOR_TZ;
});

function freshDb(): Database.Database {
  const dir = mkdtempSync(join(tmpdir(), "ai2nao-minimax-"));
  return openDatabase(join(dir, "test.db"));
}

const M = "MiniMax-M3-512k";
const CACHE_READ = "cache-read(Text API)";
const CACHE_CREATE = "cache-create(Text API)";
const CHAT = "chatcompletion-v2(Text API)";

/** Build one charge_record (fields are strings, like the real API). */
function rec(
  method: string,
  input: number,
  output: number,
  createdAtSec: number,
  extra: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    method,
    model: M,
    consume_input_token: String(input),
    consume_output_token: String(output),
    consume_token: String(input + output),
    created_at: createdAtSec,
    api_token_name: "coding_plan",
    consume_cash: "0.0000",
    status: "SUCCESS",
    ...extra,
  };
}

/** Fetch stub: serves `records` (newest-first) as pages of `limit`. */
function pagedFetch(records: Record<string, unknown>[]): MinimaxAmountFetch {
  return async (url: string) => {
    const u = new URL(url);
    const page = parseInt(u.searchParams.get("page") ?? "1", 10);
    const limit = parseInt(u.searchParams.get("limit") ?? "100", 10);
    const slice = records.slice((page - 1) * limit, page * limit);
    return {
      charge_records: slice,
      base_resp: { status_code: 0, status_msg: "success" },
    };
  };
}

// Round-hour Beijing epochs (seconds). 1782788400 = 2026-06-30 11:00 Beijing.
const T_0630 = 1782788400; // 2026-06-30 11:00 (北京)
const T_0629 = 1782788400 - 24 * 3600; // 2026-06-29 11:00 (北京)
const NOW = new Date("2026-07-02T00:00:00Z");

describe("parseChargeRecord", () => {
  it("golden: consume_token == input + output; maps method/model/timestamp", () => {
    const e = parseChargeRecord(rec(CHAT, 16484, 1146, T_0630))!;
    expect(e.input_tokens + e.output_tokens).toBe(
      Number(rec(CHAT, 16484, 1146, T_0630).consume_token)
    );
    expect(e.method).toBe(CHAT);
    expect(e.model).toBe(M);
    expect(e.event_at).toBe(new Date(T_0630 * 1000).toISOString());
    expect(e.consume_cash).toBe("0.0000");
  });

  it("drops non-usage account events (code_plan_purchase) and 0-token rows", () => {
    expect(parseChargeRecord(rec("code_plan_purchase", 0, 0, T_0630))).toBeNull();
    expect(parseChargeRecord(rec(CHAT, 0, 0, T_0630))).toBeNull();
    // timeless record → cannot bucket → dropped
    expect(parseChargeRecord(rec(CHAT, 100, 0, 0))).toBeNull();
  });

  it("keeps unknown future methods verbatim (not silently dropped)", () => {
    const e = parseChargeRecord(rec("chatcompletion-v3(Text API)", 50, 5, T_0630))!;
    expect(e.method).toBe("chatcompletion-v3(Text API)");
    expect(e.input_tokens).toBe(50);
  });
});

describe("refreshMinimaxTokenUsage — pagination / window / idempotency", () => {
  it("paginates until a short page and upserts events", async () => {
    const db = freshDb();
    // 150 records across 2 pages (100 + 50), all within window.
    const records = Array.from({ length: 150 }, (_, i) =>
      rec(CHAT, 10, 1, T_0630 - i * 60)
    );
    const r = await refreshMinimaxTokenUsage(db, {
      apiKey: "sk-x",
      now: NOW,
      fetchJson: pagedFetch(records),
    });
    expect(r.status).toBe("success");
    // Distinct PK is (event_at, method, model, api_token_name); many share the
    // same minute→ still distinct by event_at second. All 150 land.
    const cnt = db
      .prepare("SELECT COUNT(*) AS n FROM minimax_token_usage_event")
      .get() as { n: number };
    expect(cnt.n).toBe(150);
  });

  it("is idempotent: re-pulling the same window inserts no duplicates", async () => {
    const db = freshDb();
    const records = [rec(CHAT, 100, 10, T_0630), rec(CACHE_READ, 5000, 0, T_0630)];
    const args = { apiKey: "sk-x", now: NOW, fetchJson: pagedFetch(records) };
    await refreshMinimaxTokenUsage(db, args);
    await refreshMinimaxTokenUsage(db, args);
    const cnt = db
      .prepare("SELECT COUNT(*) AS n FROM minimax_token_usage_event")
      .get() as { n: number };
    expect(cnt.n).toBe(2);
  });

  it("backfills a late-arriving hour on a later sync (T+1)", async () => {
    const db = freshDb();
    await refreshMinimaxTokenUsage(db, {
      apiKey: "sk-x",
      now: NOW,
      fetchJson: pagedFetch([rec(CHAT, 100, 10, T_0630)]),
    });
    // A day later the billing API now also returns the previously-missing hour.
    await refreshMinimaxTokenUsage(db, {
      apiKey: "sk-x",
      now: NOW,
      fetchJson: pagedFetch([
        rec(CHAT, 100, 10, T_0630),
        rec(CHAT, 200, 20, T_0630 + 3600),
      ]),
    });
    const cnt = db
      .prepare("SELECT COUNT(*) AS n FROM minimax_token_usage_event")
      .get() as { n: number };
    expect(cnt.n).toBe(2);
  });

  it("drops records older than the rolling window", async () => {
    const db = freshDb();
    const old = T_0630 - 30 * 24 * 3600; // 30 days before → outside 14d window
    await refreshMinimaxTokenUsage(db, {
      apiKey: "sk-x",
      now: NOW,
      windowDays: 14,
      fetchJson: pagedFetch([rec(CHAT, 100, 10, T_0630), rec(CHAT, 9, 9, old)]),
    });
    const rows = db
      .prepare("SELECT event_at FROM minimax_token_usage_event")
      .all() as { event_at: string }[];
    expect(rows).toHaveLength(1);
  });

  it("HTML/error response → failed, existing rows kept, message key-free", async () => {
    const db = freshDb();
    await refreshMinimaxTokenUsage(db, {
      apiKey: "sk-secret",
      now: NOW,
      fetchJson: pagedFetch([rec(CHAT, 100, 10, T_0630)]),
    });
    const badFetch: MinimaxAmountFetch = async () => "<html>login</html>";
    const r = await refreshMinimaxTokenUsage(db, {
      apiKey: "sk-secret",
      now: NOW,
      fetchJson: badFetch,
    });
    expect(r.status).toBe("failed");
    expect(r.error ?? "").not.toContain("sk-secret");
    // prior data untouched
    const cnt = db
      .prepare("SELECT COUNT(*) AS n FROM minimax_token_usage_event")
      .get() as { n: number };
    expect(cnt.n).toBe(1);
  });

  it("surfaces base_resp API errors as failed", async () => {
    const db = freshDb();
    const errFetch: MinimaxAmountFetch = async () => ({
      base_resp: { status_code: 1004, status_msg: "invalid key" },
    });
    const r = await refreshMinimaxTokenUsage(db, {
      apiKey: "sk-x",
      now: NOW,
      fetchJson: errFetch,
    });
    expect(r.status).toBe("failed");
    expect(r.error).toContain("1004");
  });
});

describe("queryMinimaxBuckets (via queryBucketsBySource) — caliber", () => {
  async function seed(db: Database.Database) {
    await refreshMinimaxTokenUsage(db, {
      apiKey: "sk-x",
      now: NOW,
      fetchJson: pagedFetch([
        rec(CHAT, 271167, 10698, T_0629), // fresh input + output
        rec(CACHE_READ, 4969344, 0, T_0629), // cache read (input-only)
        rec(CACHE_CREATE, 19374, 0, T_0629), // cache create (input-only)
      ]),
    });
  }

  it("input is FUSED; cache split by method; total=input+output", async () => {
    const db = freshDb();
    await seed(db);
    const rows = queryBucketsBySource(
      db,
      "minimax",
      new Date("2026-06-28T00:00:00+08:00"),
      new Date("2026-06-30T00:00:00+08:00"),
      "day"
    );
    expect(rows).toHaveLength(1);
    const b = rows[0];
    // FUSED input = 271167 + 4969344 + 19374
    expect(b.input_tokens).toBe(271167 + 4969344 + 19374);
    expect(b.output_tokens).toBe(10698);
    expect(b.total_tokens).toBe(b.input_tokens + b.output_tokens);
    expect(b.cache_read_input_tokens).toBe(4969344);
    expect(b.cache_creation_input_tokens).toBe(19374);
    // no sessions for a remote billing source
    expect(b.session_count).toBe(0);
  });

  it("exclude-cache = fresh + output (subtract BOTH cache kinds)", async () => {
    const db = freshDb();
    await seed(db);
    const [b] = queryBucketsBySource(
      db,
      "minimax",
      new Date("2026-06-28T00:00:00+08:00"),
      new Date("2026-06-30T00:00:00+08:00"),
      "day"
    );
    const excludeCache =
      b.total_tokens - b.cache_read_input_tokens - b.cache_creation_input_tokens;
    // = fresh input (271167) + output (10698); the two caches are gone
    expect(excludeCache).toBe(271167 + 10698);
  });

  it("empty range → no rows", () => {
    const db = freshDb();
    const rows = queryBucketsBySource(
      db,
      "minimax",
      new Date("2020-01-01T00:00:00+08:00"),
      new Date("2020-01-02T00:00:00+08:00"),
      "day"
    );
    expect(rows).toHaveLength(0);
  });
});

describe("trend integration (regression: minimax as 4th source)", () => {
  it("generateTrend includes minimax in totals without breaking claude/codex", async () => {
    const db = freshDb();
    await refreshMinimaxTokenUsage(db, {
      apiKey: "sk-x",
      now: NOW,
      fetchJson: pagedFetch([rec(CHAT, 1000, 100, T_0629)]),
    });
    const r = generateTrend(db, {
      month: "2026-06",
      now: new Date(2026, 6, 2, 12, 0, 0, 0),
    });
    if (r.mode !== "month") throw new Error("type narrow");
    expect(r.totals.minimaxTokens).toBe(1100);
    expect(r.totals.totalTokens).toBe(1100); // claude/codex empty
    expect(r.totals.minimaxShare).toBeCloseTo(1);
    // claude/codex untouched
    expect(r.totals.claudeTokens).toBe(0);
    expect(r.totals.codexTokens).toBe(0);
  });
});
