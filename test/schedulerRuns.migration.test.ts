import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { migrate, SCHEMA_VERSION } from "../src/store/migrations.js";

/**
 * v51:scheduled_task_runs 补一条以 started_at 打头的索引。
 *
 * 这张表本来就有 (task_key, started_at DESC) 和 (status, started_at DESC),看上去
 * started_at 已经索引过了 —— 但复合索引只能从最左列开始用,所以 listScheduledTaskRuns
 * 的**无过滤**分支 `ORDER BY started_at DESC, id DESC LIMIT ?` 一条都用不上,只能全表扫
 * 再排序。真实库(约 12 万行)上 limit=5 也要 123ms。
 *
 * 所以这里断言的不是「索引行存在」(那种测试改个列名就静默失效),而是**查询计划里不再有
 * 临时排序** —— 那才是这次要守住的性质。
 */
describe("V51 scheduled_task_runs 的 started_at 索引", () => {
  let db: Database.Database;
  afterEach(() => db?.close());

  /** 取无过滤列表查询的计划文本(小写,便于匹配)。 */
  function orderByPlan(d: Database.Database): string {
    const rows = d
      .prepare(
        `EXPLAIN QUERY PLAN
         SELECT id, task_key, trigger, started_at, finished_at, status,
                summary_json, error_summary, lease_owner
         FROM scheduled_task_runs
         ORDER BY started_at DESC, id DESC
         LIMIT 5`
      )
      .all() as { detail: string }[];
    return rows.map((r) => r.detail).join(" | ").toLowerCase();
  }

  it("全新库:无过滤的 ORDER BY 走索引,不做临时排序", () => {
    db = new Database(":memory:");
    migrate(db);

    const plan = orderByPlan(db);
    expect(plan).toContain("idx_scheduled_task_runs_started");
    // 这一条才是性能性质本身:有临时 B-tree 就等于全表排序。
    expect(plan).not.toContain("temp b-tree");
  });

  it("停在 v50 的库:migrate() 升到 head 并补上索引", () => {
    db = new Database(":memory:");
    migrate(db);

    // 退回 v51 之前的状态。
    db.exec(`
      DROP INDEX IF EXISTS idx_scheduled_task_runs_started;
      UPDATE meta_schema SET version = 50 WHERE id = 1;
    `);

    // 修之前:必然退化成临时排序。
    expect(orderByPlan(db)).toContain("temp b-tree");

    migrate(db);

    expect(
      (db.prepare("SELECT version FROM meta_schema WHERE id = 1").get() as { version: number })
        .version
    ).toBe(SCHEMA_VERSION);
    expect(orderByPlan(db)).not.toContain("temp b-tree");
  });

  it("带 task_key / status 过滤的分支不受影响,仍走各自的既有索引", () => {
    db = new Database(":memory:");
    migrate(db);

    const byTask = db
      .prepare(
        `EXPLAIN QUERY PLAN SELECT id FROM scheduled_task_runs
         WHERE task_key = ? ORDER BY started_at DESC, id DESC LIMIT 5`
      )
      .all("downloads.scan") as { detail: string }[];
    expect(byTask.map((r) => r.detail).join(" ")).toContain("idx_scheduled_task_runs_task_started");

    // scheduler.failing 探针要用的就是这条路径 —— 它不该被 v51 抢走。
    const byStatus = db
      .prepare(
        `EXPLAIN QUERY PLAN SELECT id FROM scheduled_task_runs
         WHERE status = ? ORDER BY started_at DESC LIMIT 5`
      )
      .all("failed") as { detail: string }[];
    expect(byStatus.map((r) => r.detail).join(" ")).toContain("idx_scheduled_task_runs_status");
  });
});
