/**
 * 可嵌入卡片 API(SVG)。
 *   GET /api/cards/rhythm.svg    作息热力图卡片(周几×小时,image/svg+xml)。
 *   GET /api/cards/calendar.svg  活动日历卡片(GitHub 贡献图式,周/月份×星期几)。
 * 仅本地(127.0.0.1)可达,用于预览 / 让 CLI 取图;真正"发布"的是 CLI 写出的 .svg 文件。
 * 必须在 src/serve/app.ts 的 createApp 里注册。
 */
import type { Hono } from "hono";
import type Database from "better-sqlite3";
import { heatmapRhythm, activityCalendar } from "../aiRhythm/queries.js";
import { renderRhythmSvg } from "./rhythmSvg.js";
import { renderCalendarSvg } from "./calendarSvg.js";

const SVG_HEADERS = {
  "Content-Type": "image/svg+xml; charset=utf-8",
  "Cache-Control": "no-store",
} as const;

export function registerCardRoutes(app: Hono, db: Database.Database): void {
  app.get("/api/cards/rhythm.svg", (c) =>
    c.body(renderRhythmSvg(heatmapRhythm(db)), 200, SVG_HEADERS)
  );
  app.get("/api/cards/calendar.svg", (c) =>
    c.body(renderCalendarSvg(activityCalendar(db)), 200, SVG_HEADERS)
  );
}
