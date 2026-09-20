import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { registerCopilotKitRoutes } from "../src/llmChat/copilotRuntime.js";
import { getLlmChatSession } from "../src/llmChat/sessions.js";
import { openDatabase } from "../src/store/open.js";

/**
 * 思考行与「带工具调用的那一步」的配对(2026-09-19 真实 DeepSeek V4 实测照出来的)。
 *
 * 回传靠 `ai2naoReasoning.assistantMessageId` 把思考挂回它所属的 assistant 消息。配对断了,
 * 下一轮从库里重建历史时这段思考就发不出去 —— DeepSeek 带 tools 时历史 assistant 只拿到
 * 适配器补的空 `reasoning_content`。单测只覆盖过「思考 + 正文」的单步,工具步没人测过。
 */

function tempPath(name: string): string {
  return join(tmpdir(), `ai2nao-${Date.now()}-${Math.random().toString(36).slice(2)}-${name}`);
}

const finish = (unified: string) => ({
  type: "finish",
  finishReason: { unified },
  usage: { inputTokens: { total: 11, noCache: 11, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 5, text: 3, reasoning: 2 } },
});

const toolCall = [
  { type: "tool-input-start", id: "code-1", toolName: "ai2nao_run_code" },
  { type: "tool-input-delta", id: "code-1", delta: JSON.stringify({ language: "python", code: "print(42)" }) },
  { type: "tool-input-end", id: "code-1" },
  { type: "tool-call", toolCallId: "code-1", toolName: "ai2nao_run_code", input: JSON.stringify({ language: "python", code: "print(42)" }) },
];
const reasoning = (id: string, text: string) => [
  { type: "reasoning-start", id },
  { type: "reasoning-delta", id, delta: text },
  { type: "reasoning-end", id },
];
const text = (s: string) => [
  { type: "text-start", id: "t" },
  { type: "text-delta", id: "t", delta: s },
  { type: "text-end", id: "t" },
];

async function runTwoSteps(step0: unknown[]) {
  const dbPath = tempPath("reasoning-tool.db");
  const db = openDatabase(dbPath);
  const configPath = tempPath("chat.json");
  const prior = process.env.AI2NAO_LLM_CHAT_CONFIG;
  writeFileSync(configPath, JSON.stringify({ provider: "openai-compatible", baseURL: "http://127.0.0.1:11434/v1", model: "test-model", apiKey: "k" }));
  process.env.AI2NAO_LLM_CHAT_CONFIG = configPath;
  let nth = 0;
  try {
    const app = new Hono();
    registerCopilotKitRoutes(app, {
      db,
      codeRunner: {
        run: async () => ({
          ok: true, runtime: "pyodide" as const, language: "python" as const, timedOut: false,
          stdout: "42\n", stderr: "", files: [],
          limits: { timeoutMs: 10_000, stdoutTruncated: false, stderrTruncated: false },
        }),
      },
      createModel: () =>
        new MockLanguageModelV3({
          doStream: async () => {
            const idx = nth++;
            const chunks = idx === 0
              ? [{ type: "stream-start", warnings: [] }, ...step0, finish("tool-calls")]
              : [{ type: "stream-start", warnings: [] }, ...reasoning("r-2", "再想想。"), ...text("答案是 42。"), finish("stop")];
            return { stream: simulateReadableStream({ chunks: chunks as never, initialDelayInMs: null, chunkDelayInMs: null }) };
          },
        }),
    });
    const res = await app.request("/api/copilotkit/agent/default/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        threadId: "t-rt", runId: "r-rt",
        messages: [{ id: "u1", role: "user", content: "算一下" }],
        tools: [], context: [], state: {}, forwardedProps: { codeExecutionEnabled: true },
      }),
    });
    expect(await res.text()).not.toContain("RUN_ERROR");
    return getLlmChatSession(db, "t-rt")!.messages
      .filter((m) => !m.message_id.startsWith("ai2nao:"))
      .map((m) => JSON.parse(m.raw_json) as Record<string, any>);
  } finally {
    db.close();
    if (existsSync(dbPath)) unlinkSync(dbPath);
    if (existsSync(configPath)) unlinkSync(configPath);
    if (prior === undefined) delete process.env.AI2NAO_LLM_CHAT_CONFIG;
    else process.env.AI2NAO_LLM_CHAT_CONFIG = prior;
  }
}

function expectPaired(rows: Record<string, any>[]) {
  if (process.env.DUMP) console.log(JSON.stringify(rows.map((m) => ({ id: m.id, role: m.role, pair: m.ai2naoReasoning?.assistantMessageId, tc: m.toolCalls?.length, c: String(m.content ?? "").slice(0, 12) }))));
  const assistants = new Map(rows.filter((m) => m.role === "assistant").map((m) => [m.id, m]));
  const reasonings = rows.filter((m) => m.role === "reasoning");
  expect(reasonings).toHaveLength(2);
  for (const r of reasonings) {
    const target = r.ai2naoReasoning?.assistantMessageId;
    // 每条思考都必须配到一条**真实存在**的 assistant 消息。
    expect(target, `思考行 ${r.id} 没有配对`).toBeTypeOf("string");
    expect(assistants.has(target), `思考行 ${r.id} 配到了不存在的 ${target}`).toBe(true);
  }
  // 第 0 步的思考配到的正是带 toolCalls 的那条 —— DeepSeek 要的就是它的 reasoning_content。
  const step0 = reasonings.find((r) => /:answer:0$/.test(r.id))!;
  expect(assistants.get(step0.ai2naoReasoning.assistantMessageId)?.toolCalls?.length).toBe(1);
  // assistant 的 id 按步派生,与思考行同一套 stepKey。
  for (const id of assistants.keys()) expect(id).toMatch(/^a:[0-9a-f-]{36}:answer:\d+$/);
}

describe("思考 × 工具步的配对", () => {
  it("★ 第 0 步 = 思考 + 正文 + 工具调用", async () => {
    expectPaired(await runTwoSteps([...reasoning("r-1", "要调工具。"), ...text("我来算。"), ...toolCall]));
  });

  it("★ 第 0 步 = 思考 + 工具调用,一个字正文都没有", async () => {
    expectPaired(await runTwoSteps([...reasoning("r-1", "直接调工具。"), ...toolCall]));
  });
});
