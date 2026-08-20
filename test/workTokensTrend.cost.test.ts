import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { openDatabase } from "../src/store/open.js";
import { generateTrend } from "../src/workTokensTrend/service.js";
import { priceCostByBucket } from "../src/workTokensTrend/queries.js";
import { totalTokens } from "../src/workTokensTrend/types.js";

const PRIOR_TZ = process.env.TZ;
beforeAll(() => {
  process.env.TZ = "Asia/Shanghai";
});
afterAll(() => {
  process.env.TZ = PRIOR_TZ;
});

function freshDb(): Database.Database {
  const dir = mkdtempSync(join(tmpdir(), "ai2nao-cost-"));
  return openDatabase(join(dir, "test.db"));
}

function seedClaude(
  db: Database.Database,
  id: string,
  updated: string,
  model: string | null,
  io: { input: number; output: number; cacheRead: number; cacheCreation: number }
): void {
  db.prepare(
    `INSERT INTO claude_session_token_usage
       (session_id, project_id, file_path, file_mtime_ms, file_size_bytes,
        cwd, project_key, project_path, identity_confidence, title, created_at,
        last_updated_at, input_tokens, output_tokens, total_tokens,
        cache_read_input_tokens, cache_creation_input_tokens, model, token_status,
        parse_error, missing_since, source_seen_at, updated_at)
     VALUES (?, 'p', '/x', 0, 0, '/x', '/x', '/x', 'high', null, null, ?,
             ?, ?, ?, ?, ?, ?, 'full', null, null, ?, ?)`
  ).run(
    id,
    updated,
    io.input,
    io.output,
    io.input + io.output,
    io.cacheRead,
    io.cacheCreation,
    model,
    updated,
    updated
  );
  // Claude cost now reads token components from the per-message-day timeline
  // (joined to the session row for the model). Mirror this single-day session as
  // one event at `updated`.
  db.prepare(
    `INSERT INTO claude_token_usage_event
       (session_id, message_id, event_at, input_tokens, output_tokens,
        cache_read_input_tokens, cache_creation_input_tokens)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(id, `${id}-m`, updated, io.input, io.output, io.cacheRead, io.cacheCreation);
}

function seedCodexEvent(
  db: Database.Database,
  id: string,
  updated: string,
  model: string | null,
  ev: { input: number; output: number; cached: number }
): void {
  db.prepare(
    `INSERT INTO codex_session_token_usage
       (session_id, rollout_path, rollout_mtime_ms, rollout_size_bytes,
        cwd, project_key, project_path, identity_confidence, title, model,
        git_branch, created_at, last_updated_at, input_tokens, output_tokens,
        total_tokens, reasoning_output_tokens, cached_input_tokens, token_status,
        parse_error, missing_since, source_seen_at, updated_at)
     VALUES (?, '/r', 0, 0, '/w', '/w', '/w', 'high', null, ?, null, null, ?,
             ?, ?, ?, 0, ?, 'full', null, null, ?, ?)`
  ).run(
    id,
    model,
    updated,
    ev.input,
    ev.output,
    ev.input + ev.output,
    ev.cached,
    updated,
    updated
  );
  db.prepare(
    `INSERT INTO codex_token_usage_event
       (session_id, event_at, input_tokens, output_tokens, reasoning_output_tokens, cached_input_tokens)
     VALUES (?, ?, ?, ?, 0, ?)`
  ).run(id, updated, ev.input, ev.output, ev.cached);
}

describe("USD cost in tokens-trend", () => {
  it("prices Claude per model; excludes unknown-model tokens and counts them", () => {
    const db = freshDb();
    // Local 2026-06-10 (Asia/Shanghai) = 2026-06-09 16:00Z.
    // sonnet: fresh = 1000-100-200 = 700 input fresh.
    seedClaude(db, "c1", "2026-06-09T18:00:00Z", "claude-sonnet-4-6", {
      input: 1000,
      output: 500,
      cacheRead: 100,
      cacheCreation: 200,
    });
    // Codex on gpt-5.5 → NOT in price snapshot → unpriced.
    seedCodexEvent(db, "x1", "2026-06-09T18:30:00Z", "gpt-5.5", {
      input: 800,
      output: 200,
      cached: 600,
    });

    const r = generateTrend(db, {
      month: "2026-06",
      now: new Date(2026, 5, 11, 12, 0, 0, 0),
    });
    if (r.mode !== "month") throw new Error("type narrow");
    const t = r.totals;

    // Claude sonnet: fresh=700×3e-6 + creation=200×3.75e-6 + read=100×3e-7 + out=500×1.5e-5
    // = 0.0021 + 0.00075 + 0.00003 + 0.0075 = 0.01038
    expect(t.sources.claude.costUsd).toBeCloseTo(0.01038, 9);
    // gpt-5.5 unpriced → codex cost 0, its tokens (800+200=1000) counted unpriced.
    expect(t.sources.codex.costUsd).toBe(0);
    expect(t.unpricedTokenCount).toBe(1000);
    expect(t.totalCostUsd).toBeCloseTo(
      t.sources.claude.costUsd + t.sources.codex.costUsd,
      12
    );
    expect(t.priceSnapshotDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("Codex cost buckets by event day (priced model), via priceCostByBucket", () => {
    const db = freshDb();
    // Use a priced model on the codex session to exercise the JOIN pricing path.
    seedCodexEvent(db, "x2", "2026-06-15T02:00:00Z", "claude-haiku-4-5", {
      input: 1000,
      output: 100,
      cached: 0,
    });
    const { byBucket } = priceCostByBucket(
      db,
      new Date(2026, 5, 14, 0, 0, 0, 0),
      new Date(2026, 5, 16, 0, 0, 0, 0),
      "day"
    );
    // 归一后 unpriced 是逐源的,不再有全局单值。
    const day15 = byBucket.get("2026-06-15");
    expect(day15?.codex.unpriced).toBe(0);
    // haiku: fresh=1000×1e-6 + out=100×5e-6 = 0.001 + 0.0005 = 0.0015
    const day = byBucket.get("2026-06-15");
    expect(day?.codex.costUsd).toBeCloseTo(0.0015, 9);
  });

  it("cost is independent of token counts — pure pricing of components", () => {
    const db = freshDb();
    seedClaude(db, "c2", "2026-06-09T18:00:00Z", null, {
      input: 1e6,
      output: 1e6,
      cacheRead: 0,
      cacheCreation: 0,
    });
    const r = generateTrend(db, {
      month: "2026-06",
      now: new Date(2026, 5, 11, 12, 0, 0, 0),
    });
    if (r.mode !== "month") throw new Error("type narrow");
    // null model → unpriced; tokens still counted in token totals, not cost.
    expect(r.totals.sources.claude.costUsd).toBe(0);
    expect(r.totals.unpricedTokenCount).toBe(2_000_000);
    expect(totalTokens(r.totals.sources.claude)).toBe(2_000_000);
  });

  /**
   * X4 的契约:成本可信度是三态,不是布尔。
   * 布尔说不清 partial —— 而 claude 与 codex 在真实数据里现在就是 partial
   * (claude 有一批 model 为 null 的 session,codex 有 codex-auto-review)。
   */
  it("costState 三态:全定价 full / 有无价模型 partial / 无定价概念 none", () => {
    const db = freshDb();
    // claude:一条有价 + 一条 null model → partial
    seedClaude(db, "c-priced", "2026-06-09T18:00:00Z", "claude-haiku-4-5", {
      input: 1000, output: 100, cacheRead: 0, cacheCreation: 0,
    });
    seedClaude(db, "c-null", "2026-06-09T19:00:00Z", null, {
      input: 500, output: 50, cacheRead: 0, cacheCreation: 0,
    });
    // codex:只有有价模型 → full
    seedCodexEvent(db, "x-priced", "2026-06-09T20:00:00Z", "claude-haiku-4-5", {
      input: 400, output: 40, cached: 0,
    });
    const r = generateTrend(db, { month: "2026-06", now: new Date(2026, 5, 11, 12, 0, 0, 0) });
    if (r.mode !== "month") throw new Error("type narrow");
    expect(r.totals.costState.claude).toBe("partial");
    expect(r.totals.costState.codex).toBe("full");
    // minimax 没有 queryCostRows → 恒 none(没数据时也是 none)
    expect(r.totals.costState.minimax).toBe("none");
    // partial 的那一半:无价的 550 token 露在 unpricedTokens 里,不当成 $0
    expect(r.totals.sources.claude.unpricedTokens).toBe(550);
    expect(r.totals.sources.claude.pricedTokens).toBe(1100);
  });

  it("无定价概念的源:token 全部计入 unpriced,而不是当成 $0", () => {
    const db = freshDb();
    // 同一个桶里既有 claude 的成本行,也有 minimax 的 token ——
    // 这正是「判据搭错对象」会漏掉的形状:slot() 给所有源建了格子,
    // 用「这一桶查到格子没有」当判据的话 minimax 永远进不去 unpriced。
    seedClaude(db, "c1", "2026-06-09T18:00:00Z", "claude-haiku-4-5", {
      input: 1000, output: 100, cacheRead: 0, cacheCreation: 0,
    });
    db.prepare(
      `INSERT INTO minimax_token_usage_event
         (event_at, method, model, api_token_name, input_tokens, output_tokens, consume_cash, raw_json)
       VALUES (?, 'Text API', 'mm', 'k', 700, 30, null, null)`
    ).run("2026-06-09T18:30:00Z");
    const r = generateTrend(db, { month: "2026-06", now: new Date(2026, 5, 11, 12, 0, 0, 0) });
    if (r.mode !== "month") throw new Error("type narrow");
    expect(r.totals.sources.minimax.costUsd).toBe(0);
    expect(r.totals.sources.minimax.unpricedTokens).toBe(730);
    expect(r.totals.costState.minimax).toBe("none");
    // claude 那 1100 被正常定价,不受影响
    expect(r.totals.sources.claude.pricedTokens).toBe(1100);
    // 总的 unpriced 含 minimax 全量
    expect(r.totals.unpricedTokenCount).toBe(730);
  });
});