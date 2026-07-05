import type { Hono } from "hono";
import type Database from "better-sqlite3";
import {
  heatmapRhythm,
  streakRhythm,
  commandLeaderboard,
  weeklySourceMix,
  personalRecords,
} from "./queries.js";

function jsonErr(status: number, message: string) {
  return Response.json({ error: { message } }, { status });
}

/**
 * 「我的 AI 节律」自量化仪表盘 API。
 *   GET /api/ai-rhythm/heatmap  作息热力图(weekday×hour,仅 is_human,全源全时段)。
 *   GET /api/ai-rhythm/streak   连续天数纪录(Duolingo 式,grace 规则)。
 *   GET /api/ai-rhythm/commands 命令/技能用量排行(纯排行,路径守卫)。
 *   GET /api/ai-rhythm/source-trend 三源迁移周趋势(堆叠面积)。
 *   GET /api/ai-rhythm/records  个人纪录/极值(奖杯架)。
 * 必须在 src/serve/app.ts 的 createApp 里注册,否则不可达。
 */
export function registerAiRhythmRoutes(app: Hono, db: Database.Database): void {
  app.get("/api/ai-rhythm/heatmap", (c) => {
    try {
      return c.json({ ok: true, ...heatmapRhythm(db) });
    } catch (e) {
      return jsonErr(500, e instanceof Error ? e.message : String(e));
    }
  });

  app.get("/api/ai-rhythm/streak", (c) => {
    try {
      return c.json({ ok: true, ...streakRhythm(db) });
    } catch (e) {
      return jsonErr(500, e instanceof Error ? e.message : String(e));
    }
  });

  app.get("/api/ai-rhythm/commands", (c) => {
    try {
      return c.json({ ok: true, ...commandLeaderboard(db) });
    } catch (e) {
      return jsonErr(500, e instanceof Error ? e.message : String(e));
    }
  });

  app.get("/api/ai-rhythm/source-trend", (c) => {
    try {
      return c.json({ ok: true, ...weeklySourceMix(db) });
    } catch (e) {
      return jsonErr(500, e instanceof Error ? e.message : String(e));
    }
  });

  app.get("/api/ai-rhythm/records", (c) => {
    try {
      return c.json({ ok: true, ...personalRecords(db) });
    } catch (e) {
      return jsonErr(500, e instanceof Error ? e.message : String(e));
    }
  });
}
