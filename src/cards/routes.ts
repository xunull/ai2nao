/**
 * 可嵌入卡片 API(SVG)。
 *   GET /api/cards/rhythm.svg  作息热力图卡片(image/svg+xml)。
 * 仅本地(127.0.0.1)可达,用于预览 / 让 CLI 取图;真正"发布"的是 CLI 写出的 .svg 文件。
 * 必须在 src/serve/app.ts 的 createApp 里注册。
 */
import type { Hono } from "hono";
import type Database from "better-sqlite3";
import { heatmapRhythm } from "../aiRhythm/queries.js";
import { renderRhythmSvg } from "./rhythmSvg.js";

export function registerCardRoutes(app: Hono, db: Database.Database): void {
  app.get("/api/cards/rhythm.svg", (c) => {
    const svg = renderRhythmSvg(heatmapRhythm(db));
    return c.body(svg, 200, {
      "Content-Type": "image/svg+xml; charset=utf-8",
      "Cache-Control": "no-store",
    });
  });
}
