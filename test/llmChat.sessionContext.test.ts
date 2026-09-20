import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Message } from "@ag-ui/core";
import { sessionContextSnapshot } from "../src/llmChat/copilotRuntime.js";
import {
  activateChatCompaction,
  ensureLlmChatSession,
  finishChatCall,
  insertPendingChatCall,
  replaceLlmChatSessionMessages,
  setSessionCompactionAuto,
} from "../src/llmChat/sessions.js";
import { writeCachedCatalog } from "../src/cost/modelCatalog.js";
import { resetSettingsForTest } from "../src/settings/store.js";
import { openDatabase } from "../src/store/open.js";

/**
 * `/usage` 的上下文占用快照(粗 T4 第 3 片 · 后端)。
 *
 * 这一片的失败几乎都是**静默**的:窗口取不到时当成 0,界面会显示「已用 100%」;
 * 分项与头条数字口径不同却并列,用户会看到四项加不回总数;被压缩的消息漏进估算,
 * 压缩看着就像没生效。所以下面每条都断言**数值关系**,不只断言字段存在。
 */

const PROVIDER = "openai-compatible";
const MODEL = "test-model";
const SNAPSHOT = { modelId: `${PROVIDER}:${MODEL}`, provider: PROVIDER, model: MODEL, label: "测试模型" };

let home: string;
let db: ReturnType<typeof openDatabase>;
let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ai2nao-sctx-"));
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

/** 种一笔已结算的 answer 账目 —— `selectSessionModel` 靠它认出会话在用哪个模型。 */
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

const turns = (n: number, pad = 20): Message[] =>
  Array.from({ length: n }, (_, i) => [
    { id: `u${i}`, role: "user", content: `问${i}${"字".repeat(pad)}` } as Message,
    { id: `a${i}`, role: "assistant", content: `答${i}${"字".repeat(pad)}` } as Message,
  ]).flat();

describe("会话上下文占用快照", () => {
  it("★ 分项之和等于 breakdownTotal —— 各自取整再与另算的总数并列就会加不回去", () => {
    ensureLlmChatSession(db, "s1");
    seedAnswerCall("s1");
    seedWindow(4000, 400);
    replaceLlmChatSessionMessages(db, "s1", { messages: turns(3) });
    const c = sessionContextSnapshot({ db }, "s1");
    const b = c.breakdown;
    expect(b.system + b.summary + b.recent + b.toolResults + b.images).toBe(c.breakdownTotal);
  });

  it("★ 纯估算时 breakdownTotal 必须等于 estimatedInput(不变量)", () => {
    ensureLlmChatSession(db, "s1");
    seedAnswerCall("s1");
    seedWindow(4000, 400);
    replaceLlmChatSessionMessages(db, "s1", { messages: turns(3) });
    const c = sessionContextSnapshot({ db }, "s1");
    // 对不上基准就是全量估算,两个数必须是同一个口径。不等的话界面上
    // 「分项」与「已用」会差一截,而且没有任何东西说明为什么。
    expect(c.estimateOnly).toBe(true);
    expect(c.breakdownTotal).toBe(c.estimatedInput);
  });

  it("★ 认不出模型:窗口是 null 而不是 0 —— 当成 0 界面会显示「已用 100%」", () => {
    ensureLlmChatSession(db, "s1");
    // 不种 answer 账目 → selectSessionModel 失败。
    replaceLlmChatSessionMessages(db, "s1", { messages: turns(1) });
    const c = sessionContextSnapshot({ db }, "s1");
    expect(c.model).toBeNull();
    expect(c.contextWindow).toBeNull();
    // 窗口未知仍要给输出预留兜底值,否则调用方没法算「还能发多少」。
    expect(c.outputReserve).toBeGreaterThan(0);
  });

  it("★ 生效压缩:摘要单独成项,且被排除的消息不再计入正文", () => {
    ensureLlmChatSession(db, "s1");
    seedAnswerCall("s1");
    seedWindow(4000, 400);
    replaceLlmChatSessionMessages(db, "s1", { messages: turns(3) });
    const before = sessionContextSnapshot({ db }, "s1");

    activateChatCompaction(db, "s1", {
      id: "k1",
      trigger: "manual",
      excludedMessageIds: ["u0", "a0", "u1", "a1"],
      summary: { decisions: ["压缩过的决定"], constraints: [], state: [], nextSteps: [] },
      summaryCallIds: [],
    });
    const after = sessionContextSnapshot({ db }, "s1");

    // 摘要要能单独看见 —— 拼进 system 一项的话,用户看不出「摘要占了多少」。
    expect(before.breakdown.summary).toBe(0);
    expect(after.breakdown.summary).toBeGreaterThan(0);
    // 被折叠的四条不再进正文。漏切的话压缩看着就像没生效。
    expect(after.breakdown.recent).toBeLessThan(before.breakdown.recent);
  });

  it("自动压缩开关如实透出(默认关)", () => {
    ensureLlmChatSession(db, "s1");
    seedAnswerCall("s1");
    expect(sessionContextSnapshot({ db }, "s1").autoCompaction).toBe(false);
    setSessionCompactionAuto(db, "s1", true);
    expect(sessionContextSnapshot({ db }, "s1").autoCompaction).toBe(true);
  });

  it("★ 省略状态与阶梯第 1 步同一个判据:没超预算就是 false", () => {
    ensureLlmChatSession(db, "s1");
    seedAnswerCall("s1");
    seedWindow(1_000_000, 400);
    replaceLlmChatSessionMessages(db, "s1", { messages: turns(5) });
    // 窗口大得离谱 → 不会省略。另写一份判据的话,这里会与运行路径对不上。
    expect(sessionContextSnapshot({ db }, "s1").toolResultsOmitted).toBe(false);
  });

  it("空会话不抛,给出可用的零值", () => {
    ensureLlmChatSession(db, "s1");
    const c = sessionContextSnapshot({ db }, "s1");
    expect(c.breakdown.recent).toBe(0);
    expect(c.estimatedInput).toBeGreaterThanOrEqual(0);
  });

  it("★ 建议折叠点:轮次不够时为 null,够了给 message_index 而不是数组下标", () => {
    ensureLlmChatSession(db, "s1");
    seedAnswerCall("s1");
    seedWindow(4000, 400);

    // 只有 2 个用户轮,保留 3 轮的话没得折 —— 必须是 null,不能是 0。
    // 给 0 的话界面那个按钮会「折叠到下标 0」,等于什么都不折却提示已压缩。
    replaceLlmChatSessionMessages(db, "s1", { messages: turns(2) });
    expect(sessionContextSnapshot({ db }, "s1").suggestedCompactUpTo).toBeNull();

    // 6 个用户轮,保留最近 3 个 → 折到第 4 个用户轮所在的 message_index。
    replaceLlmChatSessionMessages(db, "s1", { messages: turns(6) });
    const at = sessionContextSnapshot({ db }, "s1").suggestedCompactUpTo;
    expect(at).not.toBeNull();
    // turns(n) 的第 i 个用户轮落在下标 2i;倒数第 3 个用户轮是 i=3 → 下标 6。
    // 这里断言的是**持久化下标**,不是数组位置 —— 两者顺序一致但数值可以不等。
    const row = db
      .prepare("SELECT message_index FROM llm_chat_messages WHERE session_id = ? AND message_id = ?")
      .get("s1", "u3") as { message_index: number } | undefined;
    expect(at).toBe(row?.message_index);
  });

  it("★ 压缩费用预估:没有折叠点为 null;有价格时至少覆盖摘要输出上限那部分", () => {
    ensureLlmChatSession(db, "s1");
    seedAnswerCall("s1");
    // 每 token 单价,与账本同一口径。输出单价故意与输入不同,好让断言分得清是哪一侧。
    writeCachedCatalog({
      fetchedAt: new Date().toISOString(),
      providers: { [PROVIDER]: [MODEL] },
      pricing: {
        [PROVIDER]: {
          [MODEL]: {
            base: { input: 1e-6, output: 3e-6, cacheRead: 0, cacheWrite: 0 },
            tiers: [],
            limit: { context: 100_000, output: 400 },
          },
        },
      },
    });

    // 2 个用户轮,保留 3 轮 → 没得折 → 不写「约 $X」。
    replaceLlmChatSessionMessages(db, "s1", { messages: turns(2) });
    expect(sessionContextSnapshot({ db }, "s1").compactCostEstimateUsd).toBeNull();

    replaceLlmChatSessionMessages(db, "s1", { messages: turns(6) });
    const small = sessionContextSnapshot({ db }, "s1").compactCostEstimateUsd;
    // 输出按每块 4096 计(含思考,实测取整,偏高):单块时恰好 4096 × 3e-6,再加上输入那部分。
    expect(small).not.toBeNull();
    expect(small!).toBeGreaterThan(4096 * 3e-6);
    // 输入按真实提示词估:同样的轮数、每轮字数翻很多倍,预估必须跟着涨。
    // 写死常数或只算输出的话,这条会原地不动。
    replaceLlmChatSessionMessages(db, "s1", { messages: turns(6, 2000) });
    const big = sessionContextSnapshot({ db }, "s1").compactCostEstimateUsd;
    expect(big!).toBeGreaterThan(small!);
  });

  it("★ 缺价格时费用预估为 null,不编一个 $0", () => {
    ensureLlmChatSession(db, "s1");
    seedAnswerCall("s1");
    // 目录里有窗口、但**没有**这个模型的价格条目;内置价格表也没有 openai-compatible。
    writeCachedCatalog({
      fetchedAt: new Date().toISOString(),
      providers: { [PROVIDER]: [MODEL] },
      pricing: {},
    });
    replaceLlmChatSessionMessages(db, "s1", { messages: turns(6) });
    const c = sessionContextSnapshot({ db }, "s1");
    expect(c.suggestedCompactUpTo).not.toBeNull(); // 有折叠点,只是估不出价
    expect(c.compactCostEstimateUsd).toBeNull();
  });
});
