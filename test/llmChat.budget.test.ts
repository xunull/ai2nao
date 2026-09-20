import { existsSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { registerCopilotKitRoutes } from "../src/llmChat/copilotRuntime.js";
import {
  ensureLlmChatSession,
  finishChatCall,
  findEstimateBaseline,
  insertPendingChatCall,
  replaceLlmChatSessionMessages,
  type ChatCallUsage,
  type SendView,
} from "../src/llmChat/sessions.js";
import { writeCachedCatalog } from "../src/cost/modelCatalog.js";
import { resetSettingsForTest } from "../src/settings/store.js";
import { openDatabase } from "../src/store/open.js";
import type { Message } from "@ag-ui/core";
import {
  agUiMessagesToModelMessages,
  assertWithinContextBudget,
  type SendViewEntry,
} from "../src/llmChat/copilotRuntime.js";

/**
 * 预算闸的单元测试。
 *
 * 照 `assertCanSendImages` 的先例:那个函数**为了能被单测直接打而导出**,
 * 不必跑完整回合。这里同理 —— 预算判定是纯算术,跑一整轮既慢又会把真正的
 * 判定逻辑淹没在时序里。
 *
 * **每条都断言文案内容,不只断言「抛了」。** 这条错误的全部价值在于可操作:
 * 用户要能照着做(压缩、开新会话、换模型)。只断言 `toThrow()` 的话,把文案换成
 * 「error」也照样绿。
 */

const BASE = {
  contextWindow: 100_000,
  outputReserve: 8_192,
  modelLabel: "测试模型",
};
/** 预算 = 窗口 − 预留 = 91808。 */
const BUDGET = BASE.contextWindow - BASE.outputReserve;

describe("预算闸 assertWithinContextBudget", () => {
  it("在预算内:不抛", () => {
    expect(() =>
      assertWithinContextBudget({ ...BASE, estimatedInput: 1000, irreducibleInput: 500 })
    ).not.toThrow();
  });

  it("★ 恰好等于预算:不抛 —— 边界用 <= 而不是 <", () => {
    // 差一个 token 就拒绝请求是没道理的;而这条边界写反了不会有任何别的症状。
    expect(() =>
      assertWithinContextBudget({ ...BASE, estimatedInput: BUDGET, irreducibleInput: 0 })
    ).not.toThrow();
    expect(() =>
      assertWithinContextBudget({ ...BASE, estimatedInput: BUDGET + 1, irreducibleInput: 0 })
    ).toThrow();
  });

  it("★ 窗口未知时不拦 —— 「目录里没有这个模型」不等于「这个模型不能用」", () => {
    expect(() =>
      assertWithinContextBudget({
        ...BASE,
        contextWindow: null,
        estimatedInput: 99_999_999,
        irreducibleInput: 99_999_999,
      })
    ).not.toThrow();
  });

  it("超预算但历史可压缩:文案要给出「压缩或开新会话」这个可操作动作", () => {
    try {
      assertWithinContextBudget({
        ...BASE,
        estimatedInput: BUDGET + 5_000,
        irreducibleInput: 1_000,
      });
      throw new Error("should have thrown");
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toContain("先压缩这个会话");
      expect(msg).toContain("开一个新会话");
      // 带上具体数字,用户才知道差多少而不是「反正超了」。
      expect(msg).toContain(String(BUDGET + 5_000));
      expect(msg).toContain(String(BUDGET));
      // 这条**不该**说「最近一轮本身超窗」—— 那是另一种处置。
      expect(msg).not.toContain("最近一轮本身");
    }
  });

  it("★ 不可压缩部分本身就超:改说「压缩也救不了」,别让用户白压一次", () => {
    try {
      assertWithinContextBudget({
        ...BASE,
        estimatedInput: BUDGET + 50_000,
        irreducibleInput: BUDGET + 10_000,
      });
      throw new Error("should have thrown");
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toContain("最近一轮本身");
      expect(msg).toContain("压缩历史也救不了");
      // 可操作动作变成「缩短这条消息 / 换更大窗口的模型」,而不是压缩。
      expect(msg).toContain("换一个窗口更大的模型");
      expect(msg).not.toContain("先压缩这个会话");
    }
  });

  it("两条文案都带模型名 —— 用户要看得出是哪个模型的窗口", () => {
    for (const irreducible of [1_000, BUDGET + 10_000]) {
      try {
        assertWithinContextBudget({
          ...BASE,
          estimatedInput: BUDGET + 50_000,
          irreducibleInput: irreducible,
        });
        throw new Error("should have thrown");
      } catch (e) {
        expect((e as Error).message).toContain("测试模型");
      }
    }
  });
});

/**
 * 阶梯第 1 步:省略「最近 3 个用户轮之前」的工具结果正文。
 *
 * 这里直接打转换函数,不跑整轮 —— **标签不落库**(`SendView` 只存 count 与三个
 * hash),从账目里根本看不到 `tool-result-omitted`。要验标签就只能在这一层验。
 */
function toolCall(id: string, query: string) {
  return {
    id,
    type: "function",
    function: { name: "ai2nao_web_search", arguments: JSON.stringify({ query }) },
  };
}

/** 两个用户轮,每轮各有一次工具调用与结果。下标:0=u1 1=a1 2=t1 3=u2 4=a2 5=t2 */
function twoTurnsWithTools(): Message[] {
  return [
    { id: "u1", role: "user", content: "第一问" } as Message,
    { id: "a1", role: "assistant", content: "", toolCalls: [toolCall("c1", "旧")] } as unknown as Message,
    { id: "t1", role: "tool", toolCallId: "c1", content: '{"items":[{"title":"很长的旧结果正文"}]}' } as unknown as Message,
    { id: "u2", role: "user", content: "第二问" } as Message,
    { id: "a2", role: "assistant", content: "", toolCalls: [toolCall("c2", "新")] } as unknown as Message,
    { id: "t2", role: "tool", toolCallId: "c2", content: '{"items":[{"title":"新结果正文"}]}' } as unknown as Message,
  ];
}

const tagOf = (view: SendViewEntry[], id: string) => view.find((e) => e.messageId === id)?.tag;

describe("阶梯第 1 步:省略旧工具结果", () => {
  it("不传 omitToolResultsBefore 时什么都不省 —— 非空转对照", () => {
    const view: SendViewEntry[] = [];
    const out = agUiMessagesToModelMessages(twoTurnsWithTools(), undefined, view);
    expect(tagOf(view, "t1")).toBe("raw");
    expect(tagOf(view, "t2")).toBe("raw");
    expect(JSON.stringify(out)).toContain("很长的旧结果正文");
  });

  it("★ 旧的换成占位、新的原样,且标签只给被省的那条", () => {
    const view: SendViewEntry[] = [];
    // 3 = u2 的下标:它之前的工具结果(t1)才省。
    const out = agUiMessagesToModelMessages(twoTurnsWithTools(), undefined, view, 3);
    expect(tagOf(view, "t1")).toBe("tool-result-omitted");
    expect(tagOf(view, "t2")).toBe("raw");
    const dumped = JSON.stringify(out);
    expect(dumped).toContain("这一步的工具结果较早");
    // 旧正文真的没发出去 —— 只断言「有占位」的话,两份都发了也照样绿。
    expect(dumped).not.toContain("很长的旧结果正文");
    // 新的一轮不受影响。
    expect(dumped).toContain("新结果正文");
  });

  it("★ 配对不能被拆开 —— 省略后 tool 消息条数不变", () => {
    const full = agUiMessagesToModelMessages(twoTurnsWithTools(), undefined, []);
    const omitted = agUiMessagesToModelMessages(twoTurnsWithTools(), undefined, [], 3);
    const toolCount = (ms: unknown[]) =>
      ms.filter((m) => (m as { role?: string }).role === "tool").length;
    // 少一条 tool-result 而 tool-call 还在,厂商会直接 400 —— 省略只换正文,不删消息。
    expect(toolCount(omitted)).toBe(toolCount(full));
    expect(omitted).toHaveLength(full.length);
  });
});

// ── 基准查找 ────────────────────────────────────────────────────────────
const MODEL = { modelId: "m1", provider: "p1", model: "mm", label: "测试模型" };
const VIEW: SendView = { count: 2, prefixHash: "aaaaaaaaaaaa", systemHash: "ssssssssssss", toolsHash: "tttttttttttt" };
const USAGE = (input: number): ChatCallUsage => ({
  input, noCache: input, cacheRead: 0, cacheWrite: 0, output: 10, reasoning: 0,
});

function withDb(run: (db: ReturnType<typeof openDatabase>) => void): void {
  const path = join(tmpdir(), `ai2nao-budget-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  const db = openDatabase(path);
  try {
    run(db);
  } finally {
    db.close();
    if (existsSync(path)) unlinkSync(path);
  }
}

/** 落一笔已结算的账。`over` 用来逐条破坏某一个匹配条件。 */
function seedCall(
  db: ReturnType<typeof openDatabase>,
  sid: string,
  callId: string,
  over: Partial<{
    purpose: "answer" | "finalize";
    model: typeof MODEL;
    sendView: SendView | undefined;
    usage: ChatCallUsage | null;
    status: "completed" | "failed";
  }> = {}
): void {
  insertPendingChatCall(db, sid, {
    callId, runId: "r1", fence: 1,
    purpose: over.purpose ?? "answer",
    stepIndex: 0, attempt: 0,
    model: over.model ?? MODEL,
    sendView: "sendView" in over ? over.sendView : VIEW,
    maxOutputTokens: 1000,
  });
  finishChatCall(db, sid, callId, over.status ?? "completed", "usage" in over ? over.usage : USAGE(500));
}

const CURRENT = {
  model: { provider: "p1", model: "mm" },
  systemHash: VIEW.systemHash,
  toolsHash: VIEW.toolsHash,
  prefixHashOfFirst: (count: number) => (count === VIEW.count ? VIEW.prefixHash : "zzzzzzzzzzzz"),
};

describe("findEstimateBaseline —— 八个条件各自会否决", () => {
  it("全都匹配:返回它", () => {
    withDb((db) => {
      ensureLlmChatSession(db, "s1");
      seedCall(db, "s1", "c:ok");
      expect(findEstimateBaseline(db, "s1", CURRENT)?.callId).toBe("c:ok");
    });
  });

  it("★ 取最近一笔,不是最早那笔", () => {
    withDb((db) => {
      ensureLlmChatSession(db, "s1");
      seedCall(db, "s1", "c:old", { usage: USAGE(100) });
      seedCall(db, "s1", "c:new", { usage: USAGE(900) });
      expect(findEstimateBaseline(db, "s1", CURRENT)?.usage?.input).toBe(900);
    });
  });

  const rejects: Array<[string, Parameters<typeof seedCall>[3]]> = [
    ["purpose 是 finalize(补答内容形状完全不同)", { purpose: "finalize" }],
    ["没结算完", { status: "failed" }],
    ["usage.input 为空", { usage: null }],
    ["★ 老账目没有 sendView(这两个键是后加的)", { sendView: undefined }],
    ["换了模型(分词不可比)", { model: { ...MODEL, model: "别的模型" } }],
  ];
  for (const [name, over] of rejects) {
    it(`否决:${name}`, () => {
      withDb((db) => {
        ensureLlmChatSession(db, "s1");
        seedCall(db, "s1", "c:bad", over);
        expect(findEstimateBaseline(db, "s1", CURRENT)).toBeNull();
      });
    });
  }

  it("否决:systemHash / toolsHash / prefixHash 任一不符", () => {
    for (const patch of [
      { systemHash: "别的system" },
      { toolsHash: "别的tools" },
      { prefixHashOfFirst: () => "对不上的前缀" },
    ]) {
      withDb((db) => {
        ensureLlmChatSession(db, "s1");
        seedCall(db, "s1", "c:x");
        expect(findEstimateBaseline(db, "s1", { ...CURRENT, ...patch })).toBeNull();
      });
    }
  });
});

// ── 阶梯端到端 ──────────────────────────────────────────────────────────
describe("阶梯第 1 步端到端:省略后的正文真的发出去了", () => {
  it("★ 超预算时发给模型的 prompt 含占位,且不含被省的旧正文", async () => {
    const home = mkdtempSync(join(tmpdir(), "ai2nao-budget-e2e-"));
    const savedConfigDb = process.env.AI2NAO_CONFIG_DB;
    const savedChatConfig = process.env.AI2NAO_LLM_CHAT_CONFIG;
    const dbPath = join(home, "idx.db");
    const db = openDatabase(dbPath);
    const chatConfig = join(home, "chat.json");
    const models: MockLanguageModelV3[] = [];
    // env 只在这条用例内部改并还原 —— config_meta 是进程级状态,
    // 泄漏出去会让别的测试里的 test-model 突然有了窗口,预算闸莫名生效。
    process.env.AI2NAO_HOME = home;
    process.env.AI2NAO_CONFIG_DB = join(home, "config.db");
    writeFileSync(chatConfig, JSON.stringify({
      provider: "openai-compatible", baseURL: "http://127.0.0.1:11434/v1",
      model: "test-model", apiKey: "k",
    }));
    process.env.AI2NAO_LLM_CHAT_CONFIG = chatConfig;
    resetSettingsForTest();
    try {
      // 窗口 4000、预留 1000 → 预算 3000 token(6000 字符)。
      // 旧工具结果 2 万字符(1 万 token)→ 省略前必超;省略后只剩系统提示与短消息 → 不超。
      // 两边都要成立:省略后仍超的话会抛错,doStreamCalls 为空,就测不到省略本身。
      writeCachedCatalog({
        fetchedAt: new Date().toISOString(),
        providers: { "openai-compatible": ["test-model"] },
        pricing: {
          "openai-compatible": {
            "test-model": {
              base: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              tiers: [],
              limit: { context: 4000, output: 1000 },
            },
          },
        },
      });
      const app = new Hono();
      registerCopilotKitRoutes(app, {
        db,
        createModel: () => {
          const m = new MockLanguageModelV3({
            doStream: async () => ({
              stream: simulateReadableStream({
                chunks: [
                  { type: "stream-start", warnings: [] },
                  { type: "text-start", id: "0" },
                  { type: "text-delta", id: "0", delta: "答案" },
                  { type: "text-end", id: "0" },
                  { type: "finish", finishReason: { unified: "stop" },
                    usage: { inputTokens: { total: 9 }, outputTokens: { total: 2 } } },
                ] as never,
                initialDelayInMs: null, chunkDelayInMs: null,
              }),
            }),
          });
          models.push(m);
          return m;
        },
      });

      const bulky = "很长的旧结果".repeat(3400); // ≈ 2 万字符
      // 历史先在库里:客户端只能新增 user 消息,它回传的 assistant / tool 不算数(可信边界)。
      ensureLlmChatSession(db, "t-ladder");
      replaceLlmChatSessionMessages(db, "t-ladder", {
        messages: [
          { id: "u1", role: "user", content: "第一问" },
          { id: "a1", role: "assistant", content: "", toolCalls: [toolCall("c1", "旧")] },
          { id: "t1", role: "tool", toolCallId: "c1", content: bulky },
          { id: "u2", role: "user", content: "第二问" },
          { id: "u3", role: "user", content: "第三问" },
        ] as never,
      });
      const res = await app.request("/api/copilotkit/agent/default/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          threadId: "t-ladder", runId: "r-ladder",
          messages: [
            { id: "u1", role: "user", content: "第一问" },
            { id: "a1", role: "assistant", content: "", toolCalls: [toolCall("c1", "旧")] },
            { id: "t1", role: "tool", toolCallId: "c1", content: bulky },
            { id: "u2", role: "user", content: "第二问" },
            { id: "u3", role: "user", content: "第三问" },
            { id: "u4", role: "user", content: "第四问" },
          ],
          tools: [], context: [], state: {}, forwardedProps: {},
        }),
      });
      expect(res.status).toBe(200);
      const sse = await res.text();
      expect(sse).not.toContain("RUN_ERROR");

      const prompt = JSON.stringify(models[0]?.doStreamCalls[0]?.prompt ?? null);
      // 省略真的发生了,而且是发出去的那一份变了 —— 只在内部算过不算数。
      expect(prompt).toContain("这一步的工具结果较早");
      expect(prompt).not.toContain("很长的旧结果");
    } finally {
      db.close();
      resetSettingsForTest();
      delete process.env.AI2NAO_HOME;
      if (savedConfigDb === undefined) delete process.env.AI2NAO_CONFIG_DB;
      else process.env.AI2NAO_CONFIG_DB = savedConfigDb;
      if (savedChatConfig === undefined) delete process.env.AI2NAO_LLM_CHAT_CONFIG;
      else process.env.AI2NAO_LLM_CHAT_CONFIG = savedChatConfig;
      rmSync(home, { recursive: true, force: true });
    }
  });
});
