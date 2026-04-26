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
});
