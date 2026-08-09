import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { bucketExpr, localDayRangeUtc, todayLocalDay } from "../src/timeWindow/bucket.js";

/**
 * 首页探针的时间原语。两条性质要守住:
 *
 * 1. `todayLocalDay()` 的输出必须和 SQL 侧 `bucketExpr("day")` 一致 —— 否则 JS 算出来的
 *    「今天」和 SQLite 算出来的「今天」会在某些时刻差一天,而且只在半夜或非 UTC 时区暴露。
 * 2. `localDayRangeUtc()` 给的必须是**半开** UTC 区间,让探针能写 `col >= ? AND col < ?`
 *    这种可走索引的范围查询,而不是 `date(col,'localtime') = ?` 那种全表函数扫。
 */
describe("timeWindow 的本地日原语", () => {
  let db: Database.Database;
  afterEach(() => db?.close());

  it("todayLocalDay 与 SQL 的 bucketExpr('day') 对同一时刻给出同一天", () => {
    db = new Database(":memory:");
    // 挑几个容易出事的时刻:刚过零点、临近午夜、月末、年末。
    const moments = [
      new Date(2026, 7, 8, 0, 1, 0),
      new Date(2026, 7, 8, 23, 59, 59),
      new Date(2026, 6, 31, 23, 30, 0),
      new Date(2026, 11, 31, 23, 59, 0),
      new Date(2026, 0, 1, 0, 0, 1),
    ];
    for (const m of moments) {
      const fromJs = todayLocalDay(m);
      const fromSql = (
        db.prepare(`SELECT ${bucketExpr("day", "?")} AS d`).get(m.toISOString()) as { d: string }
      ).d;
      expect(fromSql, `mismatch at ${m.toISOString()}`).toBe(fromJs);
    }
  });

  it("localDayRangeUtc(now,1) 恰好圈住今天,且把明天排除在外", () => {
    const noon = new Date(2026, 7, 8, 12, 0, 0);
    const { fromIso, toIso } = localDayRangeUtc(noon, 1);

    // 今天的任意时刻都落在区间内。
    for (const h of [0, 1, 12, 23]) {
      const t = new Date(2026, 7, 8, h, 30, 0).toISOString();
      expect(t >= fromIso && t < toIso, `${t} 应在区间内`).toBe(true);
    }
    // 昨天最后一刻、明天第一刻都在区间外。
    expect(new Date(2026, 7, 7, 23, 59, 59, 999).toISOString() < fromIso).toBe(true);
    expect(new Date(2026, 7, 9, 0, 0, 0, 0).toISOString() >= toIso).toBe(true);
  });

  it("半开区间:当天最后一毫秒仍在内(闭区间写法会漏掉它)", () => {
    const now = new Date(2026, 7, 8, 12, 0, 0);
    const { fromIso, toIso } = localDayRangeUtc(now, 1);
    const lastTick = new Date(2026, 7, 8, 23, 59, 59, 999).toISOString();
    expect(lastTick >= fromIso && lastTick < toIso).toBe(true);
  });

  it("days=7 覆盖含今天在内的 7 个本地日,不多不少", () => {
    const now = new Date(2026, 7, 8, 12, 0, 0);
    const { fromIso, toIso } = localDayRangeUtc(now, 7);
    // 6 天前的零点在内。
    expect(new Date(2026, 7, 2, 0, 0, 0).toISOString() >= fromIso).toBe(true);
    // 7 天前的最后一刻在外。
    expect(new Date(2026, 7, 1, 23, 59, 59, 999).toISOString() < fromIso).toBe(true);
    // 上界仍是明天零点。
    expect(new Date(2026, 7, 9, 0, 0, 0).toISOString()).toBe(toIso);
  });

  it("跨月 / 跨年回溯不出错", () => {
    const marchFirst = new Date(2026, 2, 1, 10, 0, 0);
    expect(localDayRangeUtc(marchFirst, 3).fromIso).toBe(
      new Date(2026, 1, 27, 0, 0, 0).toISOString()
    );
    const janSecond = new Date(2026, 0, 2, 10, 0, 0);
    expect(localDayRangeUtc(janSecond, 5).fromIso).toBe(
      new Date(2025, 11, 29, 0, 0, 0).toISOString()
    );
  });

  it("days 非法值兜底成 1,不产生反向区间", () => {
    const now = new Date(2026, 7, 8, 12, 0, 0);
    for (const bad of [0, -3, 0.4, Number.NaN]) {
      const { fromIso, toIso } = localDayRangeUtc(now, bad);
      expect(fromIso < toIso, `days=${bad} 产生了反向区间`).toBe(true);
      expect(fromIso).toBe(localDayRangeUtc(now, 1).fromIso);
    }
  });
});
