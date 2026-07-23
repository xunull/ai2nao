/**
 * 可嵌入卡片 API(SVG),由 registry 驱动:
 *   GET /api/cards/:name.svg   渲染注册表里对应的卡(image/svg+xml);未知 name → 404。
 * 仅本地(127.0.0.1)可达,用于预览 / 让 CLI 取图;真正"发布"的是 `card bundle` 写出的文件。
 * 必须在 src/serve/app.ts 的 createApp 里注册。
 */
import type Database from "better-sqlite3";
import type { Hono } from "hono";
import { findCard } from "./registry.js";

const SVG_HEADERS = {
  "Content-Type": "image/svg+xml; charset=utf-8",
  "Cache-Control": "no-store",
} as const;

export function registerCardRoutes(app: Hono, db: Database.Database): void {
  app.get("/api/cards/:file", (c) => {
    const name = c.req.param("file").replace(/\.svg$/, "");
    const card = findCard(name);
    if (!card) return c.notFound();
    return c.body(card.render(db), 200, SVG_HEADERS);
  });
}
