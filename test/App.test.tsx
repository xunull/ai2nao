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

  it("根路由渲染「今天」这一页,不再重定向到 dashboard", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.startsWith("/api/home/leads")) {
          return json({
            ok: true,
            summary: { tokens: 1_240_000, costUsd: 3.4, commits: 7, projects: 4, messages: 36 },
            leads: [
              {
                id: "quota.low",
                severity: "warning",
                title: "Kimi Code · 7 天用量 额度只剩 6%",
                href: "/providers",
                asOf: "2026-08-09T02:00:00.000Z",
              },
            ],
            overflow: 0,
            errors: [],
          });
        }
        throw new Error(`Unhandled fetch: ${url}`);
      })
    );

    renderApp("/");

    // 这一屏的身份:标题是「今天」,内容是线索而不是项目排名表。
    expect(await screen.findByRole("heading", { name: /今天/ })).toBeInTheDocument();
    const lead = await screen.findByRole("link", { name: /额度只剩 6%/ });
    expect(lead).toHaveAttribute("href", "/providers");
    // 回归点:不能再落到 dashboard 上。
    expect(screen.queryByRole("heading", { name: "最近工作" })).not.toBeInTheDocument();
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
  /*
   * 侧栏在 2026-08-02 从「一列 41 个一级入口」改成「6 个组的手风琴 + 页内 tab」。
   * 下面的用例是照着新结构重写的,但每一条原来在测什么都保留了下来 —— 只有两条的
   * **意图本身**被改造推翻了,各自在原地注明。
   *
   * 改造前的实测:内容高 1638px / 可见 609px,一屏看得到 36%。
   */
  beforeEach(() => {
    vi.restoreAllMocks();
    window.localStorage.clear();
    setViewport(1760);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("shows the pinned entries plus all seven group headers at once", () => {
    // 原用例断言「每个组名 + 每条路由链接同时可见」。手风琴推翻了后半句 —— 那正是
    // 改造的目的(24 个条目全摊开是 988px,放不下)。仍然成立、也仍然重要的是前半句:
    // 六个组的**名字**必须一眼全看得到,否则用户不知道东西在哪个抽屉里。
    window.localStorage.setItem("ai2nao.sidebar.collapsed", "false");

    renderLayout("/repos");

    const navEl = screen.getByRole("navigation", { name: "全站导航" });
    // 两个常驻入口:AI 对话,和「最近工作」——后者是首页(`/` 重定向到它、a2 徽标也
    // 指向它),折在组里意味着点自己的首页还得先展开一个抽屉。
    expect(within(navEl).getByRole("link", { name: "AI 对话" })).toBeInTheDocument();
    expect(within(navEl).getByRole("link", { name: "最近工作" })).toBeInTheDocument();

    for (const label of [
      "对话",
      "时间线",
      "代码",
      "模型与平台",
      "软件",
      "本机记录",
      "运行与诊断",
    ]) {
      expect(within(navEl).getByRole("button", { name: label })).toBeInTheDocument();
    }

    // 设置钉在底部,只出现一次。
    expect(screen.getAllByRole("link", { name: "设置" })).toHaveLength(1);
  });

  it("expands only the group that owns the current route", () => {
    window.localStorage.setItem("ai2nao.sidebar.collapsed", "false");

    renderLayout("/repos");
    const navEl = screen.getByRole("navigation", { name: "全站导航" });

    expect(within(navEl).getByRole("button", { name: "代码" })).toHaveAttribute(
      "aria-expanded",
      "true"
    );
    expect(within(navEl).getByRole("button", { name: "时间线" })).toHaveAttribute(
      "aria-expanded",
      "false"
    );
    // 展开的那组条目在,别组的不在 —— 手风琴之所以能放得下就是因为这个。
    expect(within(navEl).getByRole("link", { name: "仓库" })).toBeInTheDocument();
    expect(within(navEl).queryByRole("link", { name: "那天回放" })).toBeNull();
  });

  it("does not leak implementation taxonomy into the sidebar copy (work-recap)", () => {
    // 「工作回看」现在属于「时间线」组,所以要在那一组的路由上渲染才看得到它。
    window.localStorage.setItem("ai2nao.sidebar.collapsed", "false");

    renderLayout("/work-recap");
    const navEl = screen.getByRole("navigation", { name: "全站导航" });

    // Prior learning sidebar-implementation-label-leak (2026-06-01): user-facing
    // copy, no `(commit)` suffix, no `一级能力` taxonomy.
    expect(within(navEl).getByRole("link", { name: "工作回看" })).toBeInTheDocument();
    expect(within(navEl).queryByRole("link", { name: /\(commit\)/i })).toBeNull();
    expect(within(navEl).queryByRole("link", { name: /一级能力/ })).toBeNull();
  });

  it("marks the current route link as the active page", () => {
    window.localStorage.setItem("ai2nao.sidebar.collapsed", "false");

    // 「RAG 状态」和「RAG 调试」合成了一个条目「RAG」+ 两个 tab。
    renderLayout("/rag-status");

    expect(screen.getByRole("link", { name: "RAG" })).toHaveAttribute(
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

  it("defaults to expanded even on a narrow desktop", () => {
    // 原用例断言的是相反的行为:窗口窄于 1440px 就默认收起。那条规则在浏览器里是
    // 启发式,在桌面应用里是常量 —— BrowserWindow 默认 1280 宽、最小 960,永远小于
    // 1440,于是桌面版每个新用户第一次打开都是收起态:一列无标签图标。已删除。
    setViewport(1280);

    renderLayout("/github/radar");

    expect(screen.getByRole("button", { name: "收起侧边导航" })).toBeInTheDocument();
    expect(screen.getByText("ai2nao")).toBeInTheDocument();
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

  it("marks the work dashboard route as active and shows its tabs", () => {
    window.localStorage.setItem("ai2nao.sidebar.collapsed", "false");

    renderLayout("/dashboard");

    expect(screen.getByRole("link", { name: "最近工作" })).toHaveAttribute(
      "aria-current",
      "page"
    );
    // 「Token 排行」从侧栏的一级入口变成了页内 tab,不再在导航里。
    const navEl = screen.getByRole("navigation", { name: "全站导航" });
    expect(within(navEl).queryByRole("link", { name: "Token 排行" })).toBeNull();
    expect(screen.getByRole("link", { name: "Token 排行" })).toBeInTheDocument();
  });

  it("keeps the parent item active while on one of its tabs", () => {
    // 原用例断言的是相反的行为:在 /dashboard/tokens 上「最近工作」**不该**高亮,
    // 因为那时它们是两个平级入口。现在 Token 排行是最近工作的一个 tab,父条目保持
    // 高亮正是要的 —— 否则从 tab 切过去,侧栏会整个失去高亮。
    window.localStorage.setItem("ai2nao.sidebar.collapsed", "false");

    renderLayout("/dashboard/tokens");

    expect(screen.getByRole("link", { name: "最近工作" })).toHaveAttribute(
      "aria-current",
      "page"
    );
  });

  it("keeps the tab lit on a session detail page under a tab route", () => {
    // /code-review 抓到的:第一版 SubNav 用 `NavLink … end` 自己重判选中,于是会话详情
    // 页上 5 个 tab 一个都不高亮。模型层早就算对了(nav.model.test.ts 有对应用例)——
    // 是 Layout 没读 match.activeTab。所以这条断言必须落在渲染结果上,模型层盖不住。
    window.localStorage.setItem("ai2nao.sidebar.collapsed", "false");

    renderLayout("/claude-code-history/s/abc123");

    const tabsEl = screen.getByRole("navigation", { name: "页面视图" });
    expect(within(tabsEl).getByRole("link", { name: "Claude" })).toHaveAttribute(
      "aria-current",
      "page"
    );
    // 侧栏的父条目同时保持高亮。
    const navEl = screen.getByRole("navigation", { name: "全站导航" });
    expect(within(navEl).getByRole("link", { name: "AI 对话记录" })).toHaveAttribute(
      "aria-current",
      "page"
    );
  });

  it("hides the tab bar entirely on pages that have no tabs", () => {
    window.localStorage.setItem("ai2nao.sidebar.collapsed", "false");

    renderLayout("/providers");

    // 没有 tab 的页面不该为这条栏付出 44px 垂直空间。
    expect(screen.queryByRole("navigation", { name: "页面视图" })).toBeNull();
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
