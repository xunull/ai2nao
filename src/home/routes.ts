import type { Hono } from "hono";
import type Database from "better-sqlite3";
import { collectLeads } from "./leads.js";

/**
 * 首页「今日线索」读侧路由。
 *   GET /api/home/leads   今天值得知道的事 + 深链
 *
 * 契约里有一条容易被后来的人「顺手修好」而破坏的:**探针抛异常不会让这个端点 500**。
 * 异常进 `errors[]`,其余线索照常返回,HTTP 仍是 200。理由是首页是每次开壳的第一屏 ——
 * 一个边缘探针(比如数据源那张表还没建)不该把整个落地页打成白屏。
 * 回归测试在 test/home.routes.test.ts。
 *
 * 没有缓存,是有意的:实测查询层是亚毫秒到几十毫秒,加缓存换来的是失效语义这一整类 bug。
 */
export function registerHomeRoutes(app: Hono, db: Database.Database): void {
  app.get("/api/home/leads", (c) => {
    try {
      return c.json({ ok: true, ...collectLeads(db, { now: new Date() }) });
    } catch (e) {
      // 走到这里说明炸的是编排本身,不是某个探针 —— 那是真 500。
      return Response.json(
        { error: { message: e instanceof Error ? e.message : String(e) } },
        { status: 500 }
      );
    }
  });
}
