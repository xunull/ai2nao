import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/serve/app.js";
import { registerCopilotKitRoutes } from "../src/llmChat/copilotRuntime.js";
import { getLlmChatSession, listChatRuns } from "../src/llmChat/sessions.js";
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

  it("registers controlled shell only when forwarded props enable it", async () => {
    const dbPath = tempPath("copilot-runtime-run-shell.db");
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
        bashTool: {
          run: async () => ({
            ok: true,
            command: "pwd",
            cwd: process.cwd(),
            risk: "read-only",
            exitCode: 0,
            timedOut: false,
            durationMs: 1,
            stdout: process.cwd(),
            stderr: "",
            outputTruncated: false,
          }),
        },
      });
      const res = await app.request("/api/copilotkit/agent/default/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          threadId: "thread-run-shell",
          runId: "run-run-shell",
          messages: [{ id: "u1", role: "user", content: "跑一下 pwd" }],
          tools: [],
          context: [],
          state: {},
          forwardedProps: { shellExecutionEnabled: true },
        }),
      });

      expect(res.status).toBe(200);
      await res.text();
      const tools = streamTextMock.mock.calls[0]?.[0]?.tools ?? {};
      expect(Object.keys(tools)).toContain("ai2nao_run_shell");
      expect(Object.keys(tools)).not.toContain("ai2nao_run_code");
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

  /**
   * 下面三条钉的是**接线**,不是逻辑。
   *
   * `llmChat.chatRun.test.ts` 已经单独测过 claim / fence / 租约 / 终态,但那些是
   * 直接打库的单测 —— 就算我把 claim 接在一个永远走不到的分支上,它们照样全绿。
   * 只有真的跑一整轮,才能证明占位行确实长在执行路径上。
   */
  it("一轮跑完会留下一条 completed 的占位行,而且它不出现在 SSE 里", async () => {
    const dbPath = tempPath("copilot-runtime-run-row.db");
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
        { type: "text-start", id: "t" },
        { type: "text-delta", id: "t", text: "答案" },
        { type: "text-end", id: "t" },
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
          threadId: "thread-run-row",
          runId: "run-run-row",
          messages: [{ id: "u1", role: "user", content: "问题" }],
          tools: [],
          context: [],
          state: {},
          forwardedProps: {},
        }),
      });

      expect(res.status).toBe(200);
      const sse = await res.text();

      const runs = listChatRuns(db, "thread-run-row");
      expect(runs).toHaveLength(1);
      expect(runs[0]?.status).toBe("completed");

      // 服务端专有行永不发往 CopilotKit —— 漏出去前端会渲染成莫名其妙的
      // activity 消息,而且会被客户端原样回传。
      expect(sse).not.toContain("ai2nao:run:");
      expect(sse).not.toContain("ai2nao.run");
    } finally {
      db.close();
      if (existsSync(dbPath)) unlinkSync(dbPath);
      if (existsSync(configPath)) unlinkSync(configPath);
    }
  });

  it("同一条用户消息重复提交:不再调模型,只回放快照", async () => {
    const dbPath = tempPath("copilot-runtime-duplicate.db");
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
        { type: "text-start", id: "t" },
        { type: "text-delta", id: "t", text: "只答这一次" },
        { type: "text-end", id: "t" },
        { type: "finish" },
      ]),
    });

    try {
      const app = new Hono();
      registerCopilotKitRoutes(app, { db });
      const body = JSON.stringify({
        threadId: "thread-duplicate",
        runId: "run-duplicate",
        messages: [{ id: "u-dup", role: "user", content: "同一条消息" }],
        tools: [],
        context: [],
        state: {},
        forwardedProps: {},
      });
      const headers = { "Content-Type": "application/json" };

      const first = await app.request("/api/copilotkit/agent/default/run", {
        method: "POST",
        headers,
        body,
      });
      expect(first.status).toBe(200);
      await first.text();

      const second = await app.request("/api/copilotkit/agent/default/run", {
        method: "POST",
        headers,
        body,
      });
      expect(second.status).toBe(200);
      const sse = await second.text();

      // 重发不花钱:模型只被调过一次。
      expect(streamTextMock).toHaveBeenCalledTimes(1);
      expect(sse).toContain("MESSAGES_SNAPSHOT");
      expect(sse).toContain("RUN_FINISHED");
      // 没有开出第二轮。
      expect(listChatRuns(db, "thread-duplicate")).toHaveLength(1);
    } finally {
      db.close();
      if (existsSync(dbPath)) unlinkSync(dbPath);
      if (existsSync(configPath)) unlinkSync(configPath);
    }
  });

  it("这一轮失败时占位行落 failed,不是 completed", async () => {
    const dbPath = tempPath("copilot-runtime-failed-run.db");
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

    streamTextMock.mockImplementationOnce(() => {
      throw new Error("模型炸了");
    });

    try {
      const app = new Hono();
      registerCopilotKitRoutes(app, { db });
      const res = await app.request("/api/copilotkit/agent/default/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          threadId: "thread-failed-run",
          runId: "run-failed-run",
          messages: [{ id: "u1", role: "user", content: "会失败的一轮" }],
          tools: [],
          context: [],
          state: {},
          forwardedProps: {},
        }),
      });

      expect(res.status).toBe(200);
      const sse = await res.text();
      expect(sse).toContain("RUN_ERROR");

      // 失败也必须落终态 —— 不落的话这个会话会被一条永远 running 的行卡住。
      const runs = listChatRuns(db, "thread-failed-run");
      expect(runs).toHaveLength(1);
      expect(runs[0]?.status).toBe("failed");
    } finally {
      db.close();
      if (existsSync(dbPath)) unlinkSync(dbPath);
      if (existsSync(configPath)) unlinkSync(configPath);
    }
  });

  it("每步落库:第一步结束时消息已经在库里,不等整轮收尾", async () => {
    const dbPath = tempPath("copilot-runtime-per-step.db");
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

    const midTurn: string[][] = [];
    /**
     * 探针放在生成器内部,是因为路由返回的 Response 要等整轮结束才读得完 ——
     * 从外面根本观察不到「中途」。生成器在 `yield finish-step` 之后恢复,
     * 意味着消费方已经处理完该事件并 await 过 `onStepFinish`,所以这个恢复点
     * 必然在「第一步已落库」之后、「第二步还没开始」之前。
     */
    async function* twoSteps(): AsyncGenerator<unknown> {
      yield { type: "text-start", id: "s1" };
      yield { type: "text-delta", id: "s1", text: "第一步的回答" };
      yield { type: "text-end", id: "s1" };
      yield { type: "finish-step" };
      midTurn.push(
        (getLlmChatSession(db, "thread-per-step")?.messages ?? [])
          .filter((m) => !m.message_id.startsWith("ai2nao:"))
          .map((m) => m.plain_text)
      );
      yield { type: "start-step" };
      yield { type: "text-start", id: "s2" };
      yield { type: "text-delta", id: "s2", text: "第二步的回答" };
      yield { type: "text-end", id: "s2" };
      yield { type: "finish" };
    }
    streamTextMock.mockReturnValueOnce({ fullStream: twoSteps() });

    try {
      const app = new Hono();
      registerCopilotKitRoutes(app, { db });
      const res = await app.request("/api/copilotkit/agent/default/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          threadId: "thread-per-step",
          runId: "run-per-step",
          messages: [{ id: "u1", role: "user", content: "问题" }],
          tools: [],
          context: [],
          state: {},
          forwardedProps: {},
        }),
      });
      expect(res.status).toBe(200);
      await res.text();

      // 单步的 mock 分辨不出「每步落库」和「整轮收尾落库」—— 只有这一条能。
      expect(midTurn).toHaveLength(1);
      expect(midTurn[0]).toContain("第一步的回答");
      expect(midTurn[0]).not.toContain("第二步的回答");
    } finally {
      db.close();
      if (existsSync(dbPath)) unlinkSync(dbPath);
      if (existsSync(configPath)) unlinkSync(configPath);
    }
  });

  it("落库失败重试一次后中止本轮,不再往下跑", async () => {
    const dbPath = tempPath("copilot-runtime-persist-fail.db");
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

    // 真实的失败路径:单行 raw_json 超过 MAX_SYNC_RAW_BYTES(150 万字符)。
    // 不用 mock 掉 persistGenerated —— 那会连带影响本文件其它用例。
    const huge = "x".repeat(1_600_000);
    streamTextMock.mockReturnValueOnce({
      fullStream: asyncParts([
        { type: "text-start", id: "s1" },
        { type: "text-delta", id: "s1", text: huge },
        { type: "text-end", id: "s1" },
        { type: "finish-step" },
        { type: "start-step" },
        { type: "text-start", id: "s2" },
        { type: "text-delta", id: "s2", text: "不该被发出去的第二步" },
        { type: "text-end", id: "s2" },
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
          threadId: "thread-persist-fail",
          runId: "run-persist-fail",
          messages: [{ id: "u1", role: "user", content: "问题" }],
          tools: [],
          context: [],
          state: {},
          forwardedProps: {},
        }),
      });

      expect(res.status).toBe(200);
      const sse = await res.text();
      expect(sse).toContain("RUN_ERROR");
      expect(sse).toContain("保存失败");
      // 「看得见的回答必须存得下」:存不下就不能继续花钱往下跑。
      expect(sse).not.toContain("不该被发出去的第二步");
      expect(listChatRuns(db, "thread-persist-fail")[0]?.status).toBe("failed");
    } finally {
      db.close();
      if (existsSync(dbPath)) unlinkSync(dbPath);
      if (existsSync(configPath)) unlinkSync(configPath);
    }
  });

  it("模型快照按步盖:中途报错的轮次,已保存的那一步仍带模型名", async () => {
    const dbPath = tempPath("copilot-runtime-stamp-per-step.db");
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
        { type: "text-start", id: "s1" },
        { type: "text-delta", id: "s1", text: "第一步已保存" },
        { type: "text-end", id: "s1" },
        { type: "finish-step" },
        { type: "error", errorText: "厂商炸了" },
      ]),
    });

    try {
      const app = new Hono();
      registerCopilotKitRoutes(app, { db });
      const res = await app.request("/api/copilotkit/agent/default/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          threadId: "thread-stamp-step",
          runId: "run-stamp-step",
          messages: [{ id: "u1", role: "user", content: "问题" }],
          tools: [],
          context: [],
          state: {},
          forwardedProps: {},
        }),
      });

      expect(res.status).toBe(200);
      expect(await res.text()).toContain("RUN_ERROR");

      // 快照以前盖在整轮收尾那一处,报错的轮次根本跑不到 —— 那些回答就永远
      // 不知道是哪个模型答的。挪到每步之后,这一条才成立。
      const rows = (getLlmChatSession(db, "thread-stamp-step")?.messages ?? []).filter(
        (m) => !m.message_id.startsWith("ai2nao:")
      );
      const assistant = rows.find((m) => m.role === "assistant");
      expect(assistant, "第一步应该已经落库").toBeTruthy();
      expect(JSON.parse(assistant!.raw_json).ai2naoModel?.model).toBe("test-model");
      expect(listChatRuns(db, "thread-stamp-step")[0]?.status).toBe("failed");
    } finally {
      db.close();
      if (existsSync(dbPath)) unlinkSync(dbPath);
      if (existsSync(configPath)) unlinkSync(configPath);
    }
  });
});

async function* asyncParts(parts: unknown[]): AsyncGenerator<unknown> {
  for (const part of parts) yield part;
}

function tempPath(name: string): string {
  return join(tmpdir(), `ai2nao-${Date.now()}-${Math.random().toString(36).slice(2)}-${name}`);
}
