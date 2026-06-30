// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
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

  it("renders fallback diagnostics, degraded badge, and archived toggle", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/codex-history/status")) {
        return new Response(JSON.stringify({
          platform: "darwin",
          codexRoot: "/tmp/codex",
          sessionsRoot: "/tmp/codex/sessions",
          stateDbPath: "/tmp/codex/state_5.sqlite",
          envCodexHome: false,
        }));
      }
      if (url.startsWith("/api/codex-history/sessions")) {
        return new Response(JSON.stringify({
          ok: true,
          source: "fallback",
          codexRoot: "/tmp/codex",
          sessionsRoot: "/tmp/codex/sessions",
          stateDbPath: "/tmp/codex/state_5.sqlite",
          diagnostics: [{ kind: "state-db-unavailable", message: "missing", path: "/tmp/codex/state_5.sqlite" }],
          scannedCount: 1,
          truncated: false,
          sessions: [{
            id: "s1",
            index: 1,
            title: "Codex thread",
            createdAt: "2026-04-26T00:00:00.000Z",
            lastUpdatedAt: "2026-04-26T00:00:00.000Z",
            messageCount: 0,
            workspaceId: "/work/app",
            workspacePath: "/work/app",
            preview: "preview",
            source: "codex",
            metadata: { codex: { cwd: "/work/app", archived: false, degraded: true, degradationReason: "transcript-missing", metrics: { toolCallCount: 0, commandCount: 0, failedCommandCount: 0, fileCount: 0 } } },
          }],
        }));
      }
      throw new Error(`Unhandled fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    renderRoutes();

    expect(await screen.findByText("Codex thread")).toBeInTheDocument();
    expect(screen.getByText("state-db-unavailable")).toBeInTheDocument();
    expect(screen.getByText(/degraded · transcript-missing/)).toBeInTheDocument();
    expect(screen.getByText(/仅显示未归档线程/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "包含已归档" }));
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("archived=true"))).toBe(true);
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
