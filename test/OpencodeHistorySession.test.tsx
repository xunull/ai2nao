// @vitest-environment jsdom

/**
 * OpenCode 会话详情页的渲染契约。
 *
 * **回归测试（IRON RULE）。** 这个页面此前从未被 render 过 —— `OpencodeHistory.test.tsx`
 * 只测了列表页。而 markdown 渲染在这里做了本次**唯一的既有内容呈现变更**：
 * thinking 从裸 `whitespace-pre-wrap` 的 div 改成走 `RenderedMarkdown`。
 * 其余四个页面的 thinking 本来就走渲染组件，只有这里是新增分支。
 */

import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import React from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OpencodeHistorySession } from "../web/src/pages/OpencodeHistorySession";

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
      <MemoryRouter initialEntries={["/opencode-history/s/s1"]}>
        <Routes>
          <Route
            path="/opencode-history/s/:sessionId"
            element={<OpencodeHistorySession />}
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
      if (url.includes("/api/opencode-history/sessions/")) {
        return new Response(
          JSON.stringify({
            ok: true,
            warnings: [],
            session: {
              id: "s1",
              title: "OpenCode 详情测试",
              lastUpdatedAt: "2026-08-14T00:01:00.000Z",
              messageCount: messages.length,
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

describe("OpencodeHistorySession — markdown 渲染分派", () => {
  it("回归：thinking 从纯文本改成渲染后，内容不丢字且 markdown 生效", async () => {
    stubSession([
      {
        id: "a1",
        role: "assistant",
        content: "正文",
        thinking: "推理开头\n\n- 要点甲\n- 要点乙\n\n结论是 **这个**",
        timestamp: "2026-08-14T00:00:01.000Z",
      },
    ]);
    const { container } = renderSession();
    expect(await screen.findByText("OpenCode 详情测试")).toBeInTheDocument();
    // 内容一个字不丢
    expect(container.textContent).toContain("推理开头");
    expect(container.textContent).toContain("要点甲");
    expect(container.textContent).toContain("要点乙");
    // markdown 确实生效：两个 li + 一个 strong
    expect(container.querySelectorAll("li")).toHaveLength(2);
    expect(container.querySelector("strong")).toHaveTextContent("这个");
    // 改动前那层裸 whitespace-pre-wrap 的 div 已不该存在于 thinking 区
    expect(container.textContent).not.toContain("**这个**");
  });

  it("assistant 正文渲染 markdown", async () => {
    stubSession([
      {
        id: "a1",
        role: "assistant",
        content: "## 小标题\n\n`inline` 与 **粗体**",
        timestamp: "2026-08-14T00:00:01.000Z",
      },
    ]);
    const { container } = renderSession();
    expect(await screen.findByText("OpenCode 详情测试")).toBeInTheDocument();
    expect(container.querySelector("h2")).toHaveTextContent("小标题");
    expect(container.querySelector("code")).toHaveTextContent("inline");
    // 行内代码不该变成代码块
    expect(container.querySelectorAll("pre")).toHaveLength(0);
  });

  it("user 正文保持原样（D3 逐字符不变）", async () => {
    stubSession([
      {
        id: "u1",
        role: "user",
        content: "## 别渲染我\n\n**也别加粗**",
        timestamp: "2026-08-14T00:00:00.000Z",
      },
    ]);
    const { container } = renderSession();
    expect(await screen.findByText("OpenCode 详情测试")).toBeInTheDocument();
    expect(container.textContent).toContain("## 别渲染我");
    expect(container.textContent).toContain("**也别加粗**");
    expect(container.querySelector("h2")).toBeNull();
    expect(container.querySelector("strong")).toBeNull();
  });
});
