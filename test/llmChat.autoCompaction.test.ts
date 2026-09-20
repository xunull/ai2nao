import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { registerCopilotKitRoutes } from "../src/llmChat/copilotRuntime.js";
import {
  ensureLlmChatSession,
  finishChatCall,
  insertPendingChatCall,
  listChatRuns,
  readChatCompactionEvents,
  replaceLlmChatSessionMessages,
  replayCompactionStack,
  setSessionCompactionAuto,
} from "../src/llmChat/sessions.js";
import { writeCachedCatalog } from "../src/cost/modelCatalog.js";
import { resetSettingsForTest } from "../src/settings/store.js";
import { openDatabase } from "../src/store/open.js";
import type { Message } from "@ag-ui/core";

/**
 * 自动压缩触发点(粗 T7 收尾)。
 *
 * 这个分支同时被三个条件把守(窗口已知、估算 > 窗口 × 0.9、会话开关开)。任一条写反,
 * 它就**永远不触发**,而整套测试照样绿 —— 典型的死代码型静默失败。所以下面每条都
 * 断言「库里/请求里的实际后果」,不只看 HTTP 200。
 */

const PROVIDER = "openai-compatible";
const MODEL = "test-model";
const SNAPSHOT = { modelId: `${PROVIDER}:${MODEL}`, provider: PROVIDER, model: MODEL, label: "测试模型" };
const SUMMARY_JSON = JSON.stringify({
  decisions: ["压缩过的决定"], constraints: [], state: [], nextSteps: [],
});

let home: string;
let db: ReturnType<typeof openDatabase>;
let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ai2nao-autoc-"));
  saved = { cfgdb: process.env.AI2NAO_CONFIG_DB, chat: process.env.AI2NAO_LLM_CHAT_CONFIG };
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

const stackOf = (sid: string) => replayCompactionStack(readChatCompactionEvents(db, sid));

/** 窗口 200 / 输出 50 → 阶梯阈值 150,自动阈值 180。两者刻意不同。 */
function seedWindow(context: number, output: number): void {
  writeCachedCatalog({
    fetchedAt: new Date().toISOString(),
    providers: { [PROVIDER]: [MODEL] },
    pricing: {
      [PROVIDER]: {
        [MODEL]: {
          base: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          tiers: [],
          limit: { context, output },
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

/**
 * **每次调用都返回同一个 reply。**
 *
 * 起初写成「第 0 次给摘要 JSON,其后给答案」,而多块压缩会**逐块各发一次请求** ——
 * 于是第 2 块拿到「这是回答」,解析失败、压缩被放弃,自动压缩看着就像没触发。
 * 按调用序区分用途是个错误的耦合:块数由窗口与历史长度决定,夹具无从预知。
 *
 * 主回答那次会拿到 JSON 字符串当正文,但这些用例断言的是**发出去的 prompt** 与
 * 库里的压缩事件,与回复正文无关。
 */
function makeApp(reply = SUMMARY_JSON) {
  const seen: MockLanguageModelV3[] = [];
  const app = new Hono();
  registerCopilotKitRoutes(app, {
    db,
    createModel: () => {
      const text = reply;
      const m = new MockLanguageModelV3({
        doStream: async () => ({
          stream: simulateReadableStream({
            chunks: [
              { type: "stream-start", warnings: [] },
              { type: "text-start", id: "0" },
              { type: "text-delta", id: "0", delta: text },
              { type: "text-end", id: "0" },
              { type: "finish", finishReason: { unified: "stop" },
                usage: { inputTokens: { total: 9 }, outputTokens: { total: 3 } } },
            ] as never,
            initialDelayInMs: null, chunkDelayInMs: null,
          }),
        }),
      });
      seen.push(m);
      return m;
    },
  });
  return { app, seen };
}

/** 造 n 个用户轮并落库,让持久化下标与数组下标产生偏移(分两批落)。 */
function seedHistory(sid: string, n: number, pad: number): void {
  const first: Message[] = [
    { id: "w0", role: "user", content: "占位轮" } as Message,
    { id: "z0", role: "assistant", content: "好" } as Message,
  ];
  replaceLlmChatSessionMessages(db, sid, { messages: first });
  const rest: Message[] = [];
  for (let i = 0; i < n; i += 1) {
    rest.push({ id: `u${i}`, role: "user", content: `问${i}${"字".repeat(pad)}` } as Message);
    rest.push({ id: `a${i}`, role: "assistant", content: `答${i}${"字".repeat(pad)}` } as Message);
  }
  replaceLlmChatSessionMessages(db, sid, { messages: [...first, ...rest] });
}

/**
 * **必须把 SSE 正文读完。** `observableFromAi2NaoTurn` 的 teardown 会调
 * `abortController.abort()`;没人消费正文时订阅被拆,信号在生成**中途**被中止,
 * 压缩那条流读到一半就断 —— SDK 报的是 `NoOutputGeneratedError`,而不是
 * 「已中止」。本仓库其它端到端测试都 `await res.text()`,这里漏了。
 */
const run = async (app: Hono, sid: string) => {
  const res = await app.request("/api/copilotkit/agent/default/run", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      threadId: sid, runId: `r-${sid}`,
      messages: [{ id: "newq", role: "user", content: "新问题" }],
      tools: [], context: [], state: {}, forwardedProps: {},
    }),
  });
  await res.text();
  return res;
};

describe("自动压缩触发点", () => {
  it("★ 默认关:超阈值也不压 —— 读反了就是「没开却被扣压缩的钱」", async () => {
    ensureLlmChatSession(db, "s1");
    seedAnswerCall("s1");
    seedWindow(200, 50);
    seedHistory("s1", 5, 200);
    const { app } = makeApp();
    await run(app, "s1");
    expect(stackOf("s1")).toEqual([]);
  });

  it("★ 开关开 + 超阈值:真的触发,写入一条压缩事件", async () => {
    ensureLlmChatSession(db, "s1");
    seedAnswerCall("s1");
    seedWindow(200, 50);
    seedHistory("s1", 5, 200);
    setSessionCompactionAuto(db, "s1", true);
    const { app } = makeApp();
    await run(app, "s1");
    // 不触发的话这里是空数组 —— 整个功能就是装饰。
    expect(stackOf("s1")).toHaveLength(1);
    // ★ 自动触发的必须记 auto。反推 trigger 的话这里会是 manual,而用量页就分不出
    // 「我自己点的」和「系统替我压的」—— 那正是用户会来问的那个问题。
    expect(stackOf("s1")[0]?.trigger).toBe("auto");
  });

  it("★ 阈值是 窗口×0.9,不是阶梯的 窗口−预留(两者刻意不同)", async () => {
    ensureLlmChatSession(db, "s1");
    seedAnswerCall("s1");
    // 窗口 4000 / 输出 400 → 阶梯阈值 3600,自动阈值 3600。取一个更大的输出预留拉开差距:
    // 窗口 4000 / 输出 1200 → 阶梯 2800,自动 3600。估算落在两者之间时只该走阶梯。
    seedWindow(4000, 1200);
    // 按校准后的估算器(中文 1.4 字符/token)实测:pad=520 时全量估算约 3225 token,
    // 离 2800 与 3600 各留约 400 余量。系数再变的话按同样方法重量,别凭字符数心算。
    seedHistory("s1", 4, 520);
    setSessionCompactionAuto(db, "s1", true);
    const { app } = makeApp();
    await run(app, "s1");
    // 超过阶梯阈值但没到自动阈值 —— 不该压缩。两个判据若被合并成一个,这条会红。
    expect(stackOf("s1")).toEqual([]);
  });

  it("★ 复用这一轮的占位:不新增 run 行", async () => {
    ensureLlmChatSession(db, "s1");
    seedAnswerCall("s1");
    seedWindow(200, 50);
    seedHistory("s1", 5, 200);
    setSessionCompactionAuto(db, "s1", true);
    const { app } = makeApp();
    await run(app, "s1");
    // 压缩若自己 claim,要么被拒(功能失效),要么多出一行。两者都不该发生。
    const runs = listChatRuns(db, "s1").filter((r) => r.runId !== "r0");
    expect(runs).toHaveLength(1);
  });

  it("★ 压缩后重算:发给模型的 prompt 里没有被折叠的旧内容", async () => {
    ensureLlmChatSession(db, "s1");
    seedAnswerCall("s1");
    // **这条用例的窗口必须大于其余几条。** 窗口 200 时,光系统提示加最新一轮就要
    // 约 489 token > 预算 150 —— 压缩之后仍然超窗,第 4 步正确地拒绝,主回答的
    // streamText **根本不会发生**,于是最后一个实例仍是压缩块。
    // 取 4000/400:自动阈值 3600;8 轮约 4000 token 先超阈值,压缩后只留最近 3 轮
    // 约 1500 token,低于预算,回答才跑得起来。
    seedWindow(4000, 400);
    seedHistory("s1", 8, 500);
    setSessionCompactionAuto(db, "s1", true);
    const { app, seen } = makeApp();
    await run(app, "s1");
    expect(stackOf("s1")).toHaveLength(1);
    // **取最后一个实例,不要数下标。** 压缩是多块的(块数由窗口与历史长度决定,
    // 夹具无从预知),实例顺序是「压缩块 0..n,然后才是正式回答」。原来写死 seen[1],
    // 取到的是压缩块 —— 它的 prompt 里当然有「问0」,那正是被摘要的内容。
    const answer = seen[seen.length - 1];
    const answerPrompt = JSON.stringify(answer?.doStreamCalls[0]?.prompt ?? null);
    // 「新问题」只会出现在回答里:压缩读的是持久化行,而这条新消息此刻还没落库。
    expect(answerPrompt).toContain("新问题");
    // 漏掉压缩后重算的话,回答仍带着被折叠的 问0/答0。
    expect(answerPrompt).not.toContain("问0");
    // ★ 但摘要必须进 system。分隔线是 activity 行,而 `agUiMessagesToModelMessages`
    // 一条 activity 分支都没有 —— 靠它带摘要的话,这里就是「砍掉了上文,也不给梗概」。
    expect(answerPrompt).toContain("压缩过的决定");
  });

  it("★ 压缩失败不让这一轮直接死", async () => {
    ensureLlmChatSession(db, "s1");
    seedAnswerCall("s1");
    seedWindow(200, 50);
    seedHistory("s1", 5, 200);
    setSessionCompactionAuto(db, "s1", true);
    // 摘要返回结构不合法 → 压缩抛错 → 这一轮应继续走预算闸,而不是 500。
    const { app } = makeApp(JSON.stringify({ decisions: ["缺字段"] }));
    const res = await run(app, "s1");
    expect(res.status).toBe(200);
    expect(stackOf("s1")).toEqual([]);
  });
});
