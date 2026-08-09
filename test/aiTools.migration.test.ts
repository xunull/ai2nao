import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { migrate, SCHEMA_VERSION } from "../src/store/migrations.js";

// 回归:开发中真实库被热重载升到"半吊子 v49"(ai_tools 表已建,但
// local_inventory_sync_runs 的 CHECK 还没含 'ai_tools'),ai_tools.scan 写 sync run 报
// 「CHECK constraint failed」。applyV50 必须能把这种库救回来。
describe("V50 修 local_inventory_sync_runs 的 ai_tools CHECK(回归)", () => {
  let db: Database.Database;
  afterEach(() => db?.close());

  const insertAiToolsRun = () =>
    db
      .prepare(
        "INSERT INTO local_inventory_sync_runs (source, started_at, status) VALUES ('ai_tools', '2026-07-21T00:00:00Z', 'running')"
      )
      .run();

  it("卡在旧 CHECK 的 v49 库 → migrate() 升到 50 并放行 source='ai_tools'", () => {
    db = new Database(":memory:");
    migrate(db);

    // 人为退回真实库当时的坏状态:CHECK 缺 ai_tools,版本回 49。
    db.exec(`
      DROP TABLE local_inventory_sync_runs;
      CREATE TABLE local_inventory_sync_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source TEXT NOT NULL CHECK (source IN ('mac_apps', 'brew', 'huggingface', 'lmstudio')),
        started_at TEXT NOT NULL,
        finished_at TEXT,
        status TEXT NOT NULL CHECK (status IN ('running', 'success', 'partial', 'failed')),
        inserted INTEGER NOT NULL DEFAULT 0,
        updated INTEGER NOT NULL DEFAULT 0,
        marked_missing INTEGER NOT NULL DEFAULT 0,
        warnings_count INTEGER NOT NULL DEFAULT 0,
        error_summary TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}'
      );
      UPDATE meta_schema SET version = 49 WHERE id = 1;
    `);

    // 修之前:写 ai_tools 被 CHECK 拒。
    expect(() => insertAiToolsRun()).toThrow(/CHECK constraint failed/);

    migrate(db);

    expect(
      (db.prepare("SELECT version FROM meta_schema WHERE id = 1").get() as { version: number }).version
    ).toBe(SCHEMA_VERSION);
    // 修之后:放行。
    expect(() => insertAiToolsRun()).not.toThrow();
  });

  it("全新库直达 head,CHECK 已含 ai_tools", () => {
    db = new Database(":memory:");
    migrate(db);
    expect(
      (db.prepare("SELECT version FROM meta_schema WHERE id = 1").get() as { version: number }).version
    ).toBe(SCHEMA_VERSION);
    expect(() => insertAiToolsRun()).not.toThrow();
  });
});
