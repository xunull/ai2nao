import { existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { registerLlmChatSessionRoutes } from "../src/llmChat/sessionRoutes.js";
import { ensureLlmChatSession, readSessionCompactionSettings } from "../src/llmChat/sessions.js";
import { openDatabase } from "../src/store/open.js";

/**
 * 自动压缩开关的 HTTP 路由。此前只有存储函数,界面上的「本会话不自动压缩 / 恢复」无处可调。
 */

function withApp(run: (app: Hono, db: ReturnType<typeof openDatabase>) => Promise<void>) {
  return async () => {
    const path = join(tmpdir(), `ai2nao-cset-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    const db = openDatabase(path);
    const app = new Hono();
    registerLlmChatSessionRoutes(app, { db });
    try {
      await run(app, db);
    } finally {
      db.close();
      if (existsSync(path)) unlinkSync(path);
    }
  };
}

const patch = (app: Hono, id: string, body: unknown) =>
  app.request(`/api/llm-chat/sessions/${id}/compaction-settings`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

describe("PATCH /api/llm-chat/sessions/:id/compaction-settings", () => {
  it("开了读得回 true,再关读得回 false", withApp(async (app, db) => {
    ensureLlmChatSession(db, "s1");
    const on = await patch(app, "s1", { auto: true });
    expect(on.status).toBe(200);
    expect(((await on.json()) as { settings: { auto: boolean } }).settings.auto).toBe(true);
    expect(readSessionCompactionSettings(db, "s1").auto).toBe(true);

    expect((await patch(app, "s1", { auto: false })).status).toBe(200);
    expect(readSessionCompactionSettings(db, "s1").auto).toBe(false);
  }));

  it("★ 只收布尔:字符串 \"false\" → 400,且开关不动", withApp(async (app, db) => {
    ensureLlmChatSession(db, "s1");
    await patch(app, "s1", { auto: true });
    // 若把 "false" 当真值收下,用户点「关」之后它反而还开着 —— 而且看不出来。
    expect((await patch(app, "s1", { auto: "false" })).status).toBe(400);
    expect(readSessionCompactionSettings(db, "s1").auto).toBe(true);
  }));

  it("非 JSON 体 → 400;会话不存在 → 404", withApp(async (app, db) => {
    ensureLlmChatSession(db, "s1");
    expect((await patch(app, "s1", "不是 JSON")).status).toBe(400);
    expect((await patch(app, "没有这个", { auto: true })).status).toBe(404);
  }));
});
