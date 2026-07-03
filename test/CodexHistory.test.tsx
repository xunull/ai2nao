// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import React from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CodexHistory } from "../web/src/pages/CodexHistory";
import { CodexHistorySession } from "../web/src/pages/CodexHistorySession";

function renderRoutes(initialEntries = ["/codex-history"]) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={initialEntries}>
        <Routes>
          <Route path="/codex-history" element={<CodexHistory />} />
          <Route path="/codex-history/s/:sessionId" element={<CodexHistorySession />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

describe("Codex history pages", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  function stubTwoPane() {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/codex-history/status")) {
        return new Response(JSON.stringify({
          platform: "darwin", codexRoot: "/tmp/codex",
          sessionsRoot: "/tmp/codex/sessions", stateDbPath: "/tmp/codex/state_5.sqlite",
          envCodexHome: false,
        }));
      }
      if (url.startsWith("/api/codex-history/projects")) {
        return new Response(JSON.stringify({
          ok: true, source: "fallback",
          diagnostics: [{ kind: "state-db-unavailable", message: "missing", path: "/tmp/codex/state_5.sqlite" }],
          projects: [{ id: "/work/app", path: "/work/app", name: "app", sessionCount: 1, lastActiveAt: "2026-04-26T00:00:00.000Z" }],
        }));
      }
      if (url.startsWith("/api/codex-history/sessions")) {
        return new Response(JSON.stringify({
          ok: true, source: "fallback", diagnostics: [], scannedCount: 1, truncated: false,
          sessions: [{
            id: "s1", index: 1, title: "Codex thread",
            createdAt: "2026-04-26T00:00:00.000Z", lastUpdatedAt: "2026-04-26T00:00:00.000Z",
            messageCount: 0, workspaceId: "/work/app", workspacePath: "/work/app", preview: "preview",
            source: "codex",
            metadata: { codex: { cwd: "/work/app", archived: false, degraded: true, degradationReason: "transcript-missing" } },
          }],
        }));
      }
      throw new Error(`Unhandled fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("左栏列项目、选中后右栏出会话(双栏 + degraded + 诊断)", async () => {
    const fetchMock = stubTwoPane();
    const user = userEvent.setup();
    renderRoutes();

    // 左栏:项目 + 诊断;右栏:未选时提示。
    expect(await screen.findByText("app")).toBeInTheDocument();
    expect(screen.getByText("state-db-unavailable")).toBeInTheDocument();
    expect(screen.getByText(/请先在左侧选择一个项目/)).toBeInTheDocument();
    // 选中前不应请求 sessions(enabled: cwd!=="")。
    expect(fetchMock.mock.calls.some(([u]) => String(u).startsWith("/api/codex-history/sessions"))).toBe(false);
    // D1:projects 请求不带 branch。
    const projCall = fetchMock.mock.calls.find(([u]) => String(u).startsWith("/api/codex-history/projects"));
    expect(String(projCall?.[0])).not.toMatch(/gitBranch/);

    // 点项目 → 右栏拉该项目 session。
    await user.click(screen.getByText("/work/app"));
    expect(await screen.findByText("Codex thread")).toBeInTheDocument();
    expect(screen.getByText(/degraded · transcript-missing/)).toBeInTheDocument();
    const sessCall = fetchMock.mock.calls.find(([u]) => String(u).startsWith("/api/codex-history/sessions"));
    expect(String(sessCall?.[0])).toContain("cwd=");

    // 含已归档 → 两栏都带 archived=true。
    await user.click(screen.getByRole("button", { name: "包含已归档" }));
    expect(fetchMock.mock.calls.some(([u]) => String(u).startsWith("/api/codex-history/projects") && String(u).includes("archived=true"))).toBe(true);
  });

  it("「只看我说的」抽屉:只渲染 event_msg 源真人手打(丢 AGENTS/双份/assistant/exec 样板)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        // 抽屉调 /sessions/s1/my-messages(后端已做 event_msg 门 + 清洗,option C):
        // 只返回真人手打那条(AGENTS/双份/assistant/exec 样板都由后端剔掉)。
        if (url.includes("/api/codex-history/sessions/s1")) {
          return new Response(JSON.stringify({
            ok: true,
            messages: [
              { id: "m3", timestamp: "2026-04-26T00:00:02.500Z", text: "帮我准备 mysql 知识点" },
            ],
            cleanTitle: "面试准备",
          }));
        }
        if (url.startsWith("/api/codex-history/projects")) {
          return new Response(JSON.stringify({
            ok: true, source: "sqlite", diagnostics: [],
            projects: [{ id: "/work/app", path: "/work/app", name: "app", sessionCount: 1, lastActiveAt: "2026-04-26T00:00:00.000Z" }],
          }));
        }
        if (url.startsWith("/api/codex-history/sessions")) {
          return new Response(JSON.stringify({
            ok: true, source: "sqlite", diagnostics: [], scannedCount: 1, truncated: false,
            sessions: [{ id: "s1", index: 1, title: "面试准备", createdAt: "2026-04-26T00:00:00.000Z", lastUpdatedAt: "2026-04-26T00:00:00.000Z", messageCount: 0, workspaceId: "/work/app", workspacePath: "/work/app", preview: "p", source: "codex", metadata: { codex: { cwd: "/work/app", archived: false } } }],
          }));
        }
        if (url.startsWith("/api/codex-history/status")) {
          return new Response(JSON.stringify({ platform: "darwin", codexRoot: "/tmp/codex", sessionsRoot: "/tmp/codex/sessions", stateDbPath: "/tmp/codex/state_5.sqlite", envCodexHome: false }));
        }
        throw new Error(`Unhandled fetch: ${url}`);
      })
    );
    const user = userEvent.setup();
    renderRoutes();

    // 选项目 → 右栏出 session。
    await user.click(await screen.findByText("/work/app"));
    const trigger = await screen.findByRole("button", { name: "只看我发的消息" });
    // 按钮不嵌在 session 行的 Link 里。
    const link = screen.getByRole("link", { name: /面试准备/ });
    expect(link).not.toContainElement(trigger);

    await user.click(trigger);
    const dialog = await screen.findByRole("dialog");
    // 只剩 event_msg 源、非 exec 样板的那一条;双份折成 1。
    expect(within(dialog).getByText("你发了 1 条")).toBeInTheDocument();
    expect(within(dialog).getByText("帮我准备 mysql 知识点")).toBeInTheDocument();
    expect(within(dialog).queryByText(/AGENTS\.md/)).not.toBeInTheDocument();
    expect(within(dialog).queryByText(/好的我来/)).not.toBeInTheDocument();
    expect(within(dialog).queryByText(/IMPORTANT: Do NOT read/)).not.toBeInTheDocument();
  });

  it("renders summary metrics and highlights failed tool rows", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.startsWith("/api/codex-history/sessions/s1")) {
          return new Response(JSON.stringify({
            ok: true,
            warnings: [],
            metrics: { toolCallCount: 2, commandCount: 1, failedCommandCount: 1, fileCount: 1 },
            session: {
              id: "s1",
              title: "Codex detail",
              createdAt: "2026-04-26T00:00:00.000Z",
              lastUpdatedAt: "2026-04-26T00:00:00.000Z",
              messageCount: 2,
              workspaceId: "/work/app",
              workspacePath: "/work/app",
              source: "codex",
              metadata: { codex: { cwd: "/work/app", archived: false, metrics: { toolCallCount: 2, commandCount: 1, failedCommandCount: 1, fileCount: 1 } } },
              messages: [
                { id: "u1", role: "user", content: "hello", timestamp: "2026-04-26T00:00:00.000Z" },
                { id: "t1", role: "assistant", content: "Command: npm test\nexit: 1", timestamp: "2026-04-26T00:00:01.000Z", metadata: { codexToolEvent: true, codexFailed: true, codexEventType: "exec_command_end" } },
              ],
            },
          }));
        }
        throw new Error(`Unhandled fetch: ${url}`);
      })
    );

    renderRoutes(["/codex-history/s/s1"]);

    expect(await screen.findByText("Codex detail")).toBeInTheDocument();
    expect(screen.getByText("工具调用")).toBeInTheDocument();
    expect(screen.getByText("失败命令")).toBeInTheDocument();
    expect(screen.getByText(/失败工具事件/)).toBeInTheDocument();
    expect(screen.getByText(/exec_command_end/)).toBeInTheDocument();
  });

  // 回归(2026-06-30 /investigate):详情页的 sticky <header> 曾包着标题 <h1>。
  // 标题用未清洗的首条消息,长标题会把固定头撑到 ≥ 滚动容器高度,sticky 头从此
  // 永久铺满视口、把下面所有消息压到视口外,用户"只看到一个标题"。修复把标题卡片
  // 移出固定头,只留小工具条 sticky。这里钉住结构不变量:固定头不得再含 <h1>。
  it("标题不在 sticky 固定头里(长标题不会撑爆固定头吞掉视口、盖住消息)", async () => {
    const longTitle = "超长注入标题".repeat(200);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.startsWith("/api/codex-history/sessions/s1")) {
          return new Response(JSON.stringify({
            ok: true,
            warnings: [],
            session: {
              id: "s1",
              title: longTitle,
              createdAt: "2026-04-26T00:00:00.000Z",
              lastUpdatedAt: "2026-04-26T00:00:00.000Z",
              messageCount: 1,
              workspaceId: "/work/app",
              workspacePath: "/work/app",
              source: "codex",
              metadata: { codex: { cwd: "/work/app", archived: false } },
              messages: [
                { id: "u1", role: "user", content: "我的提问", timestamp: "2026-04-26T00:00:00.000Z" },
              ],
            },
          }));
        }
        throw new Error(`Unhandled fetch: ${url}`);
      })
    );

    const { container } = renderRoutes(["/codex-history/s/s1"]);

    const h1 = await screen.findByRole("heading", { level: 1 });
    const header = container.querySelector("header");
    expect(header).not.toBeNull();
    expect(header!.className).toContain("sticky");
    // 关键:固定头不含标题，所以它高度恒定、永远吞不掉视口。
    expect(header!.contains(h1)).toBe(false);
    // 标题与消息都仍在页面上（只是标题不在固定头里）。
    expect(h1).toHaveTextContent("超长注入标题");
    expect(screen.getByText("我的提问")).toBeInTheDocument();
  });
});
