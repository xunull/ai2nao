import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { migrate, SCHEMA_VERSION } from "../src/store/migrations.js";

/**
 * V54:重建 agent_user_messages,去掉 source 的 CHECK。
 *
 * 这个迁移有**四种写错就完全静默**的方式,评审时逐条实测过,所以逐条断言:
 *
 *   不包事务      崩在 DROP 和 RENAME 之间 → 主表没了、版本号没推 → 下次启动
 *                 撞 "no such table" 且 applyVNN 不可改 = 永久启动失败
 *   漏建触发器    搜索照常工作(内连接把孤儿行丢了),FTS 无限膨胀,没有任何报错
 *   用 SELECT *   列序错位后 is_human=42、char_len='/p/a.jsonl',事务照常提交
 *   漏建索引      查询退化成全表扫,只是变慢,不报错
 *
 * 夹具是**手写的 v53 形状**而不是「migrate 到 head 再退回去」——
 * 退回去要重新加上 CHECK,而 SQLite 根本不支持这么做(这正是本次要重建表的原因)。
 */
describe("V54 —— 去掉 source 的 CHECK", () => {
  let db: Database.Database;
  afterEach(() => db?.close());

  /** 手写一个 v53 形状的库:带 CHECK 的主表 + 独立 fts5 + AFTER DELETE 触发器。 */
  const seedV53 = (): Database.Database => {
    const d = new Database(":memory:");
    d.exec(`
      CREATE TABLE meta_schema (id INTEGER PRIMARY KEY, version INTEGER NOT NULL);
      INSERT INTO meta_schema (id, version) VALUES (1, 53);

      CREATE TABLE agent_user_messages (
        id                 INTEGER PRIMARY KEY,
        source             TEXT NOT NULL CHECK (source IN ('claude','codex','opencode')),
        source_session_id  TEXT NOT NULL,
        source_message_key TEXT NOT NULL,
        project            TEXT,
        event_at_utc       TEXT NOT NULL,
        raw_text           TEXT NOT NULL,
        raw_payload_json   TEXT NOT NULL,
        cleaned_text       TEXT NOT NULL,
        is_human           INTEGER NOT NULL,
        char_len           INTEGER NOT NULL,
        cleaner_version    INTEGER NOT NULL,
        parser_version     INTEGER NOT NULL,
        source_path        TEXT,
        source_seen_at     TEXT NOT NULL,
        ingested_at        TEXT NOT NULL,
        updated_at         TEXT NOT NULL,
        role               TEXT NOT NULL DEFAULT 'user'
                             CHECK (role IN ('user', 'assistant')),
        answering_user_key TEXT,
        UNIQUE (source, source_session_id, source_message_key)
      );
      CREATE INDEX idx_aum_source_event ON agent_user_messages(source, event_at_utc);
      CREATE INDEX idx_aum_human_event ON agent_user_messages(is_human, event_at_utc, source);
      CREATE INDEX idx_aum_role_event ON agent_user_messages(role, event_at_utc);

      CREATE VIRTUAL TABLE agent_user_messages_fts USING fts5(
        cleaned_text, source UNINDEXED, event_at_utc UNINDEXED, tokenize = 'trigram');
      CREATE TRIGGER agent_user_messages_ad_fts
        AFTER DELETE ON agent_user_messages BEGIN
          DELETE FROM agent_user_messages_fts WHERE rowid = old.id;
        END;
    `);
    return d;
  };

  /** 三种真实存在的行形态,外加一个**不连续的 id**(真库里 id 有空洞)。 */
  const seedRows = (d: Database.Database) => {
    const ins = d.prepare(
      `INSERT INTO agent_user_messages
         (id, source, source_session_id, source_message_key, project, event_at_utc,
          raw_text, raw_payload_json, cleaned_text, is_human, char_len,
          cleaner_version, parser_version, source_path, source_seen_at,
          ingested_at, updated_at, role, answering_user_key)
       VALUES (@id,@source,'sess',@key,'proj','2026-08-01T00:00:00Z',
               @raw,'"raw"',@cleaned,@isHuman,@len,4,1,'/p/a.jsonl','n','n','n',@role,@anchor)`
    );
    ins.run({ id: 1, source: "claude", key: "k-human", raw: "帮我看下这个 bug",
      cleaned: "帮我看下这个 bug", isHuman: 1, len: 9, role: "user", anchor: null });
    ins.run({ id: 2, source: "claude", key: "k-noise", raw: "<system-reminder>x</system-reminder>",
      cleaned: "", isHuman: 0, len: 0, role: "user", anchor: null });
    // id 故意跳到 9:真库里 id 有空洞,SELECT * 保 rowid 这件事必须在有空洞时也成立
    ins.run({ id: 9, source: "codex", key: "k-ai", raw: "水位是已处理干净的时间点",
      cleaned: "水位是已处理干净的时间点", isHuman: 0, len: 12, role: "assistant", anchor: "k-human" });
    d.prepare(
      `INSERT INTO agent_user_messages_fts(rowid, cleaned_text, source, event_at_utc)
       SELECT id, cleaned_text, source, event_at_utc FROM agent_user_messages`
    ).run();
  };

  const cols = (d: Database.Database) =>
    (d.prepare("PRAGMA table_info(agent_user_messages)").all() as { name: string }[])
      .map((c) => c.name);

  describe("旧库带数据升级", () => {
    it("CHECK 去掉了,但 role 的 CHECK 留着", () => {
      db = seedV53();
      seedRows(db);
      migrate(db);
      const ddl = (
        db.prepare("SELECT sql FROM sqlite_master WHERE name='agent_user_messages'")
          .get() as { sql: string }
      ).sql;
      expect(ddl).not.toContain("CHECK (source IN");
      expect(ddl).toContain("CHECK (role IN");
      // 去掉之后 'kimi' 才写得进去 —— 这才是整个迁移的目的
      expect(() =>
        db.prepare(
          `INSERT INTO agent_user_messages
             (source, source_session_id, source_message_key, event_at_utc, raw_text,
              raw_payload_json, cleaned_text, is_human, char_len, cleaner_version,
              parser_version, source_seen_at, ingested_at, updated_at)
           VALUES ('kimi','s','k','2026-08-18T00:00:00Z','t','"t"','t',1,1,1,1,'n','n','n')`
        ).run()
      ).not.toThrow();
    });

    it("19 个字段逐列一致 —— 这条挂了说明用了 SELECT * 且列序错位", () => {
      db = seedV53();
      seedRows(db);
      const before = db
        .prepare("SELECT * FROM agent_user_messages ORDER BY id")
        .all() as Record<string, unknown>[];
      const colsBefore = cols(db);
      migrate(db);
      const after = db
        .prepare("SELECT * FROM agent_user_messages ORDER BY id")
        .all() as Record<string, unknown>[];

      expect(cols(db)).toEqual(colsBefore);
      expect(colsBefore).toHaveLength(19);
      expect(after).toEqual(before);
    });

    it("id 保住(含空洞),FTS rowid 集合与主表逐个相等", () => {
      db = seedV53();
      seedRows(db);
      migrate(db);
      const ids = (db.prepare("SELECT id FROM agent_user_messages ORDER BY id").all() as
        { id: number }[]).map((r) => r.id);
      const rowids = (db.prepare("SELECT rowid FROM agent_user_messages_fts ORDER BY rowid").all() as
        { rowid: number }[]).map((r) => r.rowid);
      expect(ids).toEqual([1, 2, 9]); // 空洞还在
      expect(rowids).toEqual(ids);
    });

    it("触发器重建了 —— 删主表行,FTS 行跟着没(tripwire)", () => {
      db = seedV53();
      seedRows(db);
      migrate(db);
      const ftsCount = () =>
        (db.prepare("SELECT COUNT(*) n FROM agent_user_messages_fts").get() as { n: number }).n;
      expect(ftsCount()).toBe(3);
      db.prepare("DELETE FROM agent_user_messages WHERE id = 9").run();
      // 漏建触发器的话这里是 3 —— 而搜索仍然正常(内连接丢弃孤儿行),没有任何别的信号
      expect(ftsCount()).toBe(2);
    });

    it("三个索引都重建了,查询不退化成全表扫", () => {
      db = seedV53();
      seedRows(db);
      migrate(db);
      const plan = (sql: string) =>
        (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as { detail: string }[])
          .map((r) => r.detail)
          .join(" ");
      expect(plan("SELECT id FROM agent_user_messages WHERE source='claude' ORDER BY event_at_utc"))
        .toContain("idx_aum_source_event");
      expect(plan("SELECT id FROM agent_user_messages WHERE is_human=1 ORDER BY event_at_utc"))
        .toContain("idx_aum_human_event");
      expect(plan("SELECT id FROM agent_user_messages WHERE role='assistant' ORDER BY event_at_utc DESC"))
        .toContain("idx_aum_role_event");
    });
  });

  describe("失败时整体回滚(applyVNN 不可改,这一条是最后一道闸)", () => {
    it("一致性自检不过 → 整个迁移回滚,库仍停在 v53 且数据完好", () => {
      db = seedV53();
      seedRows(db);
      // 造一条孤儿 FTS 行:主表没有 id=999。applyV54 的事务内自检会因此抛错。
      db.prepare(
        `INSERT INTO agent_user_messages_fts(rowid, cleaned_text, source, event_at_utc)
         VALUES (999, '孤儿', 'claude', '2026-08-01T00:00:00Z')`
      ).run();

      expect(() => migrate(db)).toThrow(/一致性自检失败/);

      // 关键:回滚干净。表还在、行数没少、版本号没推、CHECK 还在。
      // 不包事务的话这里会是「表已被 DROP、数据只在 _v54 里、版本仍 53」= 永久启动失败。
      const v = (db.prepare("SELECT version FROM meta_schema WHERE id=1").get() as
        { version: number }).version;
      expect(v).toBe(53);
      expect(
        (db.prepare("SELECT COUNT(*) n FROM agent_user_messages").get() as { n: number }).n
      ).toBe(3);
      const ddl = (db.prepare("SELECT sql FROM sqlite_master WHERE name='agent_user_messages'")
        .get() as { sql: string }).sql;
      expect(ddl).toContain("CHECK (source IN");
      // 半成品表不该留在库里
      expect(
        db.prepare("SELECT name FROM sqlite_master WHERE name='agent_user_messages_v54'").get()
      ).toBeUndefined();
    });
  });

  describe("幂等", () => {
    it("新库直接建到 head", () => {
      db = new Database(":memory:");
      migrate(db);
      const v = (db.prepare("SELECT version FROM meta_schema WHERE id=1").get() as
        { version: number }).version;
      expect(v).toBe(SCHEMA_VERSION);
      // head 不写死 —— 只要求 V54 已经在链条里(后续 migration 会继续往上加)。
      expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(54);
    });

    it("CHECK 已经没了时不再白搬一遍表", () => {
      db = seedV53();
      seedRows(db);
      migrate(db);
      db.exec("UPDATE meta_schema SET version = 53 WHERE id = 1");
      expect(() => migrate(db)).not.toThrow();
      const v = (db.prepare("SELECT version FROM meta_schema WHERE id=1").get() as
        { version: number }).version;
      expect(v).toBe(SCHEMA_VERSION);
      expect(
        (db.prepare("SELECT COUNT(*) n FROM agent_user_messages").get() as { n: number }).n
      ).toBe(3);
    });

    it("连续两次 migrate 不炸", () => {
      db = seedV53();
      seedRows(db);
      migrate(db);
      expect(() => migrate(db)).not.toThrow();
    });
  });
});
