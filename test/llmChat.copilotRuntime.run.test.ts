import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/serve/app.js";
import { registerCopilotKitRoutes } from "../src/llmChat/copilotRuntime.js";
import {
  activePathIds,
  applyBranchAction,
  getLlmChatSession,
  listChatRuns,
  siblingIds,
} from "../src/llmChat/sessions.js";
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

  /**
   * **空提示词不许发出去。**
   *
   * 「编辑重发」点下去的瞬间,服务端把激活叶子退回到那条提问的父节点 ——
   * 此时激活路径可以是空的。如果客户端这一轮又没带任何消息(刚重挂、还没拿到快照),
   * 合并结果就是空数组;交给 AI SDK 换来的是 provider 的
   * `Invalid prompt: messages must not be empty`,一条看不出所以然的报错。
   *
   * 正确的收场是回放快照、不调模型 —— 不花钱,界面上什么都不变。
   */
  it("空的消息列表不调模型,也不报 RUN_ERROR", async () => {
    const dbPath = tempPath("copilot-runtime-empty-prompt.db");
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

    try {
      const app = new Hono();
      registerCopilotKitRoutes(app, { db });
      const res = await app.request("/api/copilotkit/agent/default/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          threadId: "thread-empty-prompt",
          runId: "run-empty-prompt",
          messages: [],
          tools: [],
          context: [],
          state: {},
          forwardedProps: {},
        }),
      });

      expect(res.status).toBe(200);
      const sse = await res.text();
      expect(sse).toContain("RUN_FINISHED");
      expect(sse).not.toContain("RUN_ERROR");
      // 这一条是重点:一分钱都没花。
      expect(streamTextMock).not.toHaveBeenCalled();
      // 也没有留下一行卡住会话的 running。
      expect(listChatRuns(db, "thread-empty-prompt")[0]?.status).not.toBe("running");
    } finally {
      db.close();
      if (existsSync(dbPath)) unlinkSync(dbPath);
      if (existsSync(configPath)) unlinkSync(configPath);
    }
  });

  /**
   * **重新生成必须真的再调一次模型。**
   *
   * 重新生成按定义就是把同一条提问再问一次,而 `claimChatRun` 的重复提交判定
   * (「同一条 user 消息已经答完就不再调模型」)正好挡住它 —— 表现是点了没反应:
   * 没有新回答,也没有报错,因为那条路径直接回放快照就收场了。
   *
   * 放行的依据在树上:重新生成之前 `applyBranchAction` 已经把激活叶子退回到提问
   * 本身;而真正的重复提交(双击、两个进程抢同一轮)时,叶子是那条已有的回答。
   */
  it("重新生成:同一条提问再答一次,两个回答成兄弟", async () => {
    const dbPath = tempPath("copilot-runtime-regenerate.db");
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

    const answer = (id: string, text: string) => ({
      fullStream: asyncParts([
        { type: "text-start", id },
        { type: "text-delta", id, text },
        { type: "text-end", id },
        { type: "finish" },
      ]),
    });

    try {
      const app = new Hono();
      registerCopilotKitRoutes(app, { db });
      const thread = "thread-regenerate";
      const ask = async (runId: string) => {
        const res = await app.request("/api/copilotkit/agent/default/run", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            threadId: thread,
            runId,
            // 重新生成那一轮客户端带的就是这条原提问(connect 刚把列表换成激活路径)。
            messages: [{ id: "u1", role: "user", content: "第一问" }],
            tools: [],
            context: [],
            state: {},
            forwardedProps: {},
          }),
        });
        return await res.text();
      };

      streamTextMock.mockReturnValueOnce(answer("t1", "第一个答案"));
      expect(await ask("run-1")).toContain("第一个答案");

      // 点「重新生成」:激活叶子退回到 u1。
      const first = activePathIds(db, thread);
      expect(first).toHaveLength(2);
      applyBranchAction(db, thread, "regenerate", first[1]!);
      expect(activePathIds(db, thread)).toEqual(["u1"]);

      streamTextMock.mockReturnValueOnce(answer("t2", "第二个答案"));
      const sse = await ask("run-2");
      // 这一条是重点:真的又调了一次模型,而不是回放快照收场。
      expect(streamTextMock).toHaveBeenCalledTimes(2);
      expect(sse).toContain("第二个答案");

      // 两个回答是同一条提问的兄弟,旧的那个没被删。
      const kids = siblingIds(db, thread, "u1");
      expect(kids).toHaveLength(2);
      expect(kids[0]).toBe(first[1]);
      expect(activePathIds(db, thread)).toEqual(["u1", kids[1]]);

      // 切回旧答案仍然读得到。
      applyBranchAction(db, thread, "switch", kids[1]!, 0);
      const back = (getLlmChatSession(db, thread)?.messages ?? []).map((m) => m.plain_text ?? "");
      expect(back.join("\n")).toContain("第一个答案");
      expect(back.join("\n")).not.toContain("第二个答案");
    } finally {
      db.close();
      if (existsSync(dbPath)) unlinkSync(dbPath);
      if (existsSync(configPath)) unlinkSync(configPath);
    }
  });

  /**
   * **真实的一轮不是两条消息,是三条:user → reasoning → assistant。**
   *
   * 所以点在 assistant 上的「重新生成」必须退回到**那条提问**,而不是退回到
   * `parentOf(assistant)` —— 后者是 reasoning 行。退错一层的后果:
   * 激活叶子不是 user 消息,重复提交判定照样把这一轮拦下,点了没反应还不报错。
   *
   * 这条用带 reasoning 的流复现。之前的测试都是 user → assistant 两层,
   * 正好绕过了这一点 —— 这就是为什么单测全绿而真机上一直不行。
   */
  it("重新生成:一轮里有 reasoning 行时也要真的再答一次", async () => {
    const dbPath = tempPath("copilot-runtime-regen-reasoning.db");
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

    /** 带思考的一轮:先 reasoning,再正文。与真机上的形状一致。 */
    const thinkingAnswer = (id: string, text: string) => ({
      fullStream: asyncParts([
        { type: "reasoning-start", id: `${id}-r` },
        { type: "reasoning-delta", id: `${id}-r`, text: "先想一下" },
        { type: "reasoning-end", id: `${id}-r` },
        { type: "text-start", id },
        { type: "text-delta", id, text },
        { type: "text-end", id },
        { type: "finish" },
      ]),
    });

    try {
      const app = new Hono();
      registerCopilotKitRoutes(app, { db });
      const thread = "thread-regen-reasoning";
      const ask = async (runId: string) => {
        const res = await app.request("/api/copilotkit/agent/default/run", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            threadId: thread,
            runId,
            messages: [{ id: "u1", role: "user", content: "第一问" }],
            tools: [],
            context: [],
            state: {},
            forwardedProps: {},
          }),
        });
        return await res.text();
      };

      streamTextMock.mockReturnValueOnce(thinkingAnswer("t1", "第一个答案"));
      expect(await ask("run-1")).toContain("第一个答案");

      // 真机上的形状:提问、思考、正文三条,思考在中间。
      const path = activePathIds(db, thread);
      expect(path.length, `一轮应该有三条,实际 ${JSON.stringify(path)}`).toBe(3);
      const answerId = path[2]!;

      // 点「重新生成」——叶子必须退到**提问**,不是退到中间那条 reasoning。
      applyBranchAction(db, thread, "regenerate", answerId);
      expect(activePathIds(db, thread)).toEqual(["u1"]);

      streamTextMock.mockReturnValueOnce(thinkingAnswer("t2", "第二个答案"));
      const sse = await ask("run-2");
      expect(streamTextMock).toHaveBeenCalledTimes(2);
      expect(sse).toContain("第二个答案");

      // 两轮各自成一支,挂在同一条提问下面。
      expect(siblingIds(db, thread, "u1")).toHaveLength(2);
    } finally {
      db.close();
      if (existsSync(dbPath)) unlinkSync(dbPath);
      if (existsSync(configPath)) unlinkSync(configPath);
    }
  });

  /**
   * **编辑重发的端到端承诺:新提问是原提问的兄弟,原来那一问一答都还在。**
   *
   * 分支语义本身在 llmChat.branchRoutes / llmChat.messageTree 里逐条测过了;
   * 这一条测的是它们与运行时接起来之后的结果 —— 界面上用户看到的就是这个。
   * 会退化的形状有两种,都不报错:新提问接在原提问**后面**(那是追问,不是编辑),
   * 或者覆盖写把原来那条答案删掉(花过钱的内容没了)。
   */
  it("编辑重发:新提问成为兄弟,原来那一问一答都还在", async () => {
    const dbPath = tempPath("copilot-runtime-edit-resend.db");
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

    const answer = (id: string, text: string) => ({
      fullStream: asyncParts([
        { type: "text-start", id },
        { type: "text-delta", id, text },
        { type: "text-end", id },
        { type: "finish" },
      ]),
    });

    try {
      const app = new Hono();
      registerCopilotKitRoutes(app, { db });
      const thread = "thread-edit-resend";
      // **必须把 body 读完。** SSE 是惰性的 —— 只看 status 的话生成器还停在半路,
      // 落库和叶子推进都没发生,后面所有断言测的都是一个中间态。
      const run = async (runId: string, messages: unknown[]) => {
        const res = await app.request("/api/copilotkit/agent/default/run", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            threadId: thread,
            runId,
            messages,
            tools: [],
            context: [],
            state: {},
            forwardedProps: {},
          }),
        });
        return { status: res.status, sse: await res.text() };
      };

      streamTextMock.mockReturnValueOnce(answer("t1", "第一个答案"));
      const first = await run("run-1", [{ id: "u1", role: "user", content: "第一问" }]);
      expect(first.status).toBe(200);
      expect(first.sse).toContain("第一个答案");

      // 点「编辑」:激活叶子退到 u1 的父节点(首问 → null),此刻激活路径为空。
      const moved = applyBranchAction(db, thread, "edit", "u1");
      expect(moved.needsRun).toBe(true);
      expect(activePathIds(db, thread)).toEqual([]);

      // 改完发送:客户端此时只持有这一条新消息(刚重挂,快照是空的)。
      streamTextMock.mockReturnValueOnce(answer("t2", "第二个答案"));
      const second = await run("run-2", [{ id: "u2", role: "user", content: "改过的第一问" }]);
      expect(second.status).toBe(200);
      expect(second.sse).toContain("第二个答案");

      // 新提问挂在**根**下,和 u1 平级 —— 不是接在 u1 后面。
      expect(siblingIds(db, thread, null)).toEqual(["u1", "u2"]);
      const path = activePathIds(db, thread);
      expect(path[0]).toBe("u2");
      expect(path).toHaveLength(2);

      // 激活路径上看不见旧分支是对的(会话详情只回激活路径),但它必须还在库里。
      const stored = db
        .prepare(
          `SELECT message_id, plain_text, parent_id FROM llm_chat_messages
           WHERE session_id = ? AND message_index < 1000000`
        )
        .all(thread) as { message_id: string; plain_text: string | null; parent_id: string | null }[];
      expect(stored.map((r) => r.plain_text ?? "").join("\n")).toContain("第一个答案");

      // 而且切回去就能看到 —— 花过钱的那个回答不是只躺在库里,是真的还能读。
      const oldAnswer = stored.find((r) => r.parent_id === "u1")!;
      applyBranchAction(db, thread, "switch", "u1", 0);
      expect(activePathIds(db, thread)).toEqual(["u1", oldAnswer.message_id]);
      const backTexts = (getLlmChatSession(db, thread)?.messages ?? []).map((m) => m.plain_text ?? "");
      expect(backTexts.join("\n")).toContain("第一个答案");
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
