import type { Hono } from "hono";
import type Database from "better-sqlite3";
import { collectLeads } from "./leads.js";
import { generateTrend } from "../workTokensTrend/service.js";
import type { WorkTokensTrendResponse } from "../workTokensTrend/types.js";

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
      const now = new Date();
      // trend 是整条链路上最贵的一次调用(真库约 35ms),而今日概览和 tokens.today 都要它。
      // 记忆化在这里而不是在 leads.ts 里:那样每次调 collectLeads 都得自己想着传缓存。
      let cached: WorkTokensTrendResponse | null = null;
      const trend = () => (cached ??= generateTrend(db, { window: "1w", now }));
      return c.json({ ok: true, ...collectLeads(db, { now, trend }) });
    } catch (e) {
      // 走到这里说明炸的是编排本身,不是某个探针 —— 那是真 500。
      return Response.json(
        { error: { message: e instanceof Error ? e.message : String(e) } },
        { status: 500 }
      );
    }
  });
}
