import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openDatabase } from "../src/store/open.js";
import { generateTrend } from "../src/workTokensTrend/service.js";
import {
  TOKEN_SOURCES,
  tokensExcludingCache,
  totalTokens,
} from "../src/workTokensTrend/types.js";

/**
 * kimi 接进 adapter 注册表之后的契约。
 *
 * 重点两条:
 *   1. 门禁在 **agent** 粒度 —— 坏掉的 agent 不贡献 token,同会话其他 agent 照常(X2)
 *   2. 覆盖率单位是 **agent**,与 claude 的 session 混在一起时 totals 报 "mixed",
 *      前端据此改逐源展示,而不是给一个把两种单位加起来的百分比(X7)
 */

const PRIOR_TZ = process.env.TZ;
beforeAll(() => {
  process.env.TZ = "Asia/Shanghai";
});
afterAll(() => {
  process.env.TZ = PRIOR_TZ;
});

const NOW = new Date("2026-08-20T04:00:00.000Z");

function freshDb(): Database.Database {
  return openDatabase(join(mkdtempSync(join(tmpdir(), "ai2nao-kimi-adp-")), "t.db"));
}

function seedKimiAgent(
  db: Database.Database,
  o: {
    session: string;
    agent: string;
    status?: "full" | "unknown" | "error";
    at?: string;
    missing?: string | null;
  }
): void {
  const at = o.at ?? "2026-08-19T02:00:00.000Z";
  db.prepare(
    `INSERT INTO kimi_agent_token_usage
       (session_id, agent, file_path, file_mtime_ms, file_size_bytes, root_kind,
        cwd, project_key, project_path, identity_confidence, title, model,
        created_at, last_updated_at, token_status, parse_error, missing_since,
        source_seen_at, updated_at)
     VALUES (?, ?, ?, 0, 0, 'cli', '/p', '/p', '/p', 'high', null, 'kimi-code/k3',
             null, ?, ?, null, ?, ?, ?)`
  ).run(o.session, o.agent, `/p/${o.session}/${o.agent}`, at, o.status ?? "full", o.missing ?? null, at, at);
}

function seedKimiEvent(
  db: Database.Database,
  o: {
    session: string;
    agent: string;
    ordinal: number;
    at?: string;
    fresh: number;
    read?: number;
    creation?: number;
    output: number;
  }
): void {
  db.prepare(
    `INSERT INTO kimi_token_usage_event
       (session_id, agent, event_ordinal, event_at,
        fresh_input, cache_read_input, cache_creation_input, output)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    o.session,
    o.agent,
    o.ordinal,
    o.at ?? "2026-08-19T02:00:00.000Z",
    o.fresh,
    o.read ?? 0,
    o.creation ?? 0,
    o.output
  );
}

function seedClaudeSession(db: Database.Database, id: string, at: string, tokens: number): void {
  db.prepare(
    `INSERT INTO claude_session_token_usage
       (session_id, project_id, file_path, file_mtime_ms, file_size_bytes, cwd,
        project_key, project_path, identity_confidence, title, created_at,
        last_updated_at, input_tokens, output_tokens, total_tokens, token_status,
        parse_error, missing_since, source_seen_at, updated_at,
        cache_read_input_tokens, cache_creation_input_tokens, model, preview, message_count)
     VALUES (?, 'p', ?, 0, 0, '/p', '/p', '/p', 'high', null, null, ?, ?, 0, ?, 'full',
             null, null, ?, ?, 0, 0, 'm', null, 1)`
  ).run(id, `/p/${id}`, at, tokens, tokens, at, at);
  db.prepare(
    `INSERT INTO claude_token_usage_event
       (session_id, message_id, event_at, input_tokens, output_tokens,
        cache_read_input_tokens, cache_creation_input_tokens)
     VALUES (?, ?, ?, ?, 0, 0, 0)`
  ).run(id, `${id}-m`, at, tokens);
}

describe("kimi adapter", () => {
  it("原子分量直接出,不需要在 SQL 里做减法", () => {
    const db = freshDb();
    seedKimiAgent(db, { session: "s1", agent: "main" });
    seedKimiEvent(db, { session: "s1", agent: "main", ordinal: 0, fresh: 100, read: 900, creation: 5, output: 10 });
    const r = generateTrend(db, { window: "1w", now: NOW });
    const u = r.totals.sources.kimi;
    expect(u.freshInput).toBe(100);
    expect(u.cacheReadInput).toBe(900);
    expect(u.cacheCreationInput).toBe(5);
    expect(u.output).toBe(10);
    expect(totalTokens(u)).toBe(1015);
    // 「不含缓存」是加法:fresh + output
    expect(tokensExcludingCache(u)).toBe(110);
    db.close();
  });

  it("X2 —— 坏掉的 agent 不贡献 token,同会话其他 agent 照常计入", () => {
    const db = freshDb();
    seedKimiAgent(db, { session: "s1", agent: "main", status: "full" });
    seedKimiAgent(db, { session: "s1", agent: "agent-0", status: "full" });
    seedKimiAgent(db, { session: "s1", agent: "agent-1", status: "error" });
    seedKimiEvent(db, { session: "s1", agent: "main", ordinal: 0, fresh: 100, output: 10 });
    seedKimiEvent(db, { session: "s1", agent: "agent-0", ordinal: 0, fresh: 200, output: 20 });
    // 坏 agent 即使有残留事件也不该被计入(实际 refresh 不会写,这里是防御性断言)
    seedKimiEvent(db, { session: "s1", agent: "agent-1", ordinal: 0, fresh: 9999, output: 999 });

    const r = generateTrend(db, { window: "1w", now: NOW });
    const u = r.totals.sources.kimi;
    expect(totalTokens(u)).toBe(330); // 只有两个 full agent 的
    expect(u.coveredSessionCount).toBe(2);
    expect(u.errorSessionCount).toBe(1);
    expect(u.sessionCount).toBe(3); // 单位是 agent 文件数
    db.close();
  });

  it("missing_since 的 agent 不计入 token", () => {
    const db = freshDb();
    seedKimiAgent(db, { session: "s1", agent: "main" });
    seedKimiAgent(db, { session: "s1", agent: "agent-0", missing: "2026-08-20T00:00:00.000Z" });
    seedKimiEvent(db, { session: "s1", agent: "main", ordinal: 0, fresh: 100, output: 10 });
    seedKimiEvent(db, { session: "s1", agent: "agent-0", ordinal: 0, fresh: 500, output: 50 });
    const r = generateTrend(db, { window: "1w", now: NOW });
    expect(totalTokens(r.totals.sources.kimi)).toBe(110);
    db.close();
  });

  it("kimi 无定价 —— costState 恒 none,token 全部计入 unpriced", () => {
    const db = freshDb();
    seedKimiAgent(db, { session: "s1", agent: "main" });
    seedKimiEvent(db, { session: "s1", agent: "main", ordinal: 0, fresh: 100, read: 900, output: 10 });
    const r = generateTrend(db, { window: "1w", now: NOW });
    expect(r.totals.costState.kimi).toBe("none");
    expect(r.totals.sources.kimi.costUsd).toBe(0);
    expect(r.totals.sources.kimi.unpricedTokens).toBe(1010);
    // 而不是被当成 $0 悄悄进成本
    expect(r.totals.totalCostUsd).toBe(0);
    db.close();
  });

  describe("X7 —— 覆盖率单位", () => {
    it("只有 kimi 有数据时,单位是 agent", () => {
      const db = freshDb();
      seedKimiAgent(db, { session: "s1", agent: "main" });
      seedKimiEvent(db, { session: "s1", agent: "main", ordinal: 0, fresh: 1, output: 1 });
      const r = generateTrend(db, { window: "1w", now: NOW });
      expect(r.totals.coverageUnit).toBe("agent");
      db.close();
    });

    it("claude(session) 与 kimi(agent) 同时有数据 → mixed", () => {
      const db = freshDb();
      seedClaudeSession(db, "c1", "2026-08-19T02:00:00.000Z", 500);
      seedKimiAgent(db, { session: "s1", agent: "main" });
      seedKimiEvent(db, { session: "s1", agent: "main", ordinal: 0, fresh: 1, output: 1 });
      const r = generateTrend(db, { window: "1w", now: NOW });
      // 把 3 个 session 和 61 个 agent 加起来给一个百分比是没有统计意义的
      expect(r.totals.coverageUnit).toBe("mixed");
      db.close();
    });

    it("注册了但没有数据的源不会把单位打成 mixed", () => {
      const db = freshDb();
      seedClaudeSession(db, "c1", "2026-08-19T02:00:00.000Z", 500);
      // kimi 一行都没有 —— 它的 agent 单位不该登记
      const r = generateTrend(db, { window: "1w", now: NOW });
      expect(r.totals.coverageUnit).toBe("session");
      db.close();
    });
  });

  it("没有 kimi 数据时 state 是 absent —— 前端据此不画柱子", () => {
    const db = freshDb();
    seedClaudeSession(db, "c1", "2026-08-19T02:00:00.000Z", 500);
    const r = generateTrend(db, { window: "1w", now: NOW });
    expect(r.totals.sources.kimi.state).toBe("absent");
    db.close();
  });

  it("kimi 表被删 → state=failed + 诊断,不是 absent 也不是静默的 0", () => {
    const db = freshDb();
    seedKimiAgent(db, { session: "s1", agent: "main" });
    db.exec("DROP TABLE kimi_agent_token_usage");
    const r = generateTrend(db, { window: "1w", now: NOW });
    expect(r.totals.sources.kimi.state).toBe("failed");
    expect(r.diagnostics.some((d) => d.kind === "source_query_failed")).toBe(true);
    db.close();
  });

  it("monthRange 含 kimi 独有的月份", () => {
    const db = freshDb();
    // 只有 kimi 在 2026-07 有数据
    seedKimiAgent(db, { session: "s1", agent: "main", at: "2026-07-05T02:00:00.000Z" });
    seedKimiEvent(db, {
      session: "s1", agent: "main", ordinal: 0,
      at: "2026-07-05T02:00:00.000Z", fresh: 10, output: 1,
    });
    seedClaudeSession(db, "c1", "2026-08-19T02:00:00.000Z", 500);
    const r = generateTrend(db, { window: "1w", now: NOW });
    expect(r.monthRange.earliest).toBe("2026-07");
    db.close();
  });

  it("TOKEN_SOURCES 与 capabilities 一一对应 —— 加源不会漏配", () => {
    const db = freshDb();
    const r = generateTrend(db, { window: "1w", now: NOW });
    expect(Object.keys(r.capabilities).sort()).toEqual([...TOKEN_SOURCES].sort());
    expect(Object.keys(r.totals.sources).sort()).toEqual([...TOKEN_SOURCES].sort());
    expect(Object.keys(r.totals.costState).sort()).toEqual([...TOKEN_SOURCES].sort());
    if (r.mode === "window") {
      expect(Object.keys(r.previousWindow.bySource).sort()).toEqual([...TOKEN_SOURCES].sort());
    }
    db.close();
  });
});
