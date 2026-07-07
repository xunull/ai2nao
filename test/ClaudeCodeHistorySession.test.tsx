// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClaudeCodeHistorySession } from "../web/src/pages/ClaudeCodeHistorySession";

const RAW_FETCH = globalThis.fetch;

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

afterEach(() => {
  cleanup();
  globalThis.fetch = RAW_FETCH;
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
    // 第一页全部可见 → onItemsRendered 触发 fetchNextPage → 第二页出现。
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
