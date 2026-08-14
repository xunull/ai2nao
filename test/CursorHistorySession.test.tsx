// @vitest-environment jsdom

/**
 * Cursor 会话详情页的渲染契约。
 *
 * **这是这个页面的第一个组件测试。** 在此之前它只有 `cursorHistory.platform.test.ts`
 * （后端路径解析），从没有人测过它渲染出什么 —— 而 markdown 渲染要改它两处路由
 * （thinking 和正文）。模板照 `test/CodexHistory.test.tsx` 写：同为单 `useQuery` +
 * 无虚拟化，不需要 `ClaudeCodeHistorySession.test.tsx` 那套 `ResizeObserver` 桩。
 */

import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import React from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CursorHistorySession } from "../web/src/pages/CursorHistorySession";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderSession() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/cursor-history/s/s1"]}>
        <Routes>
          <Route
            path="/cursor-history/s/:sessionId"
            element={<CursorHistorySession />}
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

function stubSession(messages: unknown[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/cursor-history/sessions/")) {
        return new Response(
          JSON.stringify({
            ok: true,
            session: {
              id: "s1",
              index: 0,
              title: "Cursor 详情测试",
              createdAt: "2026-08-14T00:00:00.000Z",
              lastUpdatedAt: "2026-08-14T00:01:00.000Z",
              messageCount: messages.length,
              workspaceId: "/work/app",
              workspacePath: "/work/app",
              source: "cursor",
              messages,
            },
          }),
          { headers: { "content-type": "application/json" } }
        );
      }
      throw new Error(`Unhandled fetch: ${url}`);
    })
  );
}

describe("CursorHistorySession — markdown 渲染分派", () => {
  it("assistant 正文渲染 markdown：表格成表、粗体成 strong", async () => {
    stubSession([
      {
        id: "a1",
        role: "assistant",
        content: "**重点**\n\n| 列A | 列B |\n|---|---|\n| 1 | 2 |",
        timestamp: "2026-08-14T00:00:01.000Z",
      },
    ]);
    const { container } = renderSession();
    expect(await screen.findByText("Cursor 详情测试")).toBeInTheDocument();
    expect(container.querySelector("strong")).toHaveTextContent("重点");
    expect(container.querySelector("table")).not.toBeNull();
    expect(container.textContent).not.toContain("|---|");
  });

  it("user 正文保持原样：markdown 标记以字面量显示（D3 逐字符不变）", async () => {
    stubSession([
      {
        id: "u1",
        role: "user",
        content: "**别渲染我**\n\n| a | b |\n|---|---|",
        timestamp: "2026-08-14T00:00:00.000Z",
      },
    ]);
    const { container } = renderSession();
    expect(await screen.findByText("Cursor 详情测试")).toBeInTheDocument();
    expect(container.textContent).toContain("**别渲染我**");
    expect(container.textContent).toContain("|---|");
    expect(container.querySelector("strong")).toBeNull();
    expect(container.querySelector("table")).toBeNull();
  });

  it("thinking 渲染 markdown", async () => {
    stubSession([
      {
        id: "a1",
        role: "assistant",
        content: "正文",
        thinking: "推理里的 **重点**",
        timestamp: "2026-08-14T00:00:01.000Z",
      },
    ]);
    const { container } = renderSession();
    expect(await screen.findByText("Cursor 详情测试")).toBeInTheDocument();
    expect(container.querySelector("strong")).toHaveTextContent("重点");
  });

  it("未知 role 走不解析路径（白名单在 assistant 上）", async () => {
    stubSession([
      {
        id: "x1",
        role: "system",
        content: "**不该被渲染**",
        timestamp: "2026-08-14T00:00:02.000Z",
      },
    ]);
    const { container } = renderSession();
    expect(await screen.findByText("Cursor 详情测试")).toBeInTheDocument();
    expect(container.textContent).toContain("**不该被渲染**");
    expect(container.querySelector("strong")).toBeNull();
  });
});
