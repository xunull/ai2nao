import { existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { Message } from "@ag-ui/core";
import { registerLlmChatSessionRoutes } from "../src/llmChat/sessionRoutes.js";
import {
  activateChatCompaction,
  ensureLlmChatSession,
  replaceLlmChatSessionMessages,
} from "../src/llmChat/sessions.js";
import { openDatabase } from "../src/store/open.js";

/**
 * 分页原文接口(粗 T4 第 3 片 · 后端)。Sheet 靠它看被压缩掉的轮次。
 *
 * 两条最要紧的都是**泄漏型**静默错:`raw_json` 里带着协议原文与 `ai2nao*` 字段,
 * 整行透出去就等于把内部数据发给界面;服务端专有行(账目、占位、压缩事件)混进来,
 * 用户会在原文里看到一堆 `[activity]`。两者都不会报错。
 */

function withApp(run: (app: Hono, db: ReturnType<typeof openDatabase>) => Promise<void> | void) {
  return async () => {
    const path = join(tmpdir(), `ai2nao-msgs-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
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

const turns = (n: number): Message[] =>
  Array.from({ length: n }, (_, i) => [
    { id: `u${i}`, role: "user", content: `问${i}` } as Message,
    { id: `a${i}`, role: "assistant", content: `答${i}` } as Message,
  ]).flat();

const get = (app: Hono, path: string) => app.request(path);

type Page = {
  messages: { messageId: string; messageIndex: number; role: string; text: string }[];
  nextBefore: number | null;
};

describe("GET /api/llm-chat/sessions/:id/messages", () => {
  it(
    "★ 服务端专有行不返回,且绝不透出 raw_json",
    withApp(async (app, db) => {
      ensureLlmChatSession(db, "s1");
      replaceLlmChatSessionMessages(db, "s1", { messages: turns(2) });
      activateChatCompaction(db, "s1", {
        id: "k1", trigger: "manual", excludedMessageIds: ["u0"],
        summary: { decisions: [], constraints: [], state: [], nextSteps: [] },
        summaryCallIds: [],
      });

      const res = await get(app, "/api/llm-chat/sessions/s1/messages");
      expect(res.status).toBe(200);
      const body = (await res.json()) as Page;
      expect(body.messages.some((m) => m.messageId.startsWith("ai2nao:"))).toBe(false);
      // 整行透出的话这里会有 raw_json / plain_text 之外的字段。
      expect(Object.keys(body.messages[0]!).sort()).toEqual(
        ["createdAt", "messageId", "messageIndex", "preview", "role", "text"]
      );
    })
  );

  it(
    "★ 含被压缩掉的轮次 —— Sheet 的全部意义就在这里",
    withApp(async (app, db) => {
      ensureLlmChatSession(db, "s1");
      replaceLlmChatSessionMessages(db, "s1", { messages: turns(2) });
      activateChatCompaction(db, "s1", {
        id: "k1", trigger: "manual", excludedMessageIds: ["u0", "a0"],
        summary: { decisions: [], constraints: [], state: [], nextSteps: [] },
        summaryCallIds: [],
      });
      const body = (await (await get(app, "/api/llm-chat/sessions/s1/messages")).json()) as Page;
      // 压缩只是「不再发给模型」,原文一条都不能少。
      expect(body.messages.map((m) => m.messageId).sort()).toEqual(["a0", "a1", "u0", "u1"]);
    })
  );

  it(
    "★ 总数正好是 limit 的整数倍时,末页的 nextBefore 必须是 null",
    withApp(async (app, db) => {
      ensureLlmChatSession(db, "s1");
      replaceLlmChatSessionMessages(db, "s1", { messages: turns(2) }); // 共 4 条
      const p1 = (await (await get(app, "/api/llm-chat/sessions/s1/messages?limit=2")).json()) as Page;
      expect(p1.messages.map((m) => m.messageId)).toEqual(["a1", "u1"]);
      expect(p1.nextBefore).not.toBeNull();

      const p2 = (await (
        await get(app, `/api/llm-chat/sessions/s1/messages?limit=2&before=${p1.nextBefore}`)
      ).json()) as Page;
      expect(p2.messages.map((m) => m.messageId)).toEqual(["a0", "u0"]);
      // 靠「条数 === limit」推断的话这里是非 null,前端会再请求一次拿到空页。
      expect(p2.nextBefore).toBeNull();
    })
  );

  it(
    "参数非法 → 400;会话不存在 → 404",
    withApp(async (app, db) => {
      ensureLlmChatSession(db, "s1");
      replaceLlmChatSessionMessages(db, "s1", { messages: turns(1) });
      expect((await get(app, "/api/llm-chat/sessions/s1/messages?before=abc")).status).toBe(400);
      expect((await get(app, "/api/llm-chat/sessions/s1/messages?limit=0")).status).toBe(400);
      expect((await get(app, "/api/llm-chat/sessions/没有这个/messages")).status).toBe(404);
    })
  );
});
