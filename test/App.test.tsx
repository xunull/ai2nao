// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import React from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../web/src/App";

vi.mock("@copilotkit/react-core/v2", () => ({
  CopilotKit: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="mock-copilotkit">{children}</div>
  ),
  CopilotChat: ({ threadId }: { threadId: string }) => (
    <textarea aria-label="消息内容" data-threadid={threadId} />
  ),
}));

function renderApp(initialEntry: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <App />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

describe("App routes", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("redirects the root route to the lazy-loaded repos page", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/api/status")) {
          return json({
            repos: 0,
            manifests: 0,
            lastJob: null,
          });
        }
        if (url.includes("/api/repos")) {
          return json({
            repos: [],
            total: 0,
            page: 1,
            limit: 25,
          });
        }
        throw new Error(`Unhandled fetch: ${url}`);
      })
    );

    renderApp("/");

    expect(await screen.findByText("仓库")).toBeInTheDocument();
    expect(await screen.findByText("还没有索引任何仓库。")).toBeInTheDocument();
  });

  it("loads a nested named-export page through the route suspense boundary", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/api/atuin/directories/status")) {
          return json({
            enabled: true,
            atuinPath: "/tmp/history.db",
            directoryActivity: {
              ruleVersion: 1,
              configPath: "/tmp/config.json",
              configOk: true,
              configIssues: [],
              filterConfigHash: "abc",
              state: {
                last_rebuilt_at: "now",
                last_error: null,
                error_code: null,
                source_entry_count: 0,
                derived_directory_count: 0,
                derived_command_count: 0,
                last_rebuild_duration_ms: 1,
              },
              currentDerivedDirectoryCount: 0,
              currentDerivedCommandCount: 0,
              fresh: true,
              staleReasons: [],
            },
          });
        }
        if (url.includes("/api/atuin/directories/top")) {
          return json({ directories: [] });
        }
        throw new Error(`Unhandled fetch: ${url}`);
      })
    );

    renderApp("/atuin/directories");

    expect(await screen.findByText("Atuin 目录活动")).toBeInTheDocument();
    expect(await screen.findByText("/tmp/history.db")).toBeInTheDocument();
  });

  it("renders the standalone RAG status route", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/api/rag/status")) {
          return json({
            ok: true,
            dbPath: "/tmp/rag.db",
            configPath: "/tmp/rag.json",
            defaultDbPath: "/tmp/default-rag.db",
            configPresent: true,
            corpusRoots: ["/tmp/notes"],
            embeddingEnabled: true,
            chunkCount: 20,
            manifest: {
              total: 4,
              indexed: 3,
              skipped: 0,
              partial: 1,
              error: 0,
              deleted: 0,
              ftsError: 0,
              vectorError: 1,
            },
            vectorStore: {
              provider: "lancedb",
              path: "/tmp/lancedb",
              ok: true,
              indexedCount: 18,
              syncStatus: "partial",
              embeddingModel: "test-embedding",
              embeddingDim: 3,
              error: null,
            },
          });
        }
        throw new Error(`Unhandled fetch: ${url}`);
      })
    );

    renderApp("/rag-status");

    expect(await screen.findByRole("heading", { name: "RAG Status" })).toBeInTheDocument();
    expect(await screen.findByText("/tmp/rag.db")).toBeInTheDocument();
    expect(await screen.findByText("Vector Store")).toBeInTheDocument();
    expect(await screen.findByText("/tmp/notes")).toBeInTheDocument();
  });

  it("keeps the AI chat composer inside a fixed-height workbench", async () => {
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
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/api/llm-chat/status")) {
          return json({
            configured: true,
            provider: "openai-compatible",
            model: "local-test-model",
            baseHost: "http://127.0.0.1:11434",
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
            corpusRoots: ["/Users/test/project-notes"],
            embeddingEnabled: true,
            chunkCount: 12,
            manifest: {
              total: 3,
              indexed: 3,
              skipped: 0,
              partial: 0,
              error: 0,
              deleted: 0,
              ftsError: 0,
              vectorError: 0,
            },
            vectorStore: {
              provider: "lancedb",
              path: "/tmp/lancedb",
              ok: true,
              indexedCount: 12,
              syncStatus: "fresh",
              embeddingModel: "test-embedding",
              embeddingDim: 3,
              error: null,
            },
          });
        }
        if (url.endsWith("/api/web-search/status")) {
          return json({
            provider: "brave",
            configured: true,
            ok: true,
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
        if (url.endsWith("/api/llm-chat/sessions?limit=50")) {
          return json({ sessions: [] });
        }
        if (url.endsWith("/api/llm-chat/sessions") && init?.method === "POST") {
          return json({
            session: {
              id: "session-1",
              title: "新对话",
              created_at: "2026-05-07T00:00:00.000Z",
              updated_at: "2026-05-07T00:00:00.000Z",
              last_message_at: null,
              message_count: 0,
            },
          });
        }
        if (url.endsWith("/api/copilotkit/info")) {
          return json({
            version: "test",
            agents: { default: { name: "default" } },
            audioFileTranscriptionEnabled: false,
          });
        }
        throw new Error(`Unhandled fetch: ${url}`);
      })
    );

    const { container } = renderApp("/ai-chat");

    expect(await screen.findByRole("heading", { name: "AI 对话" })).toBeInTheDocument();
    expect(await screen.findByTestId("ai-chat-session-rail")).toBeInTheDocument();
    expect(await screen.findAllByText("新对话")).not.toHaveLength(0);
    expect(container.querySelector('[class*="h-[calc(100vh-112px)]"]')).toBeInTheDocument();
    expect(container.querySelector('[data-testid="ai-chat-thread-shell"]')).toBeInTheDocument();
  });
});

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
  });
}
