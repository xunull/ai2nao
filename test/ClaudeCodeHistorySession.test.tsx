// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClaudeCodeHistorySession } from "../web/src/pages/ClaudeCodeHistorySession";

const RAW_FETCH = globalThis.fetch;
const RAW_GET_BOUNDING_CLIENT_RECT = Element.prototype.getBoundingClientRect;
const RAW_OFFSET_HEIGHT = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight");
const RAW_OFFSET_WIDTH = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetWidth");

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const HEADER = {
  messageCount: 120,
  createdAt: "2026-06-29T00:00:00.000Z",
  lastUpdatedAt: "2026-06-29T02:00:00.000Z",
  firstUserText: "第一条消息",
  title: "分页会话测试",
  preview: "第一条消息",
  workspacePath: "/w/x/repo",
  warnings: [],
};

// 第一页(cursor=0):两条消息,nextCursor=2 → 还有下一页。
const PAGE_A = {
  ok: true,
  messages: [
    { id: "user-L1", role: "user", content: "第一条消息", timestamp: "2026-06-29T00:00:00.000Z" },
    {
      id: "assistant-L2",
      role: "assistant",
      content: "第二条回复",
      timestamp: "2026-06-29T00:01:00.000Z",
    },
  ],
  nextCursor: 2,
  hasMore: true,
};

// 第二页(cursor=2):一条消息,nextCursor=null → 到末尾。
const PAGE_B = {
  ok: true,
  messages: [
    { id: "user-L3", role: "user", content: "第三条消息", timestamp: "2026-06-29T00:02:00.000Z" },
  ],
  nextCursor: null,
  hasMore: false,
};

type MockOpts = {
  meta?: unknown;
  metaStatus?: number;
  pageA?: unknown;
  pageAStatus?: number;
  pageB?: unknown;
};

// 页面按 URL 打两类接口:?meta=1(头部)与 ?cursor=<n>&limit=(分页消息)。
function installFetchMock(opts: MockOpts = {}): void {
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("meta=1"))
      return jsonResponse(opts.meta ?? { ok: true, header: HEADER }, opts.metaStatus ?? 200);
    if (url.includes("cursor=2")) return jsonResponse(opts.pageB ?? PAGE_B);
    if (url.includes("cursor="))
      return jsonResponse(opts.pageA ?? PAGE_A, opts.pageAStatus ?? 200);
    throw new Error(`Unhandled fetch: ${url}`);
  }) as unknown as typeof fetch;
}

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={["/claude-code-history/s/sess-1?projectId=proj-1"]}>
        <Routes>
          <Route
            path="/claude-code-history/s/:sessionId"
            element={<ClaudeCodeHistorySession />}
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

// @tanstack/react-virtual 量滚动容器可视高走 element.offsetHeight,量每行高走 getBoundingClientRect,
// 并用 ResizeObserver 监听变化;jsdom 三者都缺(offset/rect 全 0、无 ResizeObserver),会让虚拟列表
// 算不出可视区而渲染 0 行。给容器/行非零高度并补 ResizeObserver 桩,overscan 行才会真实渲染、消息可断言。
beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    get: () => 600,
  });
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
    configurable: true,
    get: () => 800,
  });
  Element.prototype.getBoundingClientRect = function () {
    return {
      width: 800,
      height: 600,
      top: 0,
      left: 0,
      right: 800,
      bottom: 600,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect;
  };
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  );
});

afterEach(() => {
  cleanup();
  globalThis.fetch = RAW_FETCH;
  Element.prototype.getBoundingClientRect = RAW_GET_BOUNDING_CLIENT_RECT;
  if (RAW_OFFSET_HEIGHT) Object.defineProperty(HTMLElement.prototype, "offsetHeight", RAW_OFFSET_HEIGHT);
  if (RAW_OFFSET_WIDTH) Object.defineProperty(HTMLElement.prototype, "offsetWidth", RAW_OFFSET_WIDTH);
  vi.unstubAllGlobals();
});

describe("ClaudeCodeHistorySession — 大 transcript 分页详情页", () => {
  it("从 ?meta=1 渲染头部(标题 + 条数)", async () => {
    installFetchMock();
    renderPage();
    await waitFor(() =>
      expect(screen.getByText("分页会话测试")).toBeInTheDocument()
    );
    expect(screen.getByText("120 条消息")).toBeInTheDocument();
  });

  it("渲染第一页消息", async () => {
    installFetchMock();
    renderPage();
    await waitFor(() =>
      expect(screen.getByText("第一条消息")).toBeInTheDocument()
    );
    expect(screen.getByText("第二条回复")).toBeInTheDocument();
  });

  it("滚动触底 → 加载并渲染下一页消息", async () => {
    installFetchMock();
    renderPage();
    // 第一页(含哨兵页脚)全部可见 → 触底 useEffect 调 fetchNextPage → 第二页出现。
    await waitFor(() =>
      expect(screen.getByText("第三条消息")).toBeInTheDocument()
    );
  });

  it("空会话 → 空态提示", async () => {
    installFetchMock({
      meta: { ok: true, header: { ...HEADER, messageCount: 0 } },
      pageA: { ok: true, messages: [], nextCursor: null, hasMore: false },
    });
    renderPage();
    await waitFor(() =>
      expect(screen.getByText("此会话没有可展示的消息")).toBeInTheDocument()
    );
  });

  it("头部索引失败 → 错误态", async () => {
    installFetchMock({
      meta: { error: { message: "索引大文件失败" } },
      metaStatus: 500,
    });
    renderPage();
    await waitFor(() =>
      expect(screen.getByText("索引大文件失败")).toBeInTheDocument()
    );
  });
});

describe("ClaudeCodeHistorySession — user 命令注入回显结构化渲染", () => {
  // 含 /model 命令 + stdout(带无-ESC 的 [1m..[22m 加粗残骸)的 user 消息。
  const INJECT_PAGE = {
    ok: true,
    messages: [
      {
        id: "user-L1",
        role: "user",
        content:
          "<command-name>/model</command-name><command-args></command-args>" +
          "<local-command-stdout>Set model to [1mOpus[22m done</local-command-stdout>",
        timestamp: "2026-06-29T00:00:00.000Z",
      },
    ],
    nextCursor: null,
    hasMore: false,
  };

  it("命令成 chip、stdout 的 SGR 残骸还原成加粗、原始标签不裸露", async () => {
    installFetchMock({ pageA: INJECT_PAGE });
    renderPage();
    // 命令徽标。
    await waitFor(() => expect(screen.getByText("/model")).toBeInTheDocument());
    // SGR 残骸被吃掉:Opus 作为独立(加粗)文本节点出现,且不带 [1m/[22m。
    const opus = screen.getByText("Opus");
    expect(opus).toBeInTheDocument();
    expect(opus.className).toContain("font-bold");
    // 结构化视图里不裸露 <local-command-stdout> 标签,也没有 [22m 残骸。
    expect(screen.queryByText(/local-command-stdout/)).toBeNull();
    expect(screen.queryByText(/\[22m/)).toBeNull();
  });

  it("「查看原文」切换能看到原始 payload(带标签/残骸)", async () => {
    installFetchMock({ pageA: INJECT_PAGE });
    renderPage();
    await waitFor(() => expect(screen.getByText("查看原文")).toBeInTheDocument());
    fireEvent.click(screen.getByText("查看原文"));
    // 原文里带标签与 SGR 残骸。
    await waitFor(() =>
      expect(screen.getByText(/local-command-stdout/)).toBeInTheDocument()
    );
    expect(screen.getByText(/\[22m/)).toBeInTheDocument();
    // 切回结构化。
    fireEvent.click(screen.getByText("← 结构化视图"));
    await waitFor(() =>
      expect(screen.queryByText(/local-command-stdout/)).toBeNull()
    );
  });

  it("误伤边界:纯真人正文里碰巧含 [1m 不被当 SGR、原样保留", async () => {
    const TEXT_PAGE = {
      ok: true,
      messages: [
        {
          id: "user-L1",
          role: "user",
          content: "矩阵元素 M[1m] 就是普通文字不该被上色",
          timestamp: "2026-06-29T00:00:00.000Z",
        },
      ],
      nextCursor: null,
      hasMore: false,
    };
    installFetchMock({ pageA: TEXT_PAGE });
    renderPage();
    // 无控制标签 → 走 MessageMarkdown,[1m] 原样在文本里(未被 SGR 解析吃掉)。
    await waitFor(() =>
      expect(screen.getByText(/M\[1m\]/)).toBeInTheDocument()
    );
  });
});
