import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { listKimiProjectTokenUsage } from "../src/kimiTokenUsage/queries.js";
import { openDatabase } from "../src/store/open.js";

/**
 * 按项目聚合 kimi 的 token —— 供 `/dashboard/tokens` 排行页。
 *
 * 计数单位是 **agent 文件**,不是 session(字段名沿用 `*Sessions` 只是为了
 * 跟看板既有的合并逻辑对上)。
 */

function freshDb(): Database.Database {
  return openDatabase(join(mkdtempSync(join(tmpdir(), "ai2nao-kimi-rank-")), "t.db"));
}

function seedAgent(
  db: Database.Database,
  o: {
    session: string;
    agent: string;
    project: string;
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
     VALUES (?, ?, ?, 0, 0, 'cli', ?, ?, ?, 'high', null, 'kimi-code/k3',
             null, ?, ?, null, ?, ?, ?)`
  ).run(
    o.session, o.agent, `/p/${o.session}/${o.agent}`,
    o.project, o.project, o.project,
    at, o.status ?? "full", o.missing ?? null, at, at
  );
}

function seedEvent(
  db: Database.Database,
  o: { session: string; agent: string; ordinal: number; fresh: number; read?: number; output: number }
): void {
  db.prepare(
    `INSERT INTO kimi_token_usage_event
       (session_id, agent, event_ordinal, event_at,
        fresh_input, cache_read_input, cache_creation_input, output)
     VALUES (?, ?, ?, '2026-08-19T02:00:00.000Z', ?, ?, 0, ?)`
  ).run(o.session, o.agent, o.ordinal, o.fresh, o.read ?? 0, o.output);
}

describe("listKimiProjectTokenUsage", () => {
  it("按 project_key 聚合,输入是三个分量之和", () => {
    const db = freshDb();
    seedAgent(db, { session: "s1", agent: "main", project: "/p/a" });
    seedEvent(db, { session: "s1", agent: "main", ordinal: 0, fresh: 100, read: 900, output: 10 });
    const m = listKimiProjectTokenUsage(db, {});
    const r = m.get("/p/a")!;
    expect(r.inputTokens).toBe(1000);
    expect(r.outputTokens).toBe(10);
    expect(r.totalTokens).toBe(1010);
    expect(r.coverage).toBe("full");
    db.close();
  });

  it("同一项目下多个 agent 的量合并,计数单位是 agent 文件", () => {
    const db = freshDb();
    seedAgent(db, { session: "s1", agent: "main", project: "/p/a" });
    seedAgent(db, { session: "s1", agent: "agent-0", project: "/p/a" });
    seedAgent(db, { session: "s2", agent: "main", project: "/p/a" });
    seedEvent(db, { session: "s1", agent: "main", ordinal: 0, fresh: 100, output: 10 });
    seedEvent(db, { session: "s1", agent: "agent-0", ordinal: 0, fresh: 200, output: 20 });
    seedEvent(db, { session: "s2", agent: "main", ordinal: 0, fresh: 300, output: 30 });
    const r = listKimiProjectTokenUsage(db, {}).get("/p/a")!;
    expect(r.totalTokens).toBe(660);
    // 3 个 agent 文件(不是 2 个 session)
    expect(r.totalSessions).toBe(3);
    expect(r.coveredSessions).toBe(3);
    db.close();
  });

  it("X2 —— 坏掉的 agent 不贡献 token,但计入分母,coverage 变 partial", () => {
    const db = freshDb();
    seedAgent(db, { session: "s1", agent: "main", project: "/p/a" });
    seedAgent(db, { session: "s1", agent: "agent-0", project: "/p/a", status: "error" });
    seedEvent(db, { session: "s1", agent: "main", ordinal: 0, fresh: 100, output: 10 });
    // 坏 agent 的残留事件不该被算进去
    seedEvent(db, { session: "s1", agent: "agent-0", ordinal: 0, fresh: 9999, output: 999 });
    const r = listKimiProjectTokenUsage(db, {}).get("/p/a")!;
    expect(r.totalTokens).toBe(110);
    expect(r.coveredSessions).toBe(1);
    expect(r.totalSessions).toBe(2);
    expect(r.errorSessions).toBe(1);
    expect(r.coverage).toBe("partial");
    db.close();
  });

  it("missing_since 的 agent 整行排除,连分母都不进", () => {
    const db = freshDb();
    seedAgent(db, { session: "s1", agent: "main", project: "/p/a" });
    seedAgent(db, {
      session: "s1", agent: "agent-0", project: "/p/a",
      missing: "2026-08-20T00:00:00.000Z",
    });
    seedEvent(db, { session: "s1", agent: "main", ordinal: 0, fresh: 100, output: 10 });
    seedEvent(db, { session: "s1", agent: "agent-0", ordinal: 0, fresh: 500, output: 50 });
    const r = listKimiProjectTokenUsage(db, {}).get("/p/a")!;
    expect(r.totalTokens).toBe(110);
    expect(r.totalSessions).toBe(1);
    db.close();
  });

  it("有 agent 行但零事件的项目也出现(LEFT JOIN),量为 0", () => {
    const db = freshDb();
    seedAgent(db, { session: "s1", agent: "main", project: "/p/empty", status: "unknown" });
    const r = listKimiProjectTokenUsage(db, {}).get("/p/empty")!;
    expect(r.totalTokens).toBe(0);
    expect(r.totalSessions).toBe(1);
    expect(r.coverage).toBe("unknown");
    db.close();
  });

  it("projectKeys 过滤与 from 时间过滤都生效", () => {
    const db = freshDb();
    seedAgent(db, { session: "s1", agent: "main", project: "/p/a" });
    seedAgent(db, { session: "s2", agent: "main", project: "/p/b" });
    seedAgent(db, { session: "s3", agent: "main", project: "/p/a", at: "2026-01-01T00:00:00.000Z" });
    seedEvent(db, { session: "s1", agent: "main", ordinal: 0, fresh: 100, output: 10 });
    seedEvent(db, { session: "s2", agent: "main", ordinal: 0, fresh: 200, output: 20 });
    seedEvent(db, { session: "s3", agent: "main", ordinal: 0, fresh: 999, output: 99 });

    const filtered = listKimiProjectTokenUsage(db, { projectKeys: ["/p/a"] });
    expect([...filtered.keys()]).toEqual(["/p/a"]);

    const recent = listKimiProjectTokenUsage(db, {
      projectKeys: ["/p/a"],
      from: new Date("2026-08-01T00:00:00.000Z"),
    }).get("/p/a")!;
    expect(recent.totalTokens).toBe(110); // 2026-01 那条被时间过滤掉
    db.close();
  });

  it("表不在(旧库)→ 空 Map,不抛 —— 不能拖垮别的源", () => {
    const db = freshDb();
    db.exec("DROP TABLE kimi_agent_token_usage");
    expect(() => listKimiProjectTokenUsage(db, {})).not.toThrow();
    expect(listKimiProjectTokenUsage(db, {}).size).toBe(0);
    db.close();
  });
});
