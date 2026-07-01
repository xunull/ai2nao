// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import React from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OpencodeHistory } from "../web/src/pages/OpencodeHistory";

function renderPage(initialEntries = ["/opencode-history"]) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={initialEntries}>
        <Routes>
          <Route path="/opencode-history" element={<OpencodeHistory />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

function stub() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      // /my-messages 必须在 /sessions 列表之前匹配。
      if (url.includes("/my-messages")) {
        return new Response(JSON.stringify({ ok: true, messages: [
          { id: "m1", timestamp: "2026-05-01T00:00:00.000Z", text: "帮我加个功能" },
          { id: "m2", timestamp: "2026-05-01T00:01:00.000Z", text: "<auto-slash-command>\n# /graphify Command\n模板正文", slashCommand: { name: "graphify" } },
        ] }));
      }
      if (url.includes("/api/opencode-history/status")) {
        return new Response(JSON.stringify({ platform: "darwin", opencodeRoot: "/x/opencode", dbPath: "/x/opencode/opencode.db", envOpencodeDataDir: false }));
      }
      if (url.includes("/api/opencode-history/projects")) {
        return new Response(JSON.stringify({
          ok: true, source: "sqlite", diagnostics: [],
          projects: [{ id: "p1", path: "/work/app", name: "app", sessionCount: 2, lastActiveAt: "2026-05-01T00:00:00.000Z" }],
        }));
      }
      if (url.includes("/api/opencode-history/sessions")) {
        return new Response(JSON.stringify({
          ok: true, source: "sqlite", diagnostics: [],
          sessions: [{ id: "s1", index: 1, title: "加个功能", createdAt: "2026-05-01T00:00:00.000Z", lastUpdatedAt: "2026-05-01T00:00:00.000Z", messageCount: 0, workspaceId: "p1", workspacePath: "/work/app", metadata: { opencode: { directory: "/work/app", model: "MiniMax-M3", agent: "build", archived: false, tokensInput: 1200, tokensOutput: 340, cost: 0.01 } } }],
        }));
      }
      throw new Error(`Unhandled fetch: ${url}`);
    })
  );
}

describe("OpencodeHistory 双栏", () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("初始只显示项目列，提示先选项目", async () => {
    stub();
    renderPage();
    expect(await screen.findByText("app")).toBeInTheDocument();
    expect(screen.getByText("请先在左侧选择一个项目。")).toBeInTheDocument();
  });

  it("选项目 → 右栏出该项目的 session（带 model/token 元数据）", async () => {
    stub();
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByText("app"));
    // 右栏会话出现。
    const sessionLink = await screen.findByRole("link", { name: /加个功能/ });
    expect(sessionLink).toHaveAttribute("href", expect.stringContaining("/opencode-history/s/s1"));
    const card = sessionLink.closest("li")!;
    expect(within(card).getByText(/MiniMax-M3/)).toBeInTheDocument();
    expect(within(card).getByText(/token/)).toBeInTheDocument();
  });

  it("「我的输入」按钮开抽屉、渲染清洗后消息、不嵌在 Link 内", async () => {
    stub();
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByText("app"));
    const trigger = await screen.findByRole("button", { name: "我的输入(已过滤注入)" });
    // 按钮是 Link 兄弟,不嵌在 anchor 里。
    const link = screen.getByRole("link", { name: /加个功能/ });
    expect(link).not.toContainElement(trigger);

    await user.click(trigger);
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("帮我加个功能")).toBeInTheDocument();
    expect(within(dialog).getByText(/已过滤注入/)).toBeInTheDocument();
    // 斜杠命令展开折叠成命令名(details/summary)。
    const details = within(dialog).getByText("/graphify").closest("details");
    expect(details).toBeTruthy();
    expect(within(dialog).getByText("/graphify")).toBeInTheDocument();
  });
});
