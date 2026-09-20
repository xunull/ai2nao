import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { registerCopilotKitRoutes } from "../src/llmChat/copilotRuntime.js";
import { getLlmChatSession, listChatCalls, listChatRuns } from "../src/llmChat/sessions.js";
import { openDatabase } from "../src/store/open.js";

/**
 * 用户点「停止」(T11 欠下的那条)。
 *
 * 前端的 `abortRun()` 不调后端的 `/stop`,只是断开请求 —— 所以这里就这么停:读到一半
 * 中止请求。AI SDK 收到中止信号时**不抛错**,流会正常结束;所以停止很容易被一路走成
 * 「正常完成」。每条断言都盯着一种那样走错时的样子。
 */

function tempPath(name: string): string {
  return join(tmpdir(), `ai2nao-${Date.now()}-${Math.random().toString(36).slice(2)}-${name}`);
}

const DELTAS = 40;

function slowModel(): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks: [
          { type: "stream-start", warnings: [] },
          { type: "text-start", id: "0" },
          ...Array.from({ length: DELTAS }, (_, i) => ({ type: "text-delta", id: "0", delta: `第${i + 1}字 ` })),
          { type: "text-end", id: "0" },
          { type: "finish", finishReason: { unified: "stop" },
            usage: { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: DELTAS, text: DELTAS, reasoning: 0 } } },
        ] as never,
        initialDelayInMs: null,
        chunkDelayInMs: 25,
      }),
    }),
  });
}

describe("停止:读到一半断开请求", () => {
  it("★ 运行与这笔账都记 aborted;已流出的正文落库;不再补答、不追加兜底回答", async () => {
    const dbPath = tempPath("stop.db");
    const db = openDatabase(dbPath);
    const configPath = tempPath("chat.json");
    const prior = process.env.AI2NAO_LLM_CHAT_CONFIG;
    let models = 0;
    try {
      writeFileSync(configPath, JSON.stringify({ provider: "openai-compatible", baseURL: "http://127.0.0.1:11434/v1", model: "test-model", apiKey: "k" }));
      process.env.AI2NAO_LLM_CHAT_CONFIG = configPath;
      const app = new Hono();
      registerCopilotKitRoutes(app, { db, createModel: () => { models += 1; return slowModel(); } });

      // 生产里客户端断开时,@hono/node-server 中止的是 **request.signal**,CopilotKit 运行时
      // 靠它拆订阅。只取消响应体在这里不等价(实测整轮照样跑完),所以按真实机制停。
      const disconnect = new AbortController();
      const res = await app.request("/api/copilotkit/agent/default/run", {
        signal: disconnect.signal,
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          threadId: "t-stop", runId: "r-stop",
          messages: [{ id: "u1", role: "user", content: "慢慢数" }],
          tools: [], context: [], state: {}, forwardedProps: {},
        }),
      });
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let seen = "";
      // 等到流出几个字再停 —— 太早停测不到「半步落库」,太晚停整轮就跑完了。
      while (!/第5字/.test(seen)) {
        const { value, done } = await reader.read();
        if (done) throw new Error("流在停止之前就结束了");
        seen += decoder.decode(value, { stream: true });
      }
      disconnect.abort();
      await reader.cancel().catch(() => {});

      // 收尾是异步的:等运行离开 running。
      const deadline = Date.now() + 5_000;
      while (listChatRuns(db, "t-stop")[0]?.status === "running" && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 30));
      }

      // 1. 运行是 aborted,不是 completed —— 记成 completed 的话,重复提交判定会把 u1 当成已答完。
      expect(listChatRuns(db, "t-stop")[0]?.status).toBe("aborted");
      // 2. 账不挂在 pending(中间件只靠 flush 的话会永远 pending)。
      const calls = listChatCalls(db, "t-stop");
      expect(calls.map((c) => `${c.purpose}/${c.status}`)).toEqual(["answer/aborted"]);
      // 3. 没有补答 —— 停了之后不许再发请求。
      expect(models).toBe(1);
      // 4. 已流出的正文落库,且确实只是一半;没有追加兜底回答。
      const rows = getLlmChatSession(db, "t-stop")!.messages.filter((m) => !m.message_id.startsWith("ai2nao:"));
      expect(rows.map((r) => r.role)).toEqual(["user", "assistant"]);
      const text = rows[1]!.plain_text;
      expect(text).toMatch(/第5字/);
      expect(text).not.toMatch(new RegExp(`第${DELTAS}字`));
    } finally {
      db.close();
      if (existsSync(dbPath)) unlinkSync(dbPath);
      if (existsSync(configPath)) unlinkSync(configPath);
      if (prior === undefined) delete process.env.AI2NAO_LLM_CHAT_CONFIG;
      else process.env.AI2NAO_LLM_CHAT_CONFIG = prior;
    }
  });

  it("★ 走 CopilotKit 的停止路由:响应流里正常收尾,不出现 RUN_ERROR(否则每次停止都弹错误横幅)", async () => {
    const dbPath = tempPath("stop-route.db");
    const db = openDatabase(dbPath);
    const configPath = tempPath("chat.json");
    const prior = process.env.AI2NAO_LLM_CHAT_CONFIG;
    try {
      writeFileSync(configPath, JSON.stringify({ provider: "openai-compatible", baseURL: "http://127.0.0.1:11434/v1", model: "test-model", apiKey: "k" }));
      process.env.AI2NAO_LLM_CHAT_CONFIG = configPath;
      const app = new Hono();
      registerCopilotKitRoutes(app, { db, createModel: () => slowModel() });

      const res = await app.request("/api/copilotkit/agent/default/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          threadId: "t-stop2", runId: "r-stop2",
          messages: [{ id: "u1", role: "user", content: "慢慢数" }],
          tools: [], context: [], state: {}, forwardedProps: {},
        }),
      });
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let sse = "";
      let stopped = false;
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        sse += decoder.decode(value, { stream: true });
        if (!stopped && /第5字/.test(sse)) {
          stopped = true;
          const r = await app.request("/api/copilotkit/agent/default/stop/t-stop2", { method: "POST" });
          expect(r.status).toBe(200);
        }
      }

      expect(stopped).toBe(true);
      expect(sse).not.toContain("RUN_ERROR");
      expect(sse).toContain("RUN_FINISHED");
      expect(listChatRuns(db, "t-stop2")[0]?.status).toBe("aborted");
      expect(listChatCalls(db, "t-stop2").map((c) => c.status)).toEqual(["aborted"]);
    } finally {
      db.close();
      if (existsSync(dbPath)) unlinkSync(dbPath);
      if (existsSync(configPath)) unlinkSync(configPath);
      if (prior === undefined) delete process.env.AI2NAO_LLM_CHAT_CONFIG;
      else process.env.AI2NAO_LLM_CHAT_CONFIG = prior;
    }
  });
});

