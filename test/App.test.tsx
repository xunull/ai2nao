// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import React from "react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../web/src/App";
import { Layout } from "../web/src/components/Layout";

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

function renderLayout(initialEntry: string) {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <Layout>
        <h1>测试页面</h1>
      </Layout>
    </MemoryRouter>
  );
}

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location-probe">{location.pathname + location.search}</div>;
}

function renderSearchLayout(initialEntry: string) {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <Layout>
        <LocationProbe />
      </Layout>
    </MemoryRouter>
  );
}

function setViewport(width: number) {
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    writable: true,
    value: width,
  });
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({
      matches: query === "(max-width: 1439px)" ? width <= 1439 : false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }))
  );
}

describe("App routes", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    window.localStorage.clear();
    setViewport(1760);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("redirects the root route to the work dashboard", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.startsWith("/api/work-dashboard")) {
          void init;
          return json({
            ok: true,
            generatedAt: "2026-06-07T10:00:00.000Z",
            range: { from: "2026-05-08T10:00:00.000Z", to: "2026-06-07T10:00:00.000Z", days: 30 },
            diagnostics: [],
            totals: {
              projectCount: 0,
              sessionCount: 0,
              tokenUsage: {
                inputTokens: 0,
                outputTokens: 0,
                totalTokens: 0,
                coverage: "unknown",
                coveredSessions: 0,
                totalSessions: 0,
                scannedSessions: 0,
                scanLimit: 5,
                truncated: false,
              },
              sourceCounts: { "claude-code": 0, codex: 0 },
            },
            projects: [],
          });
        }
        throw new Error(`Unhandled fetch: ${url}`);
      })
    );

    renderApp("/");

    expect(await screen.findByRole("heading", { name: "最近工作" })).toBeInTheDocument();
    expect(await screen.findByText("当前范围内没有 Claude Code 或 Codex 项目。")).toBeInTheDocument();
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

  it("renders the work token ranking route", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.startsWith("/api/work-dashboard/token-projects")) {
          return json({
            ok: true,
            generatedAt: "2026-06-07T10:00:00.000Z",
            range: {
              from: "2025-12-07T10:00:00.000Z",
              to: "2026-06-07T10:00:00.000Z",
              months: 6,
            },
            sources: ["claude-code", "codex"],
            diagnostics: [],
            projects: [
              {
                key: "path:/work/ai2nao",
                label: "ai2nao",
                path: "/work/ai2nao",
                totalTokens: 1200,
              },
            ],
          });
        }
        throw new Error(`Unhandled fetch: ${url}`);
      })
    );

    renderApp("/dashboard/tokens");

    expect(await screen.findByRole("heading", { name: "Token 排行" })).toBeInTheDocument();
    expect(await screen.findByText("ai2nao")).toBeInTheDocument();
  });

  it("renders the Shell permissions route", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/api/bash-permission-rules?behavior=allow")) {
          return json({
            rules: [
              {
                id: "r1",
                behavior: "allow",
                ruleType: "prefix",
                ruleContent: "npm run:*",
                scopeType: "directory",
                scopeValue: "/repo",
                source: "suggested",
                note: null,
                enabled: true,
                createdAt: "2026-05-23T00:00:00.000Z",
                updatedAt: "2026-05-23T00:00:00.000Z",
                lastUsedAt: null,
                useCount: 0,
              },
            ],
          });
        }
        throw new Error(`Unhandled fetch: ${url}`);
      })
    );

    renderApp("/bash-permissions");

    expect(await screen.findByRole("heading", { name: "Shell 权限" })).toBeInTheDocument();
    expect(await screen.findByText("npm run:*")).toBeInTheDocument();
  });

  it("renders the Shell sandbox route", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/api/bash-sandbox/status")) {
          return json({
            configPath: "/tmp/bash-sandbox.json",
            configured: true,
            config: {
              version: 1,
              mode: "best-effort",
              filesystem: {
                allowWrite: ["/repo"],
                denyWrite: [".env"],
                denyRead: ["~/.ssh"],
                allowRead: ["/repo"],
              },
              network: {
                allowedDomains: ["api.github.com"],
                deniedDomains: [],
              },
            },
            effectivePolicy: {
              filesystem: {
                allowWrite: ["/repo"],
                denyWrite: [".env"],
                denyRead: ["~/.ssh"],
                allowRead: ["/repo"],
              },
              network: {
                allowedDomains: ["api.github.com"],
                deniedDomains: [],
              },
            },
            dependencies: {
              supportedPlatform: true,
              ok: true,
              warnings: [],
              errors: [],
            },
            error: null,
          });
        }
        throw new Error(`Unhandled fetch: ${url}`);
      })
    );

    renderApp("/bash-sandbox");

    expect(await screen.findByRole("heading", { name: "Shell 沙箱" })).toBeInTheDocument();
    expect(await screen.findByText("/tmp/bash-sandbox.json")).toBeInTheDocument();
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
    expect(container.querySelector('[class*="h-[calc(100vh-56px)]"]')).toBeInTheDocument();
    expect(container.querySelector('[data-testid="ai-chat-thread-shell"]')).toBeInTheDocument();
  });
});

describe("Layout navigation", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    window.localStorage.clear();
    setViewport(1760);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("shows the AI chat action plus every group label and route link in one sidebar", () => {
    window.localStorage.setItem("ai2nao.sidebar.collapsed", "false");

    renderLayout("/repos");

    const navEl = screen.getByRole("navigation", { name: "全站导航" });
    expect(within(navEl).getByRole("link", { name: "AI 对话" })).toBeInTheDocument();

    const groups = [
      { label: "工作台", links: ["最近工作", "Token 排行", "Token 趋势", "工作回看", "对话宇宙"] },
      {
        label: "本机资产",
        links: ["仓库", "下载", "Mac 应用", "VS Code", "Cursor 项目", "Homebrew", "HF 模型", "LM Studio", "AI 工具清单", "Atuin", "Atuin 目录"],
      },
      { label: "浏览器", links: ["Chrome 历史", "Chrome 域名", "Chrome 下载"] },
      { label: "AI 记录", links: ["Cherry 对话", "Cursor 对话", "Claude", "Codex"] },
      { label: "AI 工具", links: ["Shell 权限", "Shell 沙箱", "RAG 状态", "RAG 调试"] },
      { label: "GitHub/开源", links: ["GitHub", "开源雷达", "Star Tag"] },
    ];

    // Single-column: every group label + every route link is visible at once,
    // no rail-icon click / panel switch needed.
    for (const group of groups) {
      expect(within(navEl).getByText(group.label)).toBeInTheDocument();
      for (const link of group.links) {
        expect(within(navEl).getByRole("link", { name: link })).toBeInTheDocument();
      }
    }

    // Settings is pinned to the bottom, present exactly once.
    expect(screen.getAllByRole("link", { name: "设置" })).toHaveLength(1);
  });

  it("does not leak implementation taxonomy into the sidebar copy (work-recap)", () => {
    window.localStorage.setItem("ai2nao.sidebar.collapsed", "false");

    renderLayout("/repos");
    const navEl = screen.getByRole("navigation", { name: "全站导航" });

    // Prior learning sidebar-implementation-label-leak (2026-06-01): user-facing
    // copy, no `(commit)` suffix, no `一级能力` taxonomy.
    expect(within(navEl).getByRole("link", { name: "工作回看" })).toBeInTheDocument();
    expect(within(navEl).queryByRole("link", { name: /\(commit\)/i })).toBeNull();
    expect(within(navEl).queryByRole("link", { name: /一级能力/ })).toBeNull();
  });

  it("marks the current route link as the active page", () => {
    window.localStorage.setItem("ai2nao.sidebar.collapsed", "false");

    renderLayout("/rag-status");

    expect(screen.getByRole("link", { name: "RAG 状态" })).toHaveAttribute(
      "aria-current",
      "page"
    );
  });

  it("persists the collapsed sidebar preference", () => {
    window.localStorage.setItem("ai2nao.sidebar.collapsed", "false");

    renderLayout("/repos");
    fireEvent.click(screen.getByRole("button", { name: "收起侧边导航" }));

    expect(window.localStorage.getItem("ai2nao.sidebar.collapsed")).toBe("true");
    expect(screen.getByRole("button", { name: "展开侧边导航" })).toHaveAttribute(
      "aria-expanded",
      "false"
    );
  });

  it("defaults to collapsed on narrow desktop when no preference exists", () => {
    setViewport(1280);

    renderLayout("/github/radar");

    // Collapsed = icon-only rail: the product wordmark is hidden, expand control shown.
    expect(screen.getByRole("button", { name: "展开侧边导航" })).toBeInTheDocument();
    expect(screen.queryByText("ai2nao")).not.toBeInTheDocument();
  });

  it("expands the sidebar from the collapsed state", () => {
    window.localStorage.setItem("ai2nao.sidebar.collapsed", "true");

    renderLayout("/github/radar");
    expect(screen.queryByText("ai2nao")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "展开侧边导航" }));

    expect(screen.getByText("ai2nao")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "收起侧边导航" })).toHaveAttribute(
      "aria-expanded",
      "true"
    );
  });

  it("marks AI chat as the active page", () => {
    window.localStorage.setItem("ai2nao.sidebar.collapsed", "false");

    renderLayout("/ai-chat");

    expect(screen.getByRole("link", { name: "AI 对话" })).toHaveAttribute(
      "aria-current",
      "page"
    );
  });

  it("marks the work dashboard route as active", () => {
    window.localStorage.setItem("ai2nao.sidebar.collapsed", "false");

    renderLayout("/dashboard");

    expect(screen.getByRole("link", { name: "最近工作" })).toHaveAttribute(
      "aria-current",
      "page"
    );
    expect(screen.getByRole("link", { name: "Token 排行" })).toBeInTheDocument();
  });

  it("marks the token ranking route without activating the dashboard link", () => {
    window.localStorage.setItem("ai2nao.sidebar.collapsed", "false");

    renderLayout("/dashboard/tokens");

    expect(screen.getByRole("link", { name: "Token 排行" })).toHaveAttribute(
      "aria-current",
      "page"
    );
    expect(screen.getByRole("link", { name: "最近工作" })).not.toHaveAttribute(
      "aria-current",
      "page"
    );
  });

  it("pins Settings at the bottom as a standalone link", () => {
    window.localStorage.setItem("ai2nao.sidebar.collapsed", "false");

    renderLayout("/repos");

    expect(screen.getByRole("link", { name: "设置" })).toBeInTheDocument();
  });

  it("submits the command-style search to the search route", () => {
    window.localStorage.setItem("ai2nao.sidebar.collapsed", "false");

    renderSearchLayout("/repos");
    const input = screen.getByLabelText("全站搜索");
    fireEvent.change(input, { target: { value: "repo notes" } });
    fireEvent.submit(input.closest("form")!);

    expect(screen.getByTestId("location-probe")).toHaveTextContent("/search?q=repo%20notes");
  });
});

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
  });
}
