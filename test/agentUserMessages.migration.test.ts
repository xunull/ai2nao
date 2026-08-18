import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { migrate, SCHEMA_VERSION } from "../src/store/migrations.js";

/**
 * V53:agent_user_messages 加 role 列(AI 正文入库的地基)。
 *
 * 这里同时测**两条路径**,因为它们的失败方式完全不同:
 *
 *   新库   migrate() 一次性建到 53 —— 只能证明 schema 语法对
 *   旧库   v52 有数据 → 升到 53   —— 才能证明 5.6 万条现存行不会被弄坏
 *
 * eng review D8 的裁定:造带旧数据的 fixture,不用 996 MB 真库。真库既慢又造不出
 * 边界(cleaned_text 为空、is_human=0 的留底噪音行、孤儿行)。
 *
 * v52 状态用 DROP COLUMN 造而不是手抄建表语句 —— 手抄的副本会随 applyV42 漂移,
 * 而这个测试的意义正是「旧形状升级不出事」。注意必须先 DROP INDEX:实测
 * SQLite 3.53.4 在列被索引引用时拒绝 DROP COLUMN。
 */
describe("V53 —— agent_user_messages.role", () => {
  let db: Database.Database;
  afterEach(() => db?.close());

  /** 一行 v52 形状的数据(不含 role)。 */
  const insertLegacy = (
    key: string,
    opts: { isHuman: number; cleaned: string; at: string }
  ) =>
    db
      .prepare(
        `INSERT INTO agent_user_messages
           (source, source_session_id, source_message_key, project, event_at_utc,
            raw_text, raw_payload_json, cleaned_text, is_human, char_len,
            cleaner_version, parser_version, source_path, source_seen_at,
            ingested_at, updated_at)
         VALUES ('claude','sess-1',@key,'proj',@at,'raw','"raw"',@cleaned,
                 @isHuman,@len,4,1,NULL,'n','n','n')`
      )
      .run({
        key,
        at: opts.at,
        cleaned: opts.cleaned,
        isHuman: opts.isHuman,
        len: [...opts.cleaned].length,
      });

  /** 把一个已迁到最新的库退回 v52 形状。 */
  const rewindToV52 = () => {
    db.exec("DROP INDEX IF EXISTS idx_aum_role_event");
    db.exec("ALTER TABLE agent_user_messages DROP COLUMN role");
    db.exec("ALTER TABLE agent_user_messages DROP COLUMN answering_user_key");
    db.exec("UPDATE meta_schema SET version = 52 WHERE id = 1");
  };

  describe("新库路径", () => {
    it("migrate 到 53,role 列与索引都在", () => {
      db = new Database(":memory:");
      migrate(db);

      const v = (
        db.prepare("SELECT version FROM meta_schema WHERE id = 1").get() as {
          version: number;
        }
      ).version;
      expect(v).toBe(54);
      expect(SCHEMA_VERSION).toBe(54);

      const role = (
        db.prepare("PRAGMA table_info(agent_user_messages)").all() as {
          name: string;
          notnull: number;
          dflt_value: string | null;
        }[]
      ).find((c) => c.name === "role");
      expect(role).toBeDefined();
      expect(role!.notnull).toBe(1);
      expect(role!.dflt_value).toBe("'user'");

      const idx = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_aum_role_event'"
        )
        .get();
      expect(idx).toBeDefined();
    });

    it("answering_user_key 可空(user 行没有 anchor)", () => {
      db = new Database(":memory:");
      migrate(db);
      const col = (
        db.prepare("PRAGMA table_info(agent_user_messages)").all() as {
          name: string;
          notnull: number;
        }[]
      ).find((c) => c.name === "answering_user_key");
      expect(col).toBeDefined();
      expect(col!.notnull).toBe(0);
    });

    it("CHECK 约束拦住 user/assistant 之外的值", () => {
      db = new Database(":memory:");
      migrate(db);
      expect(() =>
        db
          .prepare(
            `INSERT INTO agent_user_messages
               (source, source_session_id, source_message_key, project, event_at_utc,
                raw_text, raw_payload_json, cleaned_text, is_human, char_len,
                cleaner_version, parser_version, source_path, source_seen_at,
                ingested_at, updated_at, role)
             VALUES ('claude','s','k',NULL,'2026-01-01T00:00:00Z','r','"r"','c',
                     0,1,4,1,NULL,'n','n','n','tool')`
          )
          .run()
      ).toThrow(/CHECK constraint failed/);
    });
  });

  describe("旧库升级路径(带数据)", () => {
    const seed = () => {
      db = new Database(":memory:");
      migrate(db);
      rewindToV52();
      // 三种真实存在的行形态,升级后都必须完好。
      insertLegacy("k-human", {
        isHuman: 1,
        cleaned: "帮我看下这个 bug",
        at: "2026-08-01T00:00:00Z",
      });
      insertLegacy("k-noise", {
        isHuman: 0,
        cleaned: "",
        at: "2026-08-02T00:00:00Z",
      });
      insertLegacy("k-orphan", {
        isHuman: 1,
        cleaned: "孤儿会话的提问",
        at: "2026-04-01T00:00:00Z",
      });
      return db;
    };

    it("现存行全部拿到 role='user'(它们本来就都是 user 消息)", () => {
      seed();
      migrate(db);

      const rows = db
        .prepare(
          "SELECT source_message_key AS k, role, is_human AS h FROM agent_user_messages ORDER BY k"
        )
        .all() as { k: string; role: string; h: number }[];
      expect(rows).toHaveLength(3);
      expect(rows.every((r) => r.role === "user")).toBe(true);
      // is_human 不受影响:留底噪音行仍是 0,真人行仍是 1。
      expect(rows.find((r) => r.k === "k-noise")!.h).toBe(0);
      expect(rows.find((r) => r.k === "k-human")!.h).toBe(1);
    });

    it("升级不动 cleaned_text —— IRON RULE 的快照口径", () => {
      seed();
      const before = db
        .prepare(
          "SELECT source, is_human, COUNT(*) AS n, SUM(char_len) AS chars FROM agent_user_messages GROUP BY 1,2 ORDER BY 1,2"
        )
        .all();
      migrate(db);
      const after = db
        .prepare(
          "SELECT source, is_human, COUNT(*) AS n, SUM(char_len) AS chars FROM agent_user_messages GROUP BY 1,2 ORDER BY 1,2"
        )
        .all();
      expect(after).toEqual(before);
    });

    it("升级后可以插 assistant 行,且不污染 is_human=1 的集合", () => {
      seed();
      migrate(db);
      const humanBefore = (
        db
          .prepare(
            "SELECT COUNT(*) AS n FROM agent_user_messages WHERE is_human = 1"
          )
          .get() as { n: number }
      ).n;

      db.prepare(
        `INSERT INTO agent_user_messages
           (source, source_session_id, source_message_key, project, event_at_utc,
            raw_text, raw_payload_json, cleaned_text, is_human, char_len,
            cleaner_version, parser_version, source_path, source_seen_at,
            ingested_at, updated_at, role)
         VALUES ('claude','sess-1','k-ai','proj','2026-08-03T00:00:00Z',
                 'AI 的回答','"AI 的回答"','AI 的回答',0,5,4,1,NULL,'n','n','n','assistant')`
      ).run();

      const humanAfter = (
        db
          .prepare(
            "SELECT COUNT(*) AS n FROM agent_user_messages WHERE is_human = 1"
          )
          .get() as { n: number }
      ).n;
      expect(humanAfter).toBe(humanBefore);

      const ai = db
        .prepare("SELECT role, is_human AS h FROM agent_user_messages WHERE source_message_key='k-ai'")
        .get() as { role: string; h: number };
      expect(ai.role).toBe("assistant");
      expect(ai.h).toBe(0);
    });
  });

  describe("幂等", () => {
    // 三个既有 migration 测试(aiTools / attention / schedulerRuns)的夹具都是
    // 「migrate 到 head → 把 meta_schema 版本号降回去 → 再 migrate」,不删列。
    // applyV53 不做 pragma 检查的话它们会集体 duplicate column name。
    it("版本号被降回去后重跑 migrate 不炸", () => {
      db = new Database(":memory:");
      migrate(db);
      db.exec("UPDATE meta_schema SET version = 52 WHERE id = 1");
      expect(() => migrate(db)).not.toThrow();
      const v = (
        db.prepare("SELECT version FROM meta_schema WHERE id = 1").get() as {
          version: number;
        }
      ).version;
      expect(v).toBe(54);
    });

    it("连续跑两次 migrate 不炸", () => {
      db = new Database(":memory:");
      migrate(db);
      expect(() => migrate(db)).not.toThrow();
    });
  });

  describe("索引形状(D9)", () => {
    it("role 查询走索引,不做临时排序", () => {
      db = new Database(":memory:");
      migrate(db);
      const plan = (
        db
          .prepare(
            `EXPLAIN QUERY PLAN
             SELECT id FROM agent_user_messages
             WHERE role = 'assistant' ORDER BY event_at_utc DESC LIMIT 50`
          )
          .all() as { detail: string }[]
      ).map((r) => r.detail);

      expect(plan.join(" ")).toContain("idx_aum_role_event");
      // 关键:没有临时排序。有的话说明索引形状撑不起 ORDER BY,
      // 2 字中文搜索会退化成全表扫 + 排序(新内容每行 491 字节,旧表只有 25)。
      expect(plan.join(" ")).not.toContain("TEMP B-TREE");
      expect(plan.join(" ")).not.toMatch(/\bSCAN\b/);
    });

    it("既有的 is_human 查询计划不变(旧路径零回归)", () => {
      db = new Database(":memory:");
      migrate(db);
      const plan = (
        db
          .prepare(
            `EXPLAIN QUERY PLAN
             SELECT id FROM agent_user_messages
             WHERE is_human = 1 ORDER BY event_at_utc DESC LIMIT 50`
          )
          .all() as { detail: string }[]
      ).map((r) => r.detail);
      expect(plan.join(" ")).toContain("idx_aum_human_event");
    });
  });
});
