import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { migrate, SCHEMA_VERSION } from "../src/store/migrations.js";

describe("V52 注意力层表结构", () => {
  let db: Database.Database;
  afterEach(() => db?.close());

  const fresh = () => {
    db = new Database(":memory:");
    migrate(db);
    return db;
  };

  const cols = (table: string) =>
    (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[])
      .map((c) => c.name)
      .sort();

  it("迁移到 52 且 SCHEMA_VERSION 与之一致", () => {
    fresh();
    const v = db.prepare("SELECT version FROM meta_schema WHERE id = 1").get() as {
      version: number;
    };
    expect(v.version).toBe(52);
    // migrate() 末尾会在 vAfter > CURRENT_VERSION 时抛错，两者必须同步推进。
    expect(SCHEMA_VERSION).toBe(52);
  });

  it("spans 表的列来自实测语义，不含源里没有的 app_name", () => {
    fresh();
    expect(cols("attention_focus_spans")).toEqual([
      "bundle_id",
      "duration_ms",
      "end_ms",
      "id",
      "inserted_at",
      "local_day",
      "part_index",
      "source",
      "source_instance_id",
      "source_row_id",
      "start_ms",
      "tz_offset_s",
    ]);
  });

  it("sync_state 记录当时用的流名（流名跨 macOS 版本会变）", () => {
    fresh();
    expect(cols("attention_sync_state")).toContain("focus_stream");
    expect(cols("attention_sync_state")).toContain("watermark_row_id");
    expect(cols("attention_sync_state")).toContain("anchor_row_id");
  });

  const insertSpan = (over: Record<string, unknown> = {}) =>
    db
      .prepare(
        `INSERT INTO attention_focus_spans
           (source, source_instance_id, source_row_id, part_index,
            bundle_id, start_ms, end_ms, duration_ms, local_day, inserted_at)
         VALUES (@source, @inst, @rowId, @part, @bundle, @start, @end, @dur, @day, @at)`
      )
      .run({
        source: "knowledgec",
        inst: "inst-1",
        rowId: 803035,
        part: 0,
        bundle: "com.example.app-1",
        start: 1_700_000_000_000,
        end: 1_700_000_060_000,
        dur: 60_000,
        day: "2026-08-10",
        at: "2026-08-10T00:00:00Z",
        ...over,
      });

  it("同一源行重复插入是幂等的", () => {
    fresh();
    insertSpan();
    expect(() => insertSpan()).toThrow(/UNIQUE/);
    const n = db
      .prepare("SELECT COUNT(*) AS n FROM attention_focus_spans")
      .get() as { n: number };
    expect(n.n).toBe(1);
  });

  it("跨午夜切分出的第二片不会被唯一约束吞掉", () => {
    // D3(源行做幂等键)和 D9(午夜切成两行)天然打架：两片共享同一个
    // source_row_id。没有 part_index 的话第二片会被静默丢弃，一天的时长凭空少一截。
    fresh();
    insertSpan({ part: 0, day: "2026-08-09" });
    insertSpan({ part: 1, day: "2026-08-10" });
    const rows = db
      .prepare(
        "SELECT part_index, local_day FROM attention_focus_spans ORDER BY part_index"
      )
      .all() as { part_index: number; local_day: string }[];
    expect(rows).toEqual([
      { part_index: 0, local_day: "2026-08-09" },
      { part_index: 1, local_day: "2026-08-10" },
    ]);
  });

  it("源库重置后同一个源行号不会撞车", () => {
    fresh();
    insertSpan({ inst: "inst-1" });
    insertSpan({ inst: "inst-2" });
    const n = db
      .prepare("SELECT COUNT(*) AS n FROM attention_focus_spans")
      .get() as { n: number };
    expect(n.n).toBe(2);
  });

  it("按天和按时间区间的查询都有索引可用", () => {
    fresh();
    const plan = (sql: string) =>
      (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as { detail: string }[])
        .map((r) => r.detail)
        .join(" ");
    expect(plan("SELECT * FROM attention_focus_spans WHERE local_day = '2026-08-10'")).toMatch(
      /idx_attention_spans_day/
    );
    expect(
      plan("SELECT * FROM attention_focus_spans WHERE start_ms BETWEEN 1 AND 2")
    ).toMatch(/idx_attention_spans_range/);
  });
});
