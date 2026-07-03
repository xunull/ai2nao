// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import React from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClaudeCodeHistory } from "../web/src/pages/ClaudeCodeHistory";

type MyMessagesResponder = () => Response;

// option C:清洗归后端。抽屉调 /sessions/sess1/my-messages,拿到的已是清洗后的
// {messages, cleanTitle}。抽屉本身不再清洗 —— 只负责显示。清洗逻辑由后端 cleaner
// 测试(test/agentUserMessages.cleaners.test.ts)覆盖。
function stubFetch(myMessages: MyMessagesResponder) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/sessions/sess1")) return myMessages();
      if (url.includes("/api/claude-code-history/status")) {
        return new Response(
          JSON.stringify({
            platform: "darwin",
            projectsRoot: "/root",
            envClaudeCodeProjectsRoot: false,
          })
        );
      }
      if (url.includes("/api/claude-code-history/projects/proj1/sessions")) {
        return new Response(
          JSON.stringify({
            ok: true,
            sessions: [
              {
                id: "sess1",
                index: 0,
                title: "我的会话",
                createdAt: "2026-06-29T00:00:00Z",
                lastUpdatedAt: "2026-06-29T01:00:00Z",
                messageCount: 5,
                workspaceId: "proj1",
                preview: "hi",
              },
            ],
          })
        );
      }
      if (url.includes("/api/claude-code-history/projects")) {
        return new Response(
          JSON.stringify({
            ok: true,
            projects: [
              {
                id: "proj1",
                path: "/p",
                sessionCount: 1,
                decodedWorkspacePath: "/a/b",
                slugDecodeIncomplete: false,
                lastActiveAt: null,
              },
            ],
          })
        );
      }
      throw new Error(`Unhandled fetch: ${url}`);
    })
  );
}

function myMessagesResp(
  messages: { id: string; timestamp: string; text: string }[],
  cleanTitle = "我的会话"
): Response {
  return new Response(JSON.stringify({ ok: true, messages, cleanTitle }));
}

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/claude-code-history?project=proj1"]}>
        <ClaudeCodeHistory />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

describe("ClaudeCodeHistory · 只看我说的抽屉(后端已清洗,抽屉只显示)", () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("点按钮打开抽屉,渲染后端返回的我方消息", async () => {
    stubFetch(() =>
      myMessagesResp([
        { id: "m1", timestamp: "2026-06-29T01:00:00Z", text: "帮我修一个 bug" },
        { id: "m4", timestamp: "2026-06-29T01:03:00Z", text: "再帮我加个测试" },
      ])
    );
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole("button", { name: "只看我发的消息" }));
    const dialog = await screen.findByRole("dialog");

    expect(within(dialog).getByText("你发了 2 条")).toBeInTheDocument();
    expect(within(dialog).getByText("帮我修一个 bug")).toBeInTheDocument();
    expect(within(dialog).getByText("再帮我加个测试")).toBeInTheDocument();
  });

  it("后端返回空 messages 时显示空状态", async () => {
    stubFetch(() => myMessagesResp([]));
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole("button", { name: "只看我发的消息" }));
    const dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).getByText("这个会话里没有你手动发出的消息。")
    ).toBeInTheDocument();
  });

  it("端点失败时显示错误态", async () => {
    stubFetch(() =>
      new Response(JSON.stringify({ error: { message: "加载失败了" } }), {
        status: 500,
      })
    );
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole("button", { name: "只看我发的消息" }));
    const dialog = await screen.findByRole("dialog");
    expect(await within(dialog).findByText("加载失败了")).toBeInTheDocument();
  });

  it("触发按钮不嵌在会话行的 Link 里(结构隔离)", async () => {
    stubFetch(() => myMessagesResp([]));
    renderPage();

    const trigger = await screen.findByRole("button", { name: "只看我发的消息" });
    const link = screen.getByRole("link", { name: /我的会话/ });
    expect(link).not.toContainElement(trigger);
  });

  it("关闭按钮能关掉抽屉", async () => {
    stubFetch(() => myMessagesResp([]));
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole("button", { name: "只看我发的消息" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "关闭" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
    );
  });

  it("抽屉标题用后端清洗后的 cleanTitle(纯注入 → 只剩「只看我说的」)", async () => {
    stubFetch(() =>
      myMessagesResp(
        [{ id: "m1", timestamp: "2026-06-29T01:00:00Z", text: "真正的问题" }],
        "" // 后端把 caveat 注入标题清成空
      )
    );
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole("button", { name: "只看我发的消息" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).queryByText(/Caveat:/)).not.toBeInTheDocument();
    expect(within(dialog).getByText("真正的问题")).toBeInTheDocument();
  });
});
