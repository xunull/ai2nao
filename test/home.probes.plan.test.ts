import Database from "better-sqlite3";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase } from "../src/store/open.js";
import { DATA_STALE_SQL } from "../src/home/leads.js";

/**
 * 查询计划的回归测试。
 *
 * 由来:data.stale 最初写成 `WHERE status='success' GROUP BY task_key`,在真库(123318 行 run
 * 记录、其中 118631 条 success)上要 101ms;改成相关子查询后**更糟**,863ms。原因不是 SQL 写法,
 * 是**优化器选错了索引** —— 这张表有 (task_key, started_at DESC) 和 (status, started_at DESC)
 * 两条,库里没有 ANALYZE 统计,它挑了 status 那条,于是 27 个任务每个都要走完 11.8 万条
 * success 行去过滤 task_key。
 *
 * 加 likelihood(status='success', 0.96) 把「这个条件几乎没有选择性」告诉优化器之后,
 * 它改走 task_key 那条:1.1ms。863 → 1.1。
 *
 * 所以这里断言的是**计划**而不是耗时:耗时在 CI 上不稳定,而「用了哪条索引」是确定的。
 * 谁要是哪天觉得那个 likelihood() 是噪音顺手删掉,这条测试会立刻红。
 */
describe("探针查询计划", () => {
  let db: Database.Database;
  afterEach(() => db?.close());

  function plan(sql: string): string {
    const rows = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as { detail: string }[];
    return rows.map((r) => r.detail).join(" | ");
  }

  function freshDb(): Database.Database {
    return openDatabase(join(mkdtempSync(join(tmpdir(), "home-plan-")), "t.db"));
  }

  it("data.stale 走 task_key 索引,不走 status 索引", () => {
    db = freshDb();
    const p = plan(DATA_STALE_SQL);
    expect(p).toContain("idx_scheduled_task_runs_task_started");
    // 这一条才是回归点 —— 走 status 索引就是那个 863ms 的计划。
    expect(p).not.toContain("idx_scheduled_task_runs_status");
  });

  it("去掉 likelihood 提示,优化器就会退回坏计划(证明这条提示是承重的)", () => {
    db = freshDb();
    const naive = DATA_STALE_SQL.replace(
      "likelihood(r.status = 'success', 0.96)",
      "r.status = 'success'"
    );
    expect(naive).not.toBe(DATA_STALE_SQL); // 替换真的发生了
    expect(plan(naive)).toContain("idx_scheduled_task_runs_status");
  });
});
