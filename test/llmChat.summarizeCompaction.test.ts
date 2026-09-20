import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { sessionContextSnapshot, summarizeForCompaction } from "../src/llmChat/copilotRuntime.js";
import {
  claimChatRun,
  completeChatRun,
  ensureLlmChatSession,
  finishChatCall,
  insertPendingChatCall,
  listChatCalls,
  listChatRuns,
  readChatCompactionEvents,
  replaceLlmChatSessionMessages,
  replayCompactionStack,
} from "../src/llmChat/sessions.js";
import { writeCachedCatalog } from "../src/cost/modelCatalog.js";
import { resetSettingsForTest } from "../src/settings/store.js";
import { openDatabase } from "../src/store/open.js";
import type { Message } from "@ag-ui/core";

/**
 * 摘要器(粗 T7 第 4b 片)。
 *
 * 这一片的每条失败都是**静默**的:收尾漏掉会把会话永久卡在 running;模型恢复错了会把
 * 内容发给另一家还照常计费;折叠断了会让前几块的决定无声消失;校验没拦住会写进一条
 * 结构不对的摘要。所以下面的断言都盯着「有没有写事件」「用的是哪个模型」「run 行收没收尾」。
 */

// 扁平配置走 legacy 分支,实例 id = sanitizeInstanceId("openai-compatible") ——
// 所以视图 id 是 "openai-compatible:test-model"。账目里的快照必须与它一致。
const PROVIDER = "openai-compatible";
const MODEL = "test-model";
const MODEL_ID = `${PROVIDER}:${MODEL}`;
const SNAPSHOT = { modelId: MODEL_ID, provider: PROVIDER, model: MODEL, label: "测试模型" };

let home: string;
let db: ReturnType<typeof openDatabase>;
let savedConfigDb: string | undefined;
let savedChatConfig: string | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ai2nao-summarize-"));
  savedConfigDb = process.env.AI2NAO_CONFIG_DB;
  savedChatConfig = process.env.AI2NAO_LLM_CHAT_CONFIG;
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
  if (savedConfigDb === undefined) delete process.env.AI2NAO_CONFIG_DB;
  else process.env.AI2NAO_CONFIG_DB = savedConfigDb;
  if (savedChatConfig === undefined) delete process.env.AI2NAO_LLM_CHAT_CONFIG;
  else process.env.AI2NAO_LLM_CHAT_CONFIG = savedChatConfig;
  if (existsSync(home)) rmSync(home, { recursive: true, force: true });
});

/** 窗口喂小一点,好让两轮分成两块去验「折叠」。 */
function seedWindow(contextTokens: number): void {
  writeCachedCatalog({
    fetchedAt: new Date().toISOString(),
    providers: { [PROVIDER]: [MODEL] },
    pricing: {
      [PROVIDER]: {
        [MODEL]: {
          base: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          tiers: [],
          limit: { context: contextTokens, output: 1000 },
        },
      },
    },
  });
}

/** 种一笔已结算的 answer 账目 —— `selectSessionModel` 靠它认出「这个会话在用哪个模型」。 */
function seedAnswerCall(sid: string, snapshot = SNAPSHOT): void {
  insertPendingChatCall(db, sid, {
    callId: `c:r0:answer:0:0`, runId: "r0", fence: 0, purpose: "answer",
    stepIndex: 0, attempt: 0, model: snapshot,
    sendView: { count: 1, prefixHash: "a".repeat(12), systemHash: "b".repeat(12), toolsHash: "c".repeat(12) },
    maxOutputTokens: 1000,
  });
  finishChatCall(db, sid, "c:r0:answer:0:0", "completed", {
    input: 10, noCache: 10, cacheRead: 0, cacheWrite: 0, output: 5, reasoning: 0,
  });
}

const turnsOf = (n: number, pad = 10): Message[] =>
  Array.from({ length: n }, (_, i) => [
    { id: `u${i}`, role: "user", content: `问题${i}${"充".repeat(pad)}` } as Message,
    { id: `a${i}`, role: "assistant", content: `回答${i}${"答".repeat(pad)}` } as Message,
  ]).flat();

const stackOf = (sid: string) => replayCompactionStack(readChatCompactionEvents(db, sid));

const SUMMARY_JSON = JSON.stringify({
  decisions: ["用 SQLite"], constraints: ["schema 钉死"], state: ["压缩已实现"], nextSteps: ["接路由"],
});

/** 每次 doStream 返回给定文本;实例收进数组以便断言发出去的 prompt。 */
function models(reply: (nth: number) => string) {
  const seen: MockLanguageModelV3[] = [];
  let nth = 0;
  return {
    seen,
    createModel: () => {
      const text = reply(nth);
      nth += 1;
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
  };
}

describe("摘要器", () => {
  it("成功路径:写入压缩事件,带两段确定性内容,run 行收尾为 completed", async () => {
    ensureLlmChatSession(db, "s1");
    seedAnswerCall("s1");
    replaceLlmChatSessionMessages(db, "s1", { messages: turnsOf(2) });
    const { createModel } = models(() => SUMMARY_JSON);

    const out = await summarizeForCompaction({ db, createModel }, "s1", 4, new AbortController().signal);
    expect(out.summary.decisions).toEqual(["用 SQLite"]);
    expect(stackOf("s1")).toHaveLength(1);
    // 第一条压缩没有 base;手动路由触发的记 manual。
    expect(out).toMatchObject({ kind: "compaction", baseId: null, trigger: "manual" });
    // 排除集合按 id 存,且确实是被折叠的那 4 条。
    expect(out.excludedMessageIds).toEqual(["u0", "a0", "u1", "a1"]);
    // run 行必须收尾 —— 漏掉的话这个会话之后每一轮都会被判成 running 而拒绝。
    expect(listChatRuns(db, "s1").find((r) => r.runId !== "r0")?.status).toBe("completed");
    // 每块一笔 compact 账。
    const compactCalls = listChatCalls(db, "s1").filter((c) => c.purpose === "compact");
    expect(compactCalls.length).toBeGreaterThan(0);
    // ★ `summaryCallIds` 必须是账本里真实存在的 id。拼 `:0` 的话,SDK 重试过就会指向
    // 一条不存在的账目 —— 不报错,只是这条事件的账从此对不上。
    expect(out.summaryCallIds).toEqual(compactCalls.map((c) => c.callId));
    expect(out.summaryCallIds.length).toBeGreaterThan(0);
  });

  it("★ 用的是这个会话最后一笔 answer 的模型,不是文档默认", async () => {
    ensureLlmChatSession(db, "s1");
    seedAnswerCall("s1");
    replaceLlmChatSessionMessages(db, "s1", { messages: turnsOf(1) });
    const { createModel } = models(() => SUMMARY_JSON);
    await summarizeForCompaction({ db, createModel }, "s1", 2, new AbortController().signal);
    const compact = listChatCalls(db, "s1").find((c) => c.purpose === "compact");
    expect(compact?.model).toMatchObject({ provider: PROVIDER, model: MODEL });
  });

  it("★ 会话用过的模型已不存在:拒绝且**不写事件** —— 绝不静默换家", async () => {
    ensureLlmChatSession(db, "s1");
    seedAnswerCall("s1", { modelId: "别家:某模型", provider: "别家", model: "某模型", label: "别家" });
    replaceLlmChatSessionMessages(db, "s1", { messages: turnsOf(1) });
    const { createModel, seen } = models(() => SUMMARY_JSON);
    await expect(
      summarizeForCompaction({ db, createModel }, "s1", 2, new AbortController().signal)
    ).rejects.toThrow();
    expect(readChatCompactionEvents(db, "s1")).toEqual([]);
    // 一次模型都不该发 —— 发了就说明换家之后照样花了钱。
    expect(seen).toHaveLength(0);
  });

  it("★ 对话进行中:拒绝,并给出可操作文案", async () => {
    ensureLlmChatSession(db, "s1");
    seedAnswerCall("s1");
    replaceLlmChatSessionMessages(db, "s1", { messages: turnsOf(1) });
    const held = claimChatRun(db, "s1", "u-held");
    expect(held.ok).toBe(true);
    const { createModel } = models(() => SUMMARY_JSON);
    await expect(
      summarizeForCompaction({ db, createModel }, "s1", 2, new AbortController().signal)
    ).rejects.toThrow(/正在生成回答/);
    expect(readChatCompactionEvents(db, "s1")).toEqual([]);
  });

  it("★ 结构校验失败:零事件,run 行标 failed", async () => {
    ensureLlmChatSession(db, "s1");
    seedAnswerCall("s1");
    replaceLlmChatSessionMessages(db, "s1", { messages: turnsOf(1) });
    const { createModel } = models(() => JSON.stringify({ decisions: ["只有一项"] }));
    await expect(
      summarizeForCompaction({ db, createModel }, "s1", 2, new AbortController().signal)
    ).rejects.toThrow(/结构/);
    // 原子激活:任一步失败就不写事件,原上下文继续有效。
    expect(readChatCompactionEvents(db, "s1")).toEqual([]);
    expect(listChatRuns(db, "s1").find((r) => r.runId !== "r0")?.status).toBe("failed");
  });

  it("★ 多块时是折叠:第二次请求带着第一块的摘要", async () => {
    ensureLlmChatSession(db, "s1");
    seedAnswerCall("s1");
    seedWindow(200); // 预算 = 200 × 0.6 × 2 = 240 字符 → 两轮必然分成多块
    replaceLlmChatSessionMessages(db, "s1", { messages: turnsOf(2, 120) });
    const first = JSON.stringify({ decisions: ["第一块的决定"], constraints: [], state: [], nextSteps: [] });
    const { createModel, seen } = models((n) => (n === 0 ? first : SUMMARY_JSON));

    const folded = await summarizeForCompaction({ db, createModel }, "s1", 4, new AbortController().signal);
    expect(seen.length).toBeGreaterThan(1);
    // 分块多笔,`summaryCallIds` 要把每一块都记下,不是只记最后一块。
    expect(folded.summaryCallIds.length).toBe(seen.length);
    const secondPrompt = JSON.stringify(seen[1]!.doStreamCalls[0]?.prompt ?? null);
    // 折叠断了的话,第一块的决定不会出现在第二次请求里,最终摘要就少了它 —— 不报错。
    expect(secondPrompt).toContain("第一块的决定");
  });
});

describe("复用调用方的占位(自动压缩要走这条)", () => {
  it("★ 传 existing 时不再自己占位 —— 否则会撞上自己的 running 而永远不触发", async () => {
    ensureLlmChatSession(db, "s1");
    seedAnswerCall("s1");
    replaceLlmChatSessionMessages(db, "s1", { messages: turnsOf(1) });
    // 模拟 run 循环:这一轮**已经占着位**。
    const held = claimChatRun(db, "s1", "u-held");
    expect(held.ok).toBe(true);
    if (!held.ok) return;
    const before = listChatRuns(db, "s1").length;

    const { createModel } = models(() => SUMMARY_JSON);
    const out = await summarizeForCompaction(
      { db, createModel }, "s1", 2, new AbortController().signal,
      { runId: held.run.runId, fence: held.run.fence },
      "auto"
    );
    expect(out.summary.decisions).toEqual(["用 SQLite"]);
    // trigger 从 `existing` 反推的话,手动路由哪天也传了占位就会被误记成 auto。
    expect(out.trigger).toBe("auto");

    // 没有新增 run 行:复用就该复用,再占一次既会被拒、也会多出一行。
    expect(listChatRuns(db, "s1")).toHaveLength(before);
    // **没有替调用方收尾** —— 收了的话 run 循环后面的 renew/complete 全落空,
    // 而那一轮还在继续生成。
    expect(listChatRuns(db, "s1").find((r) => r.runId === held.run.runId)?.status).toBe("running");
  });

  it("★ 记账挂在调用方的 runId/fence 上,不是另起一轮", async () => {
    ensureLlmChatSession(db, "s1");
    seedAnswerCall("s1");
    replaceLlmChatSessionMessages(db, "s1", { messages: turnsOf(1) });
    const held = claimChatRun(db, "s1", "u-held2");
    expect(held.ok).toBe(true);
    if (!held.ok) return;

    const { createModel } = models(() => SUMMARY_JSON);
    await summarizeForCompaction(
      { db, createModel }, "s1", 2, new AbortController().signal,
      { runId: held.run.runId, fence: held.run.fence }
    );
    const compact = listChatCalls(db, "s1").filter((c) => c.purpose === "compact");
    expect(compact.length).toBeGreaterThan(0);
    // 账目挂错 runId 的话,这一轮的用量统计会把压缩那几笔算到别处去。
    expect(compact.every((c) => c.runId === held.run.runId)).toBe(true);
    // 调用方仍然是占位持有者,收尾权在它手上。
    completeChatRun(db, "s1", held.run.runId, "completed");
    expect(listChatRuns(db, "s1").find((r) => r.runId === held.run.runId)?.status).toBe("completed");
  });

  it("★ 释放量 = 压缩前后占用快照的全量估算之差(规格《7》:成功后显示释放量)", async () => {
    ensureLlmChatSession(db, "s1");
    seedAnswerCall("s1");
    seedWindow(100_000);
    replaceLlmChatSessionMessages(db, "s1", { messages: turnsOf(4, 200) });
    const before = sessionContextSnapshot({ db }, "s1").breakdownTotal;
    const { createModel } = models(() => SUMMARY_JSON);

    const out = await summarizeForCompaction({ db, createModel }, "s1", 4, new AbortController().signal);
    const after = sessionContextSnapshot({ db }, "s1").breakdownTotal;

    // 断言**等于**快照之差,不只是「大于 0」:另算一套口径的话,分隔线上写的释放量
    // 与占用条前后的变化会对不上,而且不报错。
    expect(out.freedTokens).toBe(before - after);
    // 折掉两轮各 200 字的问答,换进一小段摘要 —— 必须真的省下了。
    expect(out.freedTokens).toBeGreaterThan(0);
    // 落进事件行,刷新后读得回来(分隔线靠的就是这一份)。
    expect(stackOf("s1")[0]?.freedTokens).toBe(out.freedTokens);
  });

  it("★ 正文里带 <think> 的模型(MiniMax 形状):剥掉思考再解析,不当成坏 JSON", async () => {
    ensureLlmChatSession(db, "s1");
    seedAnswerCall("s1");
    replaceLlmChatSessionMessages(db, "s1", { messages: turnsOf(2) });
    const { createModel } = models(() => `<think>先想想要保留什么。</think>\n\n${SUMMARY_JSON}`);
    const out = await summarizeForCompaction({ db, createModel }, "s1", 4, new AbortController().signal);
    expect(out.summary.decisions).toEqual(["用 SQLite"]);
  });

  it("★ 输出额度给思考留了空间:请求的 maxOutputTokens 是输出预留,不是 2048", async () => {
    ensureLlmChatSession(db, "s1");
    seedAnswerCall("s1");
    seedWindow(100_000); // limit.output = 1000 → 输出预留取 max(2048, 1000) = 2048
    replaceLlmChatSessionMessages(db, "s1", { messages: turnsOf(2) });
    // 改成 output 16000:预留 16000 > 2048,请求就该带 16000。
    writeCachedCatalog({
      fetchedAt: new Date().toISOString(),
      providers: { [PROVIDER]: [MODEL] },
      pricing: { [PROVIDER]: { [MODEL]: { base: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, tiers: [], limit: { context: 100_000, output: 16_000 } } } },
    });
    const { createModel, seen } = models(() => SUMMARY_JSON);
    await summarizeForCompaction({ db, createModel }, "s1", 4, new AbortController().signal);
    // 实测 DeepSeek V4 flash:额度 2048 时思考就把它用完了,正文为空。
    expect(seen[0]!.doStreamCalls[0]!.maxOutputTokens).toBe(16_000);
  });

  it("★ 额度被思考耗尽、一个字正文都没有:错误要说清楚,别报「不是合法 JSON」", async () => {
    ensureLlmChatSession(db, "s1");
    seedAnswerCall("s1");
    replaceLlmChatSessionMessages(db, "s1", { messages: turnsOf(2) });
    const createModel = () =>
      new MockLanguageModelV3({
        doStream: async () => ({
          stream: simulateReadableStream({
            chunks: [
              { type: "stream-start", warnings: [] },
              { type: "reasoning-start", id: "r" },
              { type: "reasoning-delta", id: "r", delta: "想了很久……" },
              { type: "reasoning-end", id: "r" },
              { type: "finish", finishReason: { unified: "length" }, usage: { inputTokens: { total: 9 }, outputTokens: { total: 2048 } } },
            ] as never,
            initialDelayInMs: null, chunkDelayInMs: null,
          }),
        }),
      });
    await expect(
      summarizeForCompaction({ db, createModel }, "s1", 4, new AbortController().signal)
    ).rejects.toThrow(/思考/);
    expect(stackOf("s1")).toHaveLength(0); // 失败不写事件
  });
});

