/**
 * 模型工厂注入口:让**真实** `streamText` 跑起来,只把最底层的模型换成假的。
 *
 * 为什么必须单独一个文件:`llmChat.copilotRuntime.run.test.ts` 顶部有文件级的
 * `vi.mock("ai")`,把 `streamText` 整个换成了假函数。那种写法下,记账中间件
 * (`wrapStream`)和步骤闸门(`prepareStep`)**一次都不会执行** —— 因为假的
 * `streamText` 根本不会去调被 `wrapLanguageModel` 包装出来的模型。
 * 这里不 mock 任何东西,中间件与闸门才真正被走到。
 */
import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { registerCopilotKitRoutes } from "../src/llmChat/copilotRuntime.js";
import {
  listChatCalls,
  listChatRuns,
  ensureLlmChatSession,
  replaceLlmChatSessionMessages,
} from "../src/llmChat/sessions.js";
import { openDatabase } from "../src/store/open.js";

const previousConfigPath = process.env.AI2NAO_LLM_CHAT_CONFIG;

afterEach(() => {
  if (previousConfigPath === undefined) delete process.env.AI2NAO_LLM_CHAT_CONFIG;
  else process.env.AI2NAO_LLM_CHAT_CONFIG = previousConfigPath;
});

function tempPath(name: string): string {
  return join(tmpdir(), `ai2nao-${Date.now()}-${Math.random().toString(36).slice(2)}-${name}`);
}

function writeConfig(): string {
  const configPath = tempPath("llm-chat-config.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      provider: "openai-compatible",
      baseURL: "http://127.0.0.1:11434/v1",
      model: "test-model",
      apiKey: "test-key",
    })
  );
  process.env.AI2NAO_LLM_CHAT_CONFIG = configPath;
  return configPath;
}

/**
 * provider 层的 finish 片段。
 *
 * 两处形状容易写错,而且写错之后测试多半照样「通过」:
 * - `finishReason` 是**嵌套**的 `{ unified }`,不是裸字符串;
 * - `usage` 也是嵌套的(`inputTokens.total` 等),扁平化是 SDK 更上层才做的事,
 *   中间件截到的是这一层。
 */
function finishChunk(unified: string) {
  return {
    type: "finish",
    finishReason: { unified },
    usage: {
      inputTokens: { total: 11, noCache: 3, cacheRead: 8, cacheWrite: 0 },
      outputTokens: { total: 5, text: 3, reasoning: 2 },
    },
  };
}

function textStep(text: string) {
  return [
    { type: "stream-start", warnings: [] },
    { type: "text-start", id: "0" },
    { type: "text-delta", id: "0", delta: text },
    { type: "text-end", id: "0" },
    finishChunk("stop"),
  ];
}

describe("模型工厂注入口 —— 真实 streamText + 假模型", () => {
  /** 收集 createModel 造出的每个实例 —— `doStreamCalls` 是实例字段,拿不到实例就断言不了。 */
  function collectingModels(chunks: unknown[]): {
    models: MockLanguageModelV3[];
    createModel: () => MockLanguageModelV3;
  } {
    const models: MockLanguageModelV3[] = [];
    return {
      models,
      createModel: () => {
        const m = new MockLanguageModelV3({
          doStream: async () => ({
            stream: simulateReadableStream({
              chunks: chunks as never,
              initialDelayInMs: null,
              chunkDelayInMs: null,
            }),
          }),
        });
        models.push(m);
        return m;
      },
    };
  }

  it("输出预留同时到达 provider 与账目 —— 目录里没有这个模型时退回兜底 8192", async () => {
    const dbPath = tempPath("output-reserve.db");
    const db = openDatabase(dbPath);
    const configPath = writeConfig();
    const { models, createModel } = collectingModels(textStep("答案"));
    try {
      const app = new Hono();
      registerCopilotKitRoutes(app, { db, createModel });
      const res = await app.request("/api/copilotkit/agent/default/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          threadId: "thread-reserve",
          runId: "run-reserve",
          messages: [{ id: "u1", role: "user", content: "问题" }],
          tools: [],
          context: [],
          state: {},
          forwardedProps: {},
        }),
      });
      expect(res.status).toBe(200);
      await res.text();

      // **断言它真的到了 provider 那一层**,不是「我们在调用点设过」。
      // 设了却没传给 SDK、或两层字段名不同(本仓库有 text/delta 的先例),
      // 都会让这里恒为 undefined —— 而 `toBeDefined` 之外的断言照样绿。
      expect(models).toHaveLength(1);
      expect(models[0]!.doStreamCalls[0]?.maxOutputTokens).toBe(8192);

      // 账目里记的必须是**同一个数**。分别算两次就会出现「预算按 8K 扣、
      // 模型却获准吐 32K」这种不报错的超窗。
      expect(listChatCalls(db, "thread-reserve")[0]!.maxOutputTokens).toBe(8192);
    } finally {
      db.close();
      if (existsSync(dbPath)) unlinkSync(dbPath);
      if (existsSync(configPath)) unlinkSync(configPath);
    }
  });

  it("账目带发送视图指纹,count 等于真实发送条数 —— 这条专抓「sink 没接上」", async () => {
    const dbPath = tempPath("send-view.db");
    const db = openDatabase(dbPath);
    const configPath = writeConfig();
    const { createModel } = collectingModels(textStep("答案"));
    try {
      // 历史先在库里:客户端只能新增 user 消息,它回传的 a1 不算数(可信边界)。
      ensureLlmChatSession(db, "thread-sendview");
      replaceLlmChatSessionMessages(db, "thread-sendview", {
        messages: [
          { id: "u1", role: "user", content: "第一问" },
          { id: "a1", role: "assistant", content: "上一轮的回答" },
        ] as never,
      });
      const app = new Hono();
      registerCopilotKitRoutes(app, { db, createModel });
      const res = await app.request("/api/copilotkit/agent/default/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          threadId: "thread-sendview",
          runId: "run-sendview",
          messages: [
            { id: "u1", role: "user", content: "第一问" },
            { id: "a1", role: "assistant", content: "上一轮的回答" },
            { id: "u2", role: "user", content: "第二问" },
          ],
          tools: [],
          context: [],
          state: {},
          forwardedProps: {},
        }),
      });
      expect(res.status).toBe(200);
      await res.text();

      const call = listChatCalls(db, "thread-sendview")[0]!;
      // 出参没接上时 `viewEntries` 是空数组、count 恒为 0,而其余断言全绿 ——
      // 「可选参数没人传」正是本仓库在 onCallCompleted 上踩过的坑。
      expect(call.sendView?.count).toBe(3);
      // 四个哈希都该是 12 位十六进制(仓库既有写法)。
      expect(call.sendView?.prefixHash).toMatch(/^[0-9a-f]{12}$/);
      expect(call.sendView?.systemHash).toMatch(/^[0-9a-f]{12}$/);
      expect(call.sendView?.toolsHash).toMatch(/^[0-9a-f]{12}$/);
    } finally {
      db.close();
      if (existsSync(dbPath)) unlinkSync(dbPath);
      if (existsSync(configPath)) unlinkSync(configPath);
    }
  });

  it("发送内容变了,prefixHash 就变 —— 防「哈希写成常量」那种恒绿实现", async () => {
    const dbPath = tempPath("send-view-differs.db");
    const db = openDatabase(dbPath);
    const configPath = writeConfig();
    const { createModel } = collectingModels(textStep("答案"));
    const hashes: string[] = [];
    try {
      const app = new Hono();
      registerCopilotKitRoutes(app, { db, createModel });
      for (const [i, msgs] of [
        [{ id: "u1", role: "user", content: "只有一条" }],
        [
          { id: "u1", role: "user", content: "只有一条" },
          { id: "a1", role: "assistant", content: "回答" },
          { id: "u2", role: "user", content: "追问" },
        ],
      ].entries()) {
        const res = await app.request("/api/copilotkit/agent/default/run", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            threadId: `thread-differs-${i}`,
            runId: `run-differs-${i}`,
            messages: msgs,
            tools: [],
            context: [],
            state: {},
            forwardedProps: {},
          }),
        });
        expect(res.status).toBe(200);
        await res.text();
        hashes.push(listChatCalls(db, `thread-differs-${i}`)[0]!.sendView!.prefixHash);
      }
      expect(hashes[0]).not.toBe(hashes[1]);
    } finally {
      db.close();
      if (existsSync(dbPath)) unlinkSync(dbPath);
      if (existsSync(configPath)) unlinkSync(configPath);
    }
  });

  it("开了工具之后 toolsHash 与 systemHash 都变 —— 防它们被写成与请求无关的常量", async () => {
    const dbPath = tempPath("tools-hash.db");
    const db = openDatabase(dbPath);
    const configPath = writeConfig();
    const { createModel } = collectingModels(textStep("答案"));
    /** [无工具, 开了代码执行] 两轮各自的 (toolsHash, systemHash)。 */
    const seen: Array<{ tools: string; system: string }> = [];
    try {
      const app = new Hono();
      registerCopilotKitRoutes(app, { db, createModel });
      // `createRunCodeTool` 显式接受 `undefined` 的 codeRunner,所以这条用例
      // **不需要造假的执行器** —— 工具只要被注册进 ToolSet 就够了,不必真跑。
      for (const [i, forwardedProps] of [{}, { codeExecutionEnabled: true }].entries()) {
        const res = await app.request("/api/copilotkit/agent/default/run", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            threadId: `thread-tools-${i}`,
            runId: `run-tools-${i}`,
            messages: [{ id: "u1", role: "user", content: "问题" }],
            tools: [],
            context: [],
            state: {},
            forwardedProps,
          }),
        });
        expect(res.status).toBe(200);
        await res.text();
        const v = listChatCalls(db, `thread-tools-${i}`)[0]!.sendView!;
        seen.push({ tools: v.toolsHash, system: v.systemHash });
      }

      // toolsHash 取的是**排序后的工具名**:开一个工具就该变。
      // 写成常量、或错把带函数的 ToolSet 整体 JSON.stringify(函数被静默丢掉,
      // 结果恒等于空对象的哈希)——两种写法都会让这条红。
      expect(seen[0]!.tools).not.toBe(seen[1]!.tools);
      // 系统提示会因工具开关而多出几行,所以 systemHash 同样该变。
      // 这两个哈希是**分别**算的,一起断言才能发现「两处指向了同一个来源」。
      expect(seen[0]!.system).not.toBe(seen[1]!.system);
    } finally {
      db.close();
      if (existsSync(dbPath)) unlinkSync(dbPath);
      if (existsSync(configPath)) unlinkSync(configPath);
    }
  });

  it("补答那笔账的 toolsHash 与主回答不同 —— 补答根本不带工具", async () => {
    const dbPath = tempPath("finalize-send-view.db");
    const db = openDatabase(dbPath);
    const configPath = writeConfig();
    let nth = 0;
    try {
      const app = new Hono();
      registerCopilotKitRoutes(app, {
        db,
        // 假执行器:接口只有一个 `run()`。真跑 pyodide 会让这条又慢又依赖环境,
        // 而这里要验的是记账,不是代码执行。
        codeRunner: {
          run: async () => ({
            ok: true,
            runtime: "pyodide" as const,
            language: "python" as const,
            timedOut: false,
            stdout: "42\n",
            stderr: "",
            files: [],
            limits: { timeoutMs: 10_000, stdoutTruncated: false, stderrTruncated: false },
          }),
        },
        createModel: () =>
          new MockLanguageModelV3({
            doStream: async () => {
              const idx = nth;
              nth += 1;
              // **`tool-input-*` 之后必须再发一片 `tool-call`。** 只发前三片的话,
              // 工具调用会浮现(TOOL_CALL_START 有了)但**永远不会执行**,于是没有
              // tool 消息、needsFinalAnswer() 恒假、补答不会发生 —— 实测
              // toolResultEvents 为 0 就是这么来的。`input` 是 **JSON 字符串**,
              // 不是对象(照本文件那条已跑通的两步用例)。
              //
              // 第 0 次只发工具调用、**一个字文本都不发**;其后每次空收尾。
              // 只要出现 assistant 文本,latestAssistantTextIndex 就会超过
              // 工具结果的位置,needsFinalAnswer() 反而不成立,补答不会发生。
              const chunks =
                idx === 0
                  ? [
                      { type: "stream-start", warnings: [] },
                      { type: "tool-input-start", id: "code-1", toolName: "ai2nao_run_code" },
                      {
                        type: "tool-input-delta",
                        id: "code-1",
                        delta: JSON.stringify({ language: "python", code: "print(42)" }),
                      },
                      { type: "tool-input-end", id: "code-1" },
                      {
                        type: "tool-call",
                        toolCallId: "code-1",
                        toolName: "ai2nao_run_code",
                        input: JSON.stringify({ language: "python", code: "print(42)" }),
                      },
                      // 只有 tool-calls 才会让 SDK 继续下一步。
                      finishChunk("tool-calls"),
                    ]
                  : [{ type: "stream-start", warnings: [] }, finishChunk("stop")];
              return {
                stream: simulateReadableStream({
                  chunks: chunks as never,
                  initialDelayInMs: null,
                  chunkDelayInMs: null,
                }),
              };
            },
          }),
      });

      const res = await app.request("/api/copilotkit/agent/default/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          threadId: "thread-finalize",
          runId: "run-finalize",
          messages: [{ id: "u1", role: "user", content: "算一下 42" }],
          tools: [],
          context: [],
          state: {},
          forwardedProps: { codeExecutionEnabled: true },
        }),
      });
      expect(res.status).toBe(200);
      const sse = await res.text();
      // HTTP 200 不代表这一轮成功 —— 出错时流里会有 RUN_ERROR 而状态码照样 200。
      expect(sse).not.toContain("RUN_ERROR");

      const calls = listChatCalls(db, "thread-finalize");
      // **断言整份账目的形状,而不是两条 toBeDefined。** 失败时 vitest 会把实际
      // 数组打出来,一眼看清是「一条都没落」还是「补答没触发」——
      // toBeDefined 只会说 undefined,分不出这两种。
      // 不断言 doStream 次数:它与 `ledger.length` 一一对应(一次模型调用一笔账),
      // 却额外耦合 SDK 的步数记账方式 —— 将来 SDK 一变,它会因为与本用例无关的
      // 理由变红。工具是否真执行由 toolResultEvents 钉,是否走了第二步由 ledger 钉。
      expect({
        toolCallEvents: (sse.match(/TOOL_CALL_START/g) ?? []).length,
        toolResultEvents: (sse.match(/TOOL_CALL_RESULT/g) ?? []).length,
        ledger: calls.map((c) => `${c.purpose}/${c.status}`),
      }).toEqual({
        toolCallEvents: 1,
        toolResultEvents: 1,
        ledger: ["answer/completed", "answer/completed", "finalize/completed"],
      });
      const answer = calls.find((c) => c.purpose === "answer");
      const finalize = calls.find((c) => c.purpose === "finalize");
      expect(answer?.sendView).toBeDefined();
      expect(finalize?.sendView).toBeDefined();

      // 主回答带着 ai2nao_run_code,补答那次 `streamText` 根本不传 `tools`。
      // 若有人把 `serverTools` 抄进补答的 sendViewOf,这两个哈希就会相等。
      expect(finalize!.sendView!.toolsHash).not.toBe(answer!.sendView!.toolsHash);
      // 补答把整轮揉成一条新合成的 user 消息,所以是退化的 1 条。
      expect(finalize!.sendView!.count).toBe(1);
      // 输出预留对两笔是同一个数 —— 补答也是真请求,同样受预留约束。
      expect(finalize!.maxOutputTokens).toBe(answer!.maxOutputTokens);
    } finally {
      db.close();
      if (existsSync(dbPath)) unlinkSync(dbPath);
      if (existsSync(configPath)) unlinkSync(configPath);
    }
  });

  it("记账中间件真的跑了:落一笔 completed 账,用量取自 provider 层的嵌套形状", async () => {
    const dbPath = tempPath("model-factory-accounting.db");
    const db = openDatabase(dbPath);
    const configPath = writeConfig();

    try {
      const app = new Hono();
      registerCopilotKitRoutes(app, {
        db,
        createModel: () =>
          new MockLanguageModelV3({
            doStream: async () => ({
              stream: simulateReadableStream({
                chunks: textStep("真实 streamText 跑出来的答案"),
                initialDelayInMs: null,
                chunkDelayInMs: null,
              }),
            }),
          }),
      });

      const res = await app.request("/api/copilotkit/agent/default/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          threadId: "thread-accounting",
          runId: "run-accounting",
          messages: [{ id: "u1", role: "user", content: "问题" }],
          tools: [],
          context: [],
          state: {},
          forwardedProps: {},
        }),
      });

      expect(res.status).toBe(200);
      const sse = await res.text();
      expect(sse).toContain("真实 streamText 跑出来的答案");

      // 非空转的关键:中间件没跑的话,这里是空数组。
      const calls = listChatCalls(db, "thread-accounting");
      expect(calls).toHaveLength(1);
      const call = calls[0]!;
      expect(call.purpose).toBe("answer");
      expect(call.status).toBe("completed");
      expect(call.stepIndex).toBe(0);
      expect(call.attempt).toBe(0);

      // 这几个数字直接证明 usageFromProviderChunk 读的是嵌套形状而不是扁平形状。
      expect(call.usage).toMatchObject({
        input: 11,
        noCache: 3,
        cacheRead: 8,
        cacheWrite: 0,
        output: 5,
        reasoning: 2,
      });

      // 占位行也该正常收尾 —— 与账目是两类行,不该互相干扰。
      expect(listChatRuns(db, "thread-accounting")[0]?.status).toBe("completed");
    } finally {
      db.close();
      if (existsSync(dbPath)) unlinkSync(dbPath);
      if (existsSync(configPath)) unlinkSync(configPath);
    }
  });

  it("下一笔请求要等上一步落库:第二次 doStream 发生时,第一步已经在库里", async () => {
    const dbPath = tempPath("model-factory-step-gate.db");
    const db = openDatabase(dbPath);
    const configPath = writeConfig();

    /**
     * 每次 `doStream` 被调用的**那一刻**探一次库。
     *
     * 这是分歧 3 的直接证据:SDK 的步骤循环不等我们消费 `fullStream`,
     * 所以「下一笔请求发出时,上一步是否已落库」只能在请求发出的瞬间观察。
     * 单步的 mock 根本分辨不出「每步落库」和「整轮收尾落库」。
     */
    const probes: string[][] = [];
    const rolesInDb = () =>
      db
        .prepare(
          `SELECT role FROM llm_chat_messages
           WHERE session_id = ? AND message_id NOT LIKE 'ai2nao:%'
           ORDER BY message_index ASC`
        )
        .all("thread-step-gate")
        .map((r) => (r as { role: string }).role);

    // 第一步:发起一次工具调用后收尾。**input 必须是字符串** ——
    // provider 层的 tool-call 用的是 LanguageModelV3ToolCall,注释写明是
    // stringified JSON;写成对象的话工具参数解析不出来,SDK 不会开第二步,
    // 闸门就零覆盖,而测试照样会绿。
    const stepOne = [
      { type: "stream-start", warnings: [] },
      { type: "tool-input-start", id: "call-1", toolName: "ai2nao_web_search" },
      { type: "tool-input-delta", id: "call-1", delta: '{"query":"闸门"}' },
      { type: "tool-input-end", id: "call-1" },
      {
        type: "tool-call",
        toolCallId: "call-1",
        toolName: "ai2nao_web_search",
        input: JSON.stringify({ query: "闸门", reason: "验证步骤闸门" }),
      },
      // 只有 tool-calls 才会让 SDK 继续下一步;finishReason 是嵌套的 { unified }。
      finishChunk("tool-calls"),
    ];
    const stepTwo = textStep("第二步的最终回答");

    try {
      const app = new Hono();
      registerCopilotKitRoutes(app, {
        db,
        webSearch: {
          search: async () => ({
            ok: true as const,
            kind: "evidence" as const,
            source: "web" as const,
            query: "闸门",
            generatedAt: "2026-09-16T00:00:00.000Z",
            evidence: [],
            meta: { provider: "stub" },
          }),
        },
        createModel: () =>
          new MockLanguageModelV3({
            doStream: async () => {
              probes.push(rolesInDb());
              const chunks = probes.length === 1 ? stepOne : stepTwo;
              return {
                stream: simulateReadableStream({
                  chunks,
                  initialDelayInMs: null,
                  chunkDelayInMs: null,
                }),
              };
            },
          }),
      });

      const res = await app.request("/api/copilotkit/agent/default/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          threadId: "thread-step-gate",
          runId: "run-step-gate",
          messages: [{ id: "u1", role: "user", content: "查一下" }],
          tools: [],
          context: [],
          state: {},
          forwardedProps: { webSearchEnabled: true },
        }),
      });

      expect(res.status).toBe(200);
      await res.text();

      // SDK 确实走了两步 —— 否则闸门那段代码一次都不会执行。
      expect(probes).toHaveLength(2);
      // 第一笔请求发出时,库里只有刚落的用户消息。
      expect(probes[0]).toEqual(["user"]);
      // 第二笔请求发出时,第一步产出的 assistant 已经在库里了。
      expect(probes[1]).toContain("assistant");

      // 两步各记一笔账,步号递增。
      const calls = listChatCalls(db, "thread-step-gate").filter((c) => c.purpose === "answer");
      expect(calls.map((c) => c.stepIndex)).toEqual([0, 1]);
    } finally {
      db.close();
      if (existsSync(dbPath)) unlinkSync(dbPath);
      if (existsSync(configPath)) unlinkSync(configPath);
    }
  });

  it("思考行真的落进库里 —— 从 provider 分片一路到 llm_chat_messages", async () => {
    const dbPath = tempPath("model-factory-reasoning.db");
    const db = openDatabase(dbPath);
    const configPath = writeConfig();

    try {
      const app = new Hono();
      registerCopilotKitRoutes(app, {
        db,
        createModel: () =>
          new MockLanguageModelV3({
            doStream: async () => ({
              stream: simulateReadableStream({
                chunks: [
                  { type: "stream-start", warnings: [] },
                  // provider 层思考分片用的是 `delta`,不是正文那边的 `text`。
                  { type: "reasoning-start", id: "r-1" },
                  { type: "reasoning-delta", id: "r-1", delta: "先拆一下题目。" },
                  { type: "reasoning-end", id: "r-1" },
                  { type: "text-start", id: "0" },
                  { type: "text-delta", id: "0", delta: "这是答案。" },
                  { type: "text-end", id: "0" },
                  finishChunk("stop"),
                ],
                initialDelayInMs: null,
                chunkDelayInMs: null,
              }),
            }),
          }),
      });

      const res = await app.request("/api/copilotkit/agent/default/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          threadId: "thread-reasoning",
          runId: "run-reasoning",
          messages: [{ id: "u1", role: "user", content: "问题" }],
          tools: [],
          context: [],
          state: {},
          forwardedProps: {},
        }),
      });
      expect(res.status).toBe(200);
      const sse = await res.text();

      // **先分清断点在哪一段。** 事件是 yield 给客户端的:响应体里有思考事件,
      // 说明生成器这一段没问题,问题在 apply → messages() → 落库;没有的话,
      // 问题在「SDK 有没有把 provider 的思考分片送进 fullStream」那一段。
      // 这条断言本身也值得长期留着 —— 前端的思考块就靠它。
      expect(sse).toContain("REASONING");
      expect(sse).toContain("先拆一下题目。");

      const rows = db
        .prepare(
          `SELECT message_id, role, plain_text, preview FROM llm_chat_messages
           WHERE session_id = ? AND role = 'reasoning'`
        )
        .all("thread-reasoning") as Array<{
        message_id: string;
        role: string;
        plain_text: string;
        preview: string;
      }>;

      // 非空转的关键:链路上任何一环断掉(事件没发、apply 不认、messages() 过滤掉、
      // AG_UI_ROLES 不放行),这里都是空数组。
      expect(rows).toHaveLength(1);
      expect(rows[0]?.plain_text).toBe("先拆一下题目。");
      // id 按 stepKey = `${runId}:${purpose}:${stepIndex}` 派生。
      // **这里的 runId 是服务端生成的,不是请求里那个 `run-reasoning`** ——
      // 设计明确「客户端 runId 只用于 AG-UI 事件关联,不参与任何行 id」。
      // 两条断言分工:前者钉住形状,后者钉住「没拿客户端的值去拼」。
      expect(rows[0]?.message_id).toMatch(/^r:[0-9a-f-]{36}:answer:0$/);
      expect(rows[0]?.message_id).not.toContain("run-reasoning");
      // 预览不能把思考正文摊在会话列表上。
      expect(rows[0]?.preview).toBe("[reasoning]");

      // 正文行照旧,而且没被思考挤掉。
      const assistant = db
        .prepare(
          `SELECT plain_text FROM llm_chat_messages
           WHERE session_id = ? AND role = 'assistant'`
        )
        .all("thread-reasoning") as Array<{ plain_text: string }>;
      expect(assistant.map((r) => r.plain_text)).toEqual(["这是答案。"]);

      // 思考行不该被算进「可见条数」,也不该当上标题。
      const session = db
        .prepare("SELECT title, message_count FROM llm_chat_sessions WHERE id = ?")
        .get("thread-reasoning") as { title: string; message_count: number };
      expect(session.title).toBe("问题");
      expect(session.message_count).toBe(2);
    } finally {
      db.close();
      if (existsSync(dbPath)) unlinkSync(dbPath);
      if (existsSync(configPath)) unlinkSync(configPath);
    }
  });

  it("思考行带完整的 ai2naoReasoning —— 尤其是 callId 不能是 null", async () => {
    const dbPath = tempPath("model-factory-reasoning-meta.db");
    const db = openDatabase(dbPath);
    const configPath = writeConfig();

    try {
      const app = new Hono();
      registerCopilotKitRoutes(app, {
        db,
        createModel: () =>
          new MockLanguageModelV3({
            doStream: async () => ({
              stream: simulateReadableStream({
                chunks: [
                  { type: "stream-start", warnings: [] },
                  { type: "reasoning-start", id: "r-1" },
                  { type: "reasoning-delta", id: "r-1", delta: "想一想。" },
                  { type: "reasoning-end", id: "r-1" },
                  { type: "text-start", id: "0" },
                  { type: "text-delta", id: "0", delta: "答案。" },
                  { type: "text-end", id: "0" },
                  finishChunk("stop"),
                ],
                initialDelayInMs: null,
                chunkDelayInMs: null,
              }),
            }),
          }),
      });

      const res = await app.request("/api/copilotkit/agent/default/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          threadId: "thread-meta",
          runId: "run-meta",
          messages: [{ id: "u1", role: "user", content: "问题" }],
          tools: [],
          context: [],
          state: {},
          forwardedProps: {},
        }),
      });
      expect(res.status).toBe(200);
      await res.text();

      const row = db
        .prepare(
          `SELECT raw_json FROM llm_chat_messages
           WHERE session_id = ? AND role = 'reasoning'`
        )
        .get("thread-meta") as { raw_json: string } | undefined;
      expect(row).toBeTruthy();

      const meta = (JSON.parse(row!.raw_json) as { ai2naoReasoning?: Record<string, unknown> })
        .ai2naoReasoning;
      expect(meta).toBeTruthy();

      expect(meta!.v).toBe(1);
      // runId 是服务端生成的,不是请求里那个 `run-meta`。
      expect(typeof meta!.runId).toBe("string");
      expect(meta!.runId).not.toBe("run-meta");
      expect(meta!.assistantMessageId).toMatch(/^a:[0-9a-f-]{36}:answer:0$/);
      expect(meta!.provider).toBe("openai-compatible");
      // 走的是 provider 的 reasoning-delta,不是正文里的 <think>。
      expect(meta!.source).toBe("reasoning-stream");
      expect(typeof meta!.durationMs).toBe("number");
      expect(meta!.durationMs as number).toBeGreaterThanOrEqual(0);

      // **本条最要紧。** callId 由记账中间件在 settle(completed) 时回报,
      // 而两个 ctx 构造点都要显式传 `onCallCompleted` 才收得到。漏传时
      // tsc 不报(可选字段)、其它断言也全绿(null 不影响),只有这里会红。
      expect(meta!.callId).not.toBeNull();
      expect(meta!.callId).toMatch(/^c:[0-9a-f-]{36}:answer:0:0$/);
      // 账本里确实有这一笔,不是编出来的号。
      expect(listChatCalls(db, "thread-meta").map((c) => c.callId)).toContain(meta!.callId);
    } finally {
      db.close();
      if (existsSync(dbPath)) unlinkSync(dbPath);
      if (existsSync(configPath)) unlinkSync(configPath);
    }
  });

  it("协议原文盖在 assistant 行上：含 <think> 的厂商原样，与展示文本分开存", async () => {
    const dbPath = tempPath("model-factory-protocol.db");
    const db = openDatabase(dbPath);
    const configPath = writeConfig();

    // MiniMax 的形状:思考写在正文里。回传时官方要求 content 原样,
    // 所以库里必须留一份没被剥过的。
    const RAW = "<think>\n先拆题\n</think>\n\n答案在这";

    try {
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
                  // 分两片喂,顺带证明累积是按片拼的,不是只留最后一片。
                  { type: "text-delta", id: "0", delta: "<think>\n先拆题\n</think>" },
                  { type: "text-delta", id: "0", delta: "\n\n答案在这" },
                  { type: "text-end", id: "0" },
                  finishChunk("stop"),
                ],
                initialDelayInMs: null,
                chunkDelayInMs: null,
              }),
            }),
          }),
      });

      const res = await app.request("/api/copilotkit/agent/default/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          threadId: "thread-protocol",
          runId: "run-protocol",
          messages: [{ id: "u1", role: "user", content: "问题" }],
          tools: [],
          context: [],
          state: {},
          forwardedProps: {},
        }),
      });
      expect(res.status).toBe(200);
      await res.text();

      const row = db
        .prepare(
          `SELECT raw_json, plain_text FROM llm_chat_messages
           WHERE session_id = ? AND role = 'assistant'`
        )
        .get("thread-protocol") as { raw_json: string; plain_text: string } | undefined;
      expect(row).toBeTruthy();

      // 展示文本是剥过的 —— 气泡里不该出现 <think>。
      expect(row!.plain_text).toBe("答案在这");

      const parsed = JSON.parse(row!.raw_json) as {
        ai2naoProtocol?: { v?: number; content?: string };
      };
      // 非空转之一:字段活着走完了 normalizeAgUiMessage → raw_json → 读回。
      expect(parsed.ai2naoProtocol?.v).toBe(1);
      // 非空转之二:逐字节等于厂商原样,含 <think> 与原始空白。
      expect(parsed.ai2naoProtocol?.content).toBe(RAW);
      // 非空转之三:**最要紧的一条**。若有人图省事把协议原文写成展示文本,
      // 上面两条仍会绿,只有这条会红。
      expect(parsed.ai2naoProtocol?.content).not.toBe(row!.plain_text);
    } finally {
      db.close();
      if (existsSync(dbPath)) unlinkSync(dbPath);
      if (existsSync(configPath)) unlinkSync(configPath);
    }
  });
});
