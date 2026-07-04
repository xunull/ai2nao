import type { Hono } from "hono";
import type Database from "better-sqlite3";
import { heatmapRhythm } from "./queries.js";

function jsonErr(status: number, message: string) {
  return Response.json({ error: { message } }, { status });
}

/**
 * 「我的 AI 节律」自量化仪表盘 API。
 *   GET /api/ai-rhythm/heatmap  作息热力图(weekday×hour,仅 is_human,全源全时段)。
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
}
