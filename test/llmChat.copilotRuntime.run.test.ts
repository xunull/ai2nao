import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/serve/app.js";
import { registerCopilotKitRoutes } from "../src/llmChat/copilotRuntime.js";
import { getLlmChatSession } from "../src/llmChat/sessions.js";
import { openDatabase } from "../src/store/open.js";

const { streamTextMock } = vi.hoisted(() => ({
  streamTextMock: vi.fn(),
}));

vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>();
  return {
    ...actual,
    streamText: streamTextMock,
  };
});

const previousConfigPath = process.env.AI2NAO_LLM_CHAT_CONFIG;

afterEach(() => {
  streamTextMock.mockReset();
  if (previousConfigPath === undefined) {
    delete process.env.AI2NAO_LLM_CHAT_CONFIG;
  } else {
    process.env.AI2NAO_LLM_CHAT_CONFIG = previousConfigPath;
  }
});

describe("CopilotKit-compatible LLM chat runtime", () => {
  it("serves direct CopilotKit multi-route runs as encoded SSE from the ai2nao runner", async () => {
    const dbPath = tempPath("copilot-runtime-direct-run.db");
    const db = openDatabase(dbPath);
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

    streamTextMock.mockReturnValueOnce({
      fullStream: asyncParts([
        { type: "text-start", id: "direct-text" },
        { type: "text-delta", id: "direct-text", text: "direct runtime answer" },
        { type: "text-end", id: "direct-text" },
        { type: "finish" },
      ]),
    });

    try {
      const app = new Hono();
      registerCopilotKitRoutes(app, { db });
      const res = await app.request("/api/copilotkit/agent/default/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          threadId: "thread-direct-run",
          runId: "run-direct-run",
          messages: [{ id: "u1", role: "user", content: "direct route please" }],
          tools: [],
          context: [],
          state: {},
          forwardedProps: {},
        }),
      });

      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/event-stream");
      const sse = await res.text();
      expect(sse).toContain("RUN_STARTED");
      expect(sse).toContain("direct runtime answer");
      expect(sse).toContain("RUN_FINISHED");
      expect(streamTextMock).toHaveBeenCalledTimes(1);

      const session = getLlmChatSession(db, "thread-direct-run");
      expect(JSON.stringify(session?.messages)).toContain("direct runtime answer");
    } finally {
      db.close();
      if (existsSync(dbPath)) unlinkSync(dbPath);
      if (existsSync(configPath)) unlinkSync(configPath);
    }
  });

  it("registers session memory only when forwarded props enable it", async () => {
    const dbPath = tempPath("copilot-runtime-session-memory.db");
    const db = openDatabase(dbPath);
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

    streamTextMock.mockReturnValueOnce({
      fullStream: asyncParts([{ type: "finish" }]),
    });

    try {
      const app = new Hono();
      registerCopilotKitRoutes(app, { db });
      const res = await app.request("/api/copilotkit/agent/default/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          threadId: "thread-session-memory",
          runId: "run-session-memory",
          messages: [{ id: "u1", role: "user", content: "之前我们怎么设计 memory？" }],
          tools: [],
          context: [],
          state: {},
          forwardedProps: { sessionMemoryEnabled: true },
        }),
      });

      expect(res.status).toBe(200);
      await res.text();
      const tools = streamTextMock.mock.calls[0]?.[0]?.tools ?? {};
      expect(Object.keys(tools)).toContain("ai2nao_search_session_memory");
      expect(Object.keys(tools)).not.toContain("ai2nao_web_search");
    } finally {
      db.close();
      if (existsSync(dbPath)) unlinkSync(dbPath);
      if (existsSync(configPath)) unlinkSync(configPath);
    }
  });

  it("registers run code only when forwarded props enable it", async () => {
    const dbPath = tempPath("copilot-runtime-run-code.db");
    const db = openDatabase(dbPath);
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

    streamTextMock.mockReturnValueOnce({
      fullStream: asyncParts([{ type: "finish" }]),
    });

    try {
      const app = new Hono();
      registerCopilotKitRoutes(app, {
        db,
        codeRunner: {
          run: async () => ({
            ok: true,
            runtime: "docker",
            language: "python",
            timedOut: false,
            stdout: "2",
            stderr: "",
            files: [],
            limits: { timeoutMs: 10_000, stdoutTruncated: false, stderrTruncated: false },
          }),
        },
      });
      const res = await app.request("/api/copilotkit/agent/default/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          threadId: "thread-run-code",
          runId: "run-run-code",
          messages: [{ id: "u1", role: "user", content: "算一下 1+1" }],
          tools: [],
          context: [],
          state: {},
          forwardedProps: { codeExecutionEnabled: true, codeExecutionRuntime: "docker" },
        }),
      });

      expect(res.status).toBe(200);
      await res.text();
      const tools = streamTextMock.mock.calls[0]?.[0]?.tools ?? {};
      expect(Object.keys(tools)).toContain("ai2nao_run_code");
      expect(Object.keys(tools)).not.toContain("ai2nao_search_session_memory");
      expect(Object.keys(tools)).not.toContain("ai2nao_web_search");
    } finally {
      db.close();
      if (existsSync(dbPath)) unlinkSync(dbPath);
      if (existsSync(configPath)) unlinkSync(configPath);
    }
  });

  it("synthesizes a final answer immediately when a web search run ends after the tool result", async () => {
    const dbPath = tempPath("copilot-runtime-final-answer.db");
    const db = openDatabase(dbPath);
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

    streamTextMock
      .mockReturnValueOnce({
        fullStream: asyncParts([
          { type: "tool-input-start", id: "web-1", toolName: "ai2nao_web_search" },
          { type: "tool-input-delta", id: "web-1", delta: '{"query":"Alibaba stock close"}' },
          {
            type: "tool-call",
            toolCallId: "web-1",
            toolName: "ai2nao_web_search",
            input: { query: "Alibaba stock close" },
          },
          {
            type: "tool-result",
            toolCallId: "web-1",
            toolName: "ai2nao_web_search",
            output: {
              ok: true,
              kind: "evidence",
              source: "web",
              evidence: [
                {
                  title: "Alibaba Group Holding Limited (BABA)",
                  url: "https://example.com/baba",
                  snippet: "BABA closed at 126.80.",
                },
              ],
            },
          },
          { type: "finish" },
        ]),
      })
      .mockReturnValueOnce({
        fullStream: asyncParts([
          { type: "text-start", id: "final-text" },
          {
            type: "text-delta",
            id: "final-text",
            text: "搜索结果显示 Alibaba Group Holding Limited (BABA) 的相关信息，来源：https://example.com/baba。",
          },
          { type: "text-end", id: "final-text" },
          { type: "finish" },
        ]),
      });

    try {
      const app = createApp({ db });
      const res = await app.request("/api/copilotkit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          method: "agent/run",
          params: { agentId: "default" },
          body: {
            threadId: "thread-web-final",
            runId: "run-web-final",
            messages: [{ id: "u1", role: "user", content: "昨天阿里巴巴的股票是多少" }],
            tools: [],
            context: [],
            forwardedProps: { webSearchEnabled: true },
          },
        }),
      });

      expect(res.status).toBe(200);
      const sse = await res.text();
      expect(streamTextMock).toHaveBeenCalledTimes(2);
      expect(streamTextMock.mock.calls[0][0].tools).toHaveProperty("ai2nao_web_search");
      expect(streamTextMock.mock.calls[1][0].tools).toBeUndefined();
      const finalMessagesText = JSON.stringify(streamTextMock.mock.calls[1][0].messages);
      expect(finalMessagesText).toContain("https://example.com/baba");
      expect(finalMessagesText).not.toContain('"role":"tool"');
      expect(finalMessagesText).not.toContain('"type":"tool-call"');
      expect(sse).toContain("Alibaba Group Holding Limited");
      expect(sse).toContain("https://example.com/baba");

      const session = getLlmChatSession(db, "thread-web-final");
      expect(JSON.stringify(session?.messages)).toContain("https://example.com/baba");
    } finally {
      db.close();
      if (existsSync(dbPath)) unlinkSync(dbPath);
      if (existsSync(configPath)) unlinkSync(configPath);
    }
  });

  it("executes DeepSeek DSML text web-search calls without leaking the markup to the client", async () => {
    const dbPath = tempPath("copilot-runtime-dsml-web-search.db");
    const db = openDatabase(dbPath);
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

    const search = vi.fn(async () => ({
      ok: true,
      kind: "evidence",
      source: "web",
      query: "美团 3690 5月15日 2026 收盘价",
      generatedAt: "2026-05-17T00:00:00.000Z",
      evidence: [
        {
          title: "Meituan 3690.HK",
          url: "https://example.com/meituan",
          snippet: "Meituan close price result",
        },
      ],
      meta: { provider: "test" },
    }));

    streamTextMock
      .mockReturnValueOnce({
        fullStream: asyncParts([
          { type: "text-start", id: "dsml-text" },
          {
            type: "text-delta",
            id: "dsml-text",
            text: [
              "<｜｜DSML｜｜tool_calls>",
              "<｜｜DSML｜｜invoke name=\"ai2nao_web_search\">",
              "<｜｜DSML｜｜parameter name=\"count\" string=\"false\">5</｜｜DSML｜｜parameter>",
              "<｜｜DSML｜｜parameter name=\"query\" string=\"true\">美团 3690 5月15日 2026 收盘价</｜｜DSML｜｜parameter>",
              "<｜｜DSML｜｜parameter name=\"reason\" string=\"true\">最近一个交易日</｜｜DSML｜｜parameter>",
              "</｜｜DSML｜｜invoke>",
              "</｜｜DSML｜｜tool_calls>",
            ].join(" "),
          },
          { type: "finish" },
        ]),
      })
      .mockReturnValueOnce({
        fullStream: asyncParts([
          { type: "text-start", id: "final-text" },
          {
            type: "text-delta",
            id: "final-text",
            text: [
              "<｜｜DSML｜｜tool_calls>",
              "<｜｜DSML｜｜invoke name=\"ai2nao_web_search\">",
              "<｜｜DSML｜｜parameter name=\"query\" string=\"true\">美团 3690 再查一次</｜｜DSML｜｜parameter>",
              "</｜｜DSML｜｜invoke>",
              "</｜｜DSML｜｜tool_calls>",
            ].join(" "),
          },
          { type: "text-end", id: "final-text" },
          { type: "finish" },
        ]),
      });

    try {
      const app = new Hono();
      registerCopilotKitRoutes(app, { db, webSearch: { search } });
      const res = await app.request("/api/copilotkit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          method: "agent/run",
          params: { agentId: "default" },
          body: {
            threadId: "thread-dsml-web-search",
            runId: "run-dsml-web-search",
            messages: [{ id: "u1", role: "user", content: "美团 5月15日收盘价是多少" }],
            tools: [],
            context: [],
            forwardedProps: { webSearchEnabled: true },
          },
        }),
      });

      expect(res.status).toBe(200);
      const sse = await res.text();
      expect(sse).not.toContain("DSML");
      expect(sse).toContain("TOOL_CALL_RESULT");
      expect(sse).toContain("https://example.com/meituan");
      expect(sse).toContain("模型没有成功生成最终总结");
      expect(search).toHaveBeenCalledWith(
        {
          count: 5,
          query: "美团 3690 5月15日 2026 收盘价",
          reason: "最近一个交易日",
        },
        expect.objectContaining({ enabled: true })
      );
      expect(search).toHaveBeenCalledTimes(1);
      expect(streamTextMock).toHaveBeenCalledTimes(2);
      const finalMessagesText = JSON.stringify(streamTextMock.mock.calls[1][0].messages);
      expect(finalMessagesText).toContain("https://example.com/meituan");
      expect(finalMessagesText).not.toContain('"role":"tool"');
      expect(finalMessagesText).not.toContain('"type":"tool-call"');
    } finally {
      db.close();
      if (existsSync(dbPath)) unlinkSync(dbPath);
      if (existsSync(configPath)) unlinkSync(configPath);
    }
  });

  it("rejects CopilotKit tools, page context, and shared state before model execution", async () => {
    const cases = [
      {
        name: "client tool",
        body: {
          tools: [{ name: "frontend_tool", description: "must not be accepted", parameters: {} }],
          context: [],
          state: {},
        },
        message: "Client-provided CopilotKit tools are not supported for ai2nao.",
      },
      {
        name: "page context",
        body: {
          tools: [],
          context: [{ description: "Selected file", value: "/private/path/secret.md" }],
          state: {},
        },
        message: "CopilotKit page context is not supported for ai2nao.",
      },
      {
        name: "shared state",
        body: {
          tools: [],
          context: [],
          state: { selectedFile: "/private/path/secret.md" },
        },
        message: "CopilotKit shared state is not supported for ai2nao.",
      },
      {
        name: "primitive shared state",
        body: {
          tools: [],
          context: [],
          state: "client-state",
        },
        message: "CopilotKit shared state is not supported for ai2nao.",
      },
      {
        name: "array shared state",
        body: {
          tools: [],
          context: [],
          state: [{ selectedFile: "/private/path/secret.md" }],
        },
        message: "CopilotKit shared state is not supported for ai2nao.",
      },
    ];

    for (const item of cases) {
      const dbPath = tempPath(`copilot-runtime-${item.name}.db`);
      const db = openDatabase(dbPath);
      streamTextMock.mockClear();
      try {
        const app = new Hono();
        registerCopilotKitRoutes(app, { db });
        const res = await app.request("/api/copilotkit", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            method: "agent/run",
            params: { agentId: "default" },
            body: {
              threadId: `thread-${item.name}`,
              runId: `run-${item.name}`,
              messages: [{ id: "u1", role: "user", content: "测试边界" }],
              forwardedProps: { webSearchEnabled: true },
              ...item.body,
            },
          }),
        });

        expect(res.status).toBe(200);
        const sse = await res.text();
        expect(sse).toContain("RUN_ERROR");
        expect(sse).toContain(item.message);
        expect(streamTextMock).not.toHaveBeenCalled();
      } finally {
        db.close();
        if (existsSync(dbPath)) unlinkSync(dbPath);
      }
    }
  });
});

async function* asyncParts(parts: unknown[]): AsyncGenerator<unknown> {
  for (const part of parts) yield part;
}

function tempPath(name: string): string {
  return join(tmpdir(), `ai2nao-${Date.now()}-${Math.random().toString(36).slice(2)}-${name}`);
}
