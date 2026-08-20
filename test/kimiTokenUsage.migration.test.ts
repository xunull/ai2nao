import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { migrate, SCHEMA_VERSION } from "../src/store/migrations.js";
import { openDatabase } from "../src/store/open.js";

/**
 * V55 —— kimi token 用量的两张表。
 *
 * 这组用例守着三件事:
 *   1. 表/索引/约束的形状(尤其是 **agent 粒度主键**,那是 X2 的落点)
 *   2. 幂等(新库直建 + 版本号降回去重跑,两条路径)
 *   3. 事件键能挡住重复,但**不靠时间戳**
 */

function freshDb(): Database.Database {
  const dir = mkdtempSync(join(tmpdir(), "ai2nao-kimi-mig-"));
  return openDatabase(join(dir, "test.db"));
}

const cols = (db: Database.Database, table: string): string[] =>
  (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((r) => r.name);

const indexes = (db: Database.Database, table: string): string[] =>
  (
    db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='index' AND tbl_name=? AND sql IS NOT NULL`
      )
      .all(table) as { name: string }[]
  ).map((r) => r.name);

function seedAgent(db: Database.Database, o: Partial<Record<string, unknown>> = {}): void {
  db.prepare(
    `INSERT INTO kimi_agent_token_usage
       (session_id, agent, file_path, file_mtime_ms, file_size_bytes, root_kind,
        cwd, project_key, project_path, identity_confidence, title, model,
        created_at, last_updated_at, token_status, parse_error, missing_since,
        source_seen_at, updated_at)
     VALUES (@session_id, @agent, @file_path, 0, 0, @root_kind,
             '/p', '/p', '/p', 'high', null, 'kimi-code/k3',
             null, @last_updated_at, @token_status, null, null,
             @last_updated_at, @last_updated_at)`
  ).run({
    session_id: "s1",
    agent: "main",
    file_path: "/p/s1/main/wire.jsonl",
    root_kind: "cli",
    last_updated_at: "2026-08-19T00:00:00.000Z",
    token_status: "full",
    ...o,
  });
}

describe("V55 —— kimi token 用量两张表", () => {
  describe("形状", () => {
    it("新库直建就有两张表 + state 表", () => {
      const db = freshDb();
      const names = (
        db
          .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'kimi_%'")
          .all() as { name: string }[]
      ).map((r) => r.name);
      expect(names.sort()).toEqual([
        "kimi_agent_token_usage",
        "kimi_token_usage_event",
        "kimi_token_usage_state",
      ]);
      db.close();
    });

    it("事件表只存原子分量 —— 没有任何可派生的列(X1)", () => {
      const db = freshDb();
      const c = cols(db, "kimi_token_usage_event");
      expect(c).toEqual([
        "session_id",
        "agent",
        "event_ordinal",
        "event_at",
        "fresh_input",
        "cache_read_input",
        "cache_creation_input",
        "output",
      ]);
      // 融合值 / 总量一律不存 —— 存了就会与分量互相矛盾
      expect(c).not.toContain("input_tokens");
      expect(c).not.toContain("total_tokens");
      db.close();
    });

    it("主表是 agent 粒度,主键 (session_id, agent) —— 这是 X2 的落点", () => {
      const db = freshDb();
      const pk = (
        db.prepare("PRAGMA table_info(kimi_agent_token_usage)").all() as {
          name: string;
          pk: number;
        }[]
      )
        .filter((r) => r.pk > 0)
        .sort((a, b) => a.pk - b.pk)
        .map((r) => r.name);
      expect(pk).toEqual(["session_id", "agent"]);
      db.close();
    });

    it("事件主键是 (session_id, agent, event_ordinal),**不含时间戳**", () => {
      const db = freshDb();
      const pk = (
        db.prepare("PRAGMA table_info(kimi_token_usage_event)").all() as {
          name: string;
          pk: number;
        }[]
      )
        .filter((r) => r.pk > 0)
        .sort((a, b) => a.pk - b.pk)
        .map((r) => r.name);
      expect(pk).toEqual(["session_id", "agent", "event_ordinal"]);
      // 「实测 time 全局唯一」是观察不是格式契约 —— 不能拿它当键
      expect(pk).not.toContain("event_at");
      db.close();
    });

    it("索引齐全:主表四个 + 事件表的复合时间索引(9A)", () => {
      const db = freshDb();
      expect(indexes(db, "kimi_agent_token_usage").sort()).toEqual([
        "idx_kimi_agent_file",
        "idx_kimi_agent_missing",
        "idx_kimi_agent_project_updated",
        "idx_kimi_agent_updated",
      ]);
      const eventIdxSql = (
        db
          .prepare("SELECT sql FROM sqlite_master WHERE name='idx_kimi_token_event_at'")
          .get() as { sql: string }
      ).sql;
      // 复合覆盖 join 键,与 claude 一致;codex/minimax 的裸 (event_at) 是待办
      expect(eventIdxSql).toContain("(event_at, session_id, agent)");
      db.close();
    });

    it("时间范围查询命中复合索引,不是全表扫", () => {
      const db = freshDb();
      const plan = (
        db
          .prepare(
            `EXPLAIN QUERY PLAN
               SELECT e.session_id FROM kimi_token_usage_event e
               WHERE e.event_at >= ? AND e.event_at < ?`
          )
          .all("a", "b") as { detail: string }[]
      )
        .map((r) => r.detail)
        .join(" ");
      expect(plan).toContain("idx_kimi_token_event_at");
      expect(plan).not.toMatch(/SCAN kimi_token_usage_event(?! USING)/);
      db.close();
    });
  });

  describe("约束", () => {
    it("root_kind 只认 cli / desktop", () => {
      const db = freshDb();
      expect(() => seedAgent(db, { root_kind: "cli" })).not.toThrow();
      expect(() => seedAgent(db, { agent: "agent-0", root_kind: "sandbox" })).toThrow(
        /CHECK constraint/
      );
      db.close();
    });

    it("token_status 只认 full / unknown / error", () => {
      const db = freshDb();
      expect(() => seedAgent(db, { token_status: "unknown" })).not.toThrow();
      expect(() =>
        seedAgent(db, { agent: "agent-0", token_status: "partial" })
      ).toThrow(/CHECK constraint/);
      db.close();
    });

    it("同一会话的不同 agent 可以并存,同一 agent 不能重复", () => {
      const db = freshDb();
      seedAgent(db, { agent: "main" });
      expect(() => seedAgent(db, { agent: "agent-0" })).not.toThrow();
      expect(() => seedAgent(db, { agent: "main" })).toThrow(/UNIQUE constraint/);
      db.close();
    });

    it("事件键挡住同一文件同一序号的重复写入", () => {
      const db = freshDb();
      const ins = () =>
        db
          .prepare(
            `INSERT INTO kimi_token_usage_event
               (session_id, agent, event_ordinal, event_at,
                fresh_input, cache_read_input, cache_creation_input, output)
             VALUES ('s1', 'main', 0, '2026-08-19T00:00:00.000Z', 10, 20, 0, 5)`
          )
          .run();
      ins();
      expect(ins).toThrow(/UNIQUE constraint/);
      // 但同一毫秒的**不同序号**是合法的 —— 时间戳不是键
      expect(() =>
        db
          .prepare(
            `INSERT INTO kimi_token_usage_event
               (session_id, agent, event_ordinal, event_at,
                fresh_input, cache_read_input, cache_creation_input, output)
             VALUES ('s1', 'main', 1, '2026-08-19T00:00:00.000Z', 1, 2, 0, 3)`
          )
          .run()
      ).not.toThrow();
      db.close();
    });
  });

  describe("幂等", () => {
    it("新库直建到 head", () => {
      const db = freshDb();
      const v = (
        db.prepare("SELECT version FROM meta_schema WHERE id = 1").get() as {
          version: number;
        }
      ).version;
      expect(v).toBe(SCHEMA_VERSION);
      expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(55);
      db.close();
    });

    it("版本号降回 54 后重跑 migrate:不炸,不丢数据,版本号推回 head", () => {
      const db = freshDb();
      seedAgent(db);
      db.prepare(
        `INSERT INTO kimi_token_usage_event
           (session_id, agent, event_ordinal, event_at,
            fresh_input, cache_read_input, cache_creation_input, output)
         VALUES ('s1', 'main', 0, '2026-08-19T00:00:00.000Z', 10, 20, 0, 5)`
      ).run();

      db.exec("UPDATE meta_schema SET version = 54 WHERE id = 1;");
      expect(() => migrate(db)).not.toThrow();

      const v = (
        db.prepare("SELECT version FROM meta_schema WHERE id = 1").get() as {
          version: number;
        }
      ).version;
      expect(v).toBe(SCHEMA_VERSION);
      // 数据还在 —— 幂等分支不该重建表
      expect(
        (db.prepare("SELECT COUNT(*) n FROM kimi_agent_token_usage").get() as { n: number }).n
      ).toBe(1);
      expect(
        (db.prepare("SELECT COUNT(*) n FROM kimi_token_usage_event").get() as { n: number }).n
      ).toBe(1);
      db.close();
    });

    it("连跑两次 migrate 不变更任何东西", () => {
      const db = freshDb();
      const before = db
        .prepare("SELECT sql FROM sqlite_master WHERE name LIKE 'kimi_%' ORDER BY name")
        .all();
      migrate(db);
      const after = db
        .prepare("SELECT sql FROM sqlite_master WHERE name LIKE 'kimi_%' ORDER BY name")
        .all();
      expect(after).toEqual(before);
      db.close();
    });
  });
});
