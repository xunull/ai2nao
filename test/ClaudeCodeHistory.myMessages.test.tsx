// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import React from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClaudeCodeHistory } from "../web/src/pages/ClaudeCodeHistory";

type DetailResponder = () => Response;

// status / projects / sessions 都给固定响应;只有详情(/sessions/sess1)由每个用例定制。
function stubFetch(detail: DetailResponder, sessionTitle = "我的会话") {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/sessions/sess1")) return detail();
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
                title: sessionTitle,
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

describe("ClaudeCodeHistory · 只看我说的抽屉", () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("点按钮打开抽屉,只渲染清洗后的我方消息(丢 assistant、剥注入)", async () => {
    stubFetch(() =>
      new Response(
        JSON.stringify({
          ok: true,
          session: {
            messages: [
              { id: "m1", role: "user", content: "帮我修一个 bug", timestamp: "2026-06-29T01:00:00Z" },
              { id: "m2", role: "assistant", content: "好的我来看看这段代码", timestamp: "2026-06-29T01:01:00Z" },
              { id: "m3", role: "user", content: "<command-name>/clear</command-name>", timestamp: "2026-06-29T01:02:00Z" },
              { id: "m4", role: "user", content: "<system-reminder>注入噪音内容</system-reminder>再帮我加个测试", timestamp: "2026-06-29T01:03:00Z" },
            ],
          },
        })
      )
    );
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole("button", { name: "只看我发的消息" }));
    const dialog = await screen.findByRole("dialog");

    expect(within(dialog).getByText("你发了 2 条")).toBeInTheDocument();
    expect(within(dialog).getByText("帮我修一个 bug")).toBeInTheDocument();
    expect(within(dialog).getByText("再帮我加个测试")).toBeInTheDocument();
    // assistant 轮被丢
    expect(within(dialog).queryByText(/好的我来看看/)).not.toBeInTheDocument();
    // 注入文本被剥
    expect(within(dialog).queryByText(/注入噪音内容/)).not.toBeInTheDocument();
  });

  it("会话里没有手打消息时显示空状态", async () => {
    stubFetch(() =>
      new Response(
        JSON.stringify({
          ok: true,
          session: {
            messages: [
              { id: "a1", role: "assistant", content: "只有助手", timestamp: "2026-06-29T01:00:00Z" },
              { id: "u1", role: "user", content: "<command-name>/clear</command-name>", timestamp: "2026-06-29T01:01:00Z" },
            ],
          },
        })
      )
    );
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole("button", { name: "只看我发的消息" }));
    const dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).getByText("这个会话里没有你手动发出的消息。")
    ).toBeInTheDocument();
  });

  it("详情接口失败时显示错误态", async () => {
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
    stubFetch(() =>
      new Response(JSON.stringify({ ok: true, session: { messages: [] } }))
    );
    renderPage();

    const trigger = await screen.findByRole("button", { name: "只看我发的消息" });
    const link = screen.getByRole("link", { name: /我的会话/ });
    expect(link).not.toContainElement(trigger);
  });

  it("关闭按钮能关掉抽屉", async () => {
    stubFetch(() =>
      new Response(JSON.stringify({ ok: true, session: { messages: [] } }))
    );
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole("button", { name: "只看我发的消息" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "关闭" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
    );
  });

  it("抽屉标题对脏首条消息做清洗(不显示注入文本)", async () => {
    stubFetch(
      () =>
        new Response(
          JSON.stringify({
            ok: true,
            session: {
              messages: [
                { id: "m1", role: "user", content: "真正的问题", timestamp: "2026-06-29T01:00:00Z" },
              ],
            },
          })
        ),
      // 首条消息(= 标题)是被 caveat 包裹的注入。
      "<local-command-caveat>Caveat: The messages below were generated by the user while running local commands.</local-command-caveat>"
    );
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole("button", { name: "只看我发的消息" }));
    const dialog = await screen.findByRole("dialog");
    // 标题区只剩「只看我说的」,不含注入文本。
    expect(within(dialog).queryByText(/Caveat:/)).not.toBeInTheDocument();
    expect(within(dialog).queryByText(/local-command-caveat/)).not.toBeInTheDocument();
    expect(within(dialog).getByText("真正的问题")).toBeInTheDocument();
  });
});
