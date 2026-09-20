import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { registerCopilotKitRoutes } from "../src/llmChat/copilotRuntime.js";
import {
  activateChatCompaction,
  ensureLlmChatSession,
  finishChatCall,
  insertPendingChatCall,
  readChatCompactionEvents,
  replaceLlmChatSessionMessages,
  replayCompactionStack,
} from "../src/llmChat/sessions.js";
import { writeCachedCatalog } from "../src/cost/modelCatalog.js";
import { resetSettingsForTest } from "../src/settings/store.js";
import { openDatabase } from "../src/store/open.js";
import type { Message } from "@ag-ui/core";

/**
 * 压缩与撤销两条 HTTP 路由(粗 T7 第 4 片收尾)。
 *
 * 路由层的失败几乎都是**「长得像成功」**:状态码给错、错误文案被替换成通用串、
 * 或者撤销闸判之前就已经把 active 翻掉了。所以下面每条都同时断言
 * **状态码 + 文案 + 库里的实际状态**,不只看 HTTP 200/4xx。
 */

const PROVIDER = "openai-compatible";
const MODEL = "test-model";
const SNAPSHOT = { modelId: `${PROVIDER}:${MODEL}`, provider: PROVIDER, model: MODEL, label: "测试模型" };
const SUMMARY_JSON = JSON.stringify({
  decisions: ["决定"], constraints: [], state: [], nextSteps: [],
});

let home: string;
let db: ReturnType<typeof openDatabase>;
let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ai2nao-croutes-"));
  saved = {
    cfgdb: process.env.AI2NAO_CONFIG_DB,
    chat: process.env.AI2NAO_LLM_CHAT_CONFIG,
  };
  process.env.AI2NAO_HOME = home;
  process.env.AI2NAO_CONFIG_DB = join(home, "config.db");
  const cfg = join(home, "chat.json");
  writeFileSync(cfg, JSON.stringify({ provider: PROVIDER, baseURL: "http://127.0.0.1:1/v1", model: MODEL, apiKey: "k" }));
  process.env.AI2NAO_LLM_CHAT_CONFIG = cfg;
  resetSettingsForTest();
  db = openDatabase(join(home, "idx.db"));
});

afterEach(() => {
  db.close();
  resetSettingsForTest();
  delete process.env.AI2NAO_HOME;
  if (saved.cfgdb === undefined) delete process.env.AI2NAO_CONFIG_DB;
  else process.env.AI2NAO_CONFIG_DB = saved.cfgdb;
  if (saved.chat === undefined) delete process.env.AI2NAO_LLM_CHAT_CONFIG;
  else process.env.AI2NAO_LLM_CHAT_CONFIG = saved.chat;
  if (existsSync(home)) rmSync(home, { recursive: true, force: true });
});

function seedWindow(contextTokens: number, outputTokens = 100): void {
  writeCachedCatalog({
    fetchedAt: new Date().toISOString(),
    providers: { [PROVIDER]: [MODEL] },
    pricing: {
      [PROVIDER]: {
        [MODEL]: {
          base: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          tiers: [],
          limit: { context: contextTokens, output: outputTokens },
        },
      },
    },
  });
}

function seedAnswerCall(sid: string): void {
  insertPendingChatCall(db, sid, {
    callId: "c:r0:answer:0:0", runId: "r0", fence: 0, purpose: "answer",
    stepIndex: 0, attempt: 0, model: SNAPSHOT,
    sendView: { count: 1, prefixHash: "a".repeat(12), systemHash: "b".repeat(12), toolsHash: "c".repeat(12) },
    maxOutputTokens: 1000,
  });
  finishChatCall(db, sid, "c:r0:answer:0:0", "completed", {
    input: 10, noCache: 10, cacheRead: 0, cacheWrite: 0, output: 5, reasoning: 0,
  });
}

function makeApp(reply: string = SUMMARY_JSON): Hono {
  const app = new Hono();
  registerCopilotKitRoutes(app, {
    db,
    createModel: () =>
      new MockLanguageModelV3({
        doStream: async () => ({
          stream: simulateReadableStream({
            chunks: [
              { type: "stream-start", warnings: [] },
              { type: "text-start", id: "0" },
              { type: "text-delta", id: "0", delta: reply },
              { type: "text-end", id: "0" },
              { type: "finish", finishReason: { unified: "stop" },
                usage: { inputTokens: { total: 9 }, outputTokens: { total: 3 } } },
            ] as never,
            initialDelayInMs: null, chunkDelayInMs: null,
          }),
        }),
      }),
  });
  return app;
}

const stackOf = (sid: string) => replayCompactionStack(readChatCompactionEvents(db, sid));

const post = (app: Hono, path: string, body: unknown) =>
  app.request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

const turns = (n: number, pad = 5): Message[] =>
  Array.from({ length: n }, (_, i) => [
    { id: `u${i}`, role: "user", content: `问${i}${"字".repeat(pad)}` } as Message,
    { id: `a${i}`, role: "assistant", content: `答${i}${"字".repeat(pad)}` } as Message,
  ]).flat();

describe("POST 立即压缩", () => {
  it("正常路径:写入一条压缩事件", async () => {
    ensureLlmChatSession(db, "s1");
    seedAnswerCall("s1");
    replaceLlmChatSessionMessages(db, "s1", { messages: turns(2) });
    const res = await post(makeApp(), "/api/copilotkit/agent/default/compact/s1", { upToMessageIndex: 4 });
    expect(res.status).toBe(200);
    expect(stackOf("s1")).toHaveLength(1);
  });

  it("★ 缺 upToMessageIndex → 400,且一条事件都不写", async () => {
    ensureLlmChatSession(db, "s1");
    seedAnswerCall("s1");
    replaceLlmChatSessionMessages(db, "s1", { messages: turns(1) });
    const res = await post(makeApp(), "/api/copilotkit/agent/default/compact/s1", {});
    expect(res.status).toBe(400);
    // 守卫写错的话会拿 undefined 去折叠 —— 那会静默折叠掉一个任意区间。
    expect(readChatCompactionEvents(db, "s1")).toEqual([]);
  });

  it("非 JSON 体 → 400,不是 500", async () => {
    ensureLlmChatSession(db, "s1");
    const res = await post(makeApp(), "/api/copilotkit/agent/default/compact/s1", "不是 JSON");
    expect(res.status).toBe(400);
  });

  it("★ 摘要器的可操作文案原样透出(结构校验失败 → 409 且带「结构」二字)", async () => {
    ensureLlmChatSession(db, "s1");
    seedAnswerCall("s1");
    replaceLlmChatSessionMessages(db, "s1", { messages: turns(1) });
    const res = await post(
      makeApp(JSON.stringify({ decisions: ["缺字段"] })),
      "/api/copilotkit/agent/default/compact/s1",
      { upToMessageIndex: 2 }
    );
    expect(res.status).toBe(409);
    // 文案被替换成通用串的话,模型漂移/进行中那两条拒绝的价值就全没了。
    expect((await res.json() as { error: string }).error).toContain("结构");
    expect(readChatCompactionEvents(db, "s1")).toEqual([]);
  });
});

describe("POST 撤销", () => {
  const seedCompaction = (sid: string, id: string, excluded: string[]) =>
    activateChatCompaction(db, sid, {
      id,
      trigger: "manual",
      excludedMessageIds: excluded,
      summary: { decisions: [], constraints: [], state: [], nextSteps: [] },
      summaryCallIds: [],
    });

  it("正常路径:追加一条 revert,栈变空", async () => {
    ensureLlmChatSession(db, "s1");
    seedAnswerCall("s1");
    replaceLlmChatSessionMessages(db, "s1", { messages: turns(1) });
    seedCompaction("s1", "k1", ["u0"]);
    const res = await post(makeApp(), "/api/copilotkit/agent/default/compaction/s1/undo", { compactionId: "k1" });
    expect(res.status).toBe(200);
    expect(stackOf("s1")).toEqual([]);
    // 只追加不修改:压缩那条事件必须还在,否则退不回中间层。
    expect(readChatCompactionEvents(db, "s1").map((e) => e.kind)).toEqual(["compaction", "revert"]);
  });

  it("★ 只能撤销栈顶:撤销被压在下面的那条 → 409 且零写入", async () => {
    ensureLlmChatSession(db, "s1");
    seedAnswerCall("s1");
    replaceLlmChatSessionMessages(db, "s1", { messages: turns(2) });
    seedCompaction("s1", "A", ["u0"]);
    seedCompaction("s1", "B", ["u0", "a0", "u1"]);
    const res = await post(makeApp(), "/api/copilotkit/agent/default/compaction/s1/undo", { compactionId: "A" });
    expect(res.status).toBe(409);
    // 放行跳层撤销的话,「发给模型的内容」就不再是事件序列的函数 —— 栈必须原封不动。
    expect(stackOf("s1").map((c) => c.id)).toEqual(["A", "B"]);
    expect(readChatCompactionEvents(db, "s1")).toHaveLength(2);
  });

  it("未知或已撤销 → 404", async () => {
    ensureLlmChatSession(db, "s1");
    seedAnswerCall("s1");
    const res = await post(makeApp(), "/api/copilotkit/agent/default/compaction/s1/undo", { compactionId: "不存在" });
    // 栈是空的 —— 没有「最近一次压缩」可撤,这是 404 不是 409。
    expect(res.status).toBe(404);
  });

  it("★ 撤销闸:超窗时 409,且 active 绝不被翻掉", async () => {
    ensureLlmChatSession(db, "s1");
    seedAnswerCall("s1");
    seedWindow(200, 100); // 预算 ≈ 100 token
    const long = turns(6, 400);
    replaceLlmChatSessionMessages(db, "s1", { messages: long });
    seedCompaction("s1", "k1", long.slice(0, 10).map((m) => String(m.id)));
    const res = await post(makeApp(), "/api/copilotkit/agent/default/compaction/s1/undo", { compactionId: "k1" });
    expect(res.status).toBe(409);
    expect((await res.json() as { error: string }).error).toContain("撤销后上下文");
    // 先写后判、或 catch 吞掉,都会让栈变空 —— 会话带着超窗上下文进下一轮。
    expect(stackOf("s1").map((c) => c.id)).toEqual(["k1"]);
  });

  it("★ 认不出模型时仍可撤销 —— 删过厂商配置的用户不该永远恢复不了历史", async () => {
    ensureLlmChatSession(db, "s1");
    replaceLlmChatSessionMessages(db, "s1", { messages: turns(1) });
    seedCompaction("s1", "k1", ["u0"]);
    const res = await post(makeApp(), "/api/copilotkit/agent/default/compaction/s1/undo", { compactionId: "k1" });
    // 取模型只为拿窗口做预算闸;取不到＝窗口未知,按既定策略放行(与
    // assertWithinContextBudget 对 null 窗口的处置一致)。这条曾经写成
    // `expect([200,409]).toContain(...)` —— 两个分支都接受,于是它永远不会红,
    // 而 409 这个缺陷就一直藏着。
    expect(res.status).toBe(200);
    expect(stackOf("s1")).toEqual([]);
  });
});
