// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AiChat } from "../web/src/pages/AiChat";

let shellRenderConfig: {
  render: (props: {
    toolCallId: string;
    parameters?: unknown;
    status: "inProgress" | "executing" | "complete";
    result?: string;
  }) => React.ReactElement;
} | null = null;

vi.mock("@copilotkit/react-core/v2", () => ({
  CopilotKit: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="mock-copilotkit">{children}</div>
  ),
  CopilotChat: () => <div data-testid="mock-copilot-chat" />,
  useDefaultRenderTool: vi.fn(),
  useRenderTool: vi.fn((config: { name: string; render: typeof shellRenderConfig["render"] }) => {
    if (config.name === "ai2nao_run_shell") shellRenderConfig = config;
  }),
}));

describe("AI chat Bash tool card", () => {
  beforeEach(() => {
    shellRenderConfig = null;
    vi.stubGlobal(
      "ResizeObserver",
      class ResizeObserver {
        observe() {}
        unobserve() {}
        disconnect() {}
      }
    );
    Element.prototype.scrollTo = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/api/llm-chat/status")) {
          return json({
            configured: true,
            provider: "openai-compatible",
            model: "local-test-model",
            baseHost: "127.0.0.1:11434",
            configPath: "/tmp/llm-chat.json",
          });
        }
        if (url.endsWith("/api/rag/status")) {
          return json({
            ok: true,
            dbPath: "/tmp/rag.db",
            configPath: "/tmp/rag.json",
            defaultDbPath: "/tmp/rag-default.db",
            configPresent: true,
            corpusRoots: [],
            embeddingEnabled: false,
            chunkCount: 0,
            manifest: {
              total: 0,
              indexed: 0,
              skipped: 0,
              partial: 0,
              error: 0,
              deleted: 0,
              ftsError: 0,
              vectorError: 0,
            },
            vectorStore: null,
          });
        }
        if (url.endsWith("/api/web-search/status")) {
          return json({
            provider: "brave",
            configured: false,
            ok: false,
            configPath: "/tmp/web-search.json",
            capabilities: {
              freshness: false,
              safeSearch: false,
              resultLanguage: false,
              pageFetch: false,
            },
            cacheTtlMs: 300000,
            error: null,
          });
        }
        if (url.endsWith("/api/code-runner/status")) {
          return json({
            pyodide: { available: true, error: null },
            docker: { available: false, error: null },
          });
        }
        if (url.endsWith("/api/llm-chat/sessions?limit=50")) {
          return json({ sessions: [] });
        }
        if (url.endsWith("/api/llm-chat/sessions") && init?.method === "POST") {
          return json({
            session: {
              id: "session-1",
              title: "新对话",
              created_at: "2026-05-24T00:00:00.000Z",
              updated_at: "2026-05-24T00:00:00.000Z",
              last_message_at: null,
              message_count: 0,
            },
          });
        }
        throw new Error(`Unhandled fetch: ${url}`);
      })
    );
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("keeps a completed shell card expanded after the CopilotKit renderer remounts", async () => {
    const user = userEvent.setup();
    render(<AiChat />);
    await waitFor(() => expect(shellRenderConfig).not.toBeNull());

    const toolCallProps = {
      toolCallId: "call-shell-1",
      parameters: {
        command: "lsof -nP -iTCP:5573 -sTCP:LISTEN",
        cwd: "/repo",
        description: "inspect port",
      },
      status: "complete" as const,
      result: JSON.stringify({
        ok: false,
        command: "lsof -nP -iTCP:5573 -sTCP:LISTEN",
        cwd: "/repo",
        risk: "project-command",
        exitCode: null,
        durationMs: 0,
        stdout: "",
        stderr: "",
        deniedReason: "needs approval",
      }),
    };

    function ToolSurface({ config }: { config: NonNullable<typeof shellRenderConfig> }) {
      return config.render(toolCallProps);
    }

    const { rerender } = render(<ToolSurface config={shellRenderConfig!} />);
    expect(screen.queryByText("Arguments")).not.toBeInTheDocument();

    await user.click(screen.getByText("ai2nao_run_shell"));
    expect(screen.getByText("Arguments")).toBeInTheDocument();

    rerender(<ToolSurface config={shellRenderConfig!} />);
    expect(screen.getByText("Arguments")).toBeInTheDocument();
    expect(screen.getByText(/lsof -nP -iTCP:5573/)).toBeInTheDocument();
  });

  it("does not white-screen when CopilotKit renders a shell call before args are complete", async () => {
    render(<AiChat />);
    await waitFor(() => expect(shellRenderConfig).not.toBeNull());

    function ToolSurface({ config }: { config: NonNullable<typeof shellRenderConfig> }) {
      return config.render({
        toolCallId: "call-shell-partial",
        parameters: undefined,
        status: "inProgress",
        result: undefined,
      });
    }

    expect(() => render(<ToolSurface config={shellRenderConfig!} />)).not.toThrow();
    expect(screen.getByText("ai2nao_run_shell")).toBeInTheDocument();
    expect(screen.getByText(/正在生成命令/)).toBeInTheDocument();
  });

  it("renders partial permission debug data without collapsing into a render error", async () => {
    const user = userEvent.setup();
    render(<AiChat />);
    await waitFor(() => expect(shellRenderConfig).not.toBeNull());

    function ToolSurface({ config }: { config: NonNullable<typeof shellRenderConfig> }) {
      return config.render({
        toolCallId: "call-shell-debug",
        parameters: {
          command: "pwd",
          cwd: "/repo",
        },
        status: "complete",
        result: JSON.stringify({
          ok: false,
          command: "pwd",
          cwd: "/repo",
          permissionDebug: {
            mode: "default",
            decision: "ask",
            decisionReason: { type: "default", message: "needs approval" },
            source: "local",
            orphaned: false,
          },
        }),
      });
    }

    render(<ToolSurface config={shellRenderConfig!} />);
    await user.click(screen.getByText("ai2nao_run_shell"));

    expect(screen.getByText("Permission Debug")).toBeInTheDocument();
    expect(screen.getByText(/"matchedRules": \[\]/)).toBeInTheDocument();
    expect(screen.getByText(/"suggestedRules": \[\]/)).toBeInTheDocument();
  });
});

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
  });
}
