// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import React from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CherryStudioHistory } from "../web/src/pages/CherryStudioHistory";
import { CherryStudioHistorySession } from "../web/src/pages/CherryStudioHistorySession";

function renderRoutes(initialEntries = ["/cherry-studio-history"]) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={initialEntries}>
        <Routes>
          <Route path="/cherry-studio-history" element={<CherryStudioHistory />} />
          <Route path="/cherry-studio-history/s/:sessionId" element={<CherryStudioHistorySession />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

function json(body: unknown) {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
  });
}

function statusBody(overrides: Record<string, unknown> = {}) {
  return {
    platform: "darwin",
    cherryRoot: "/tmp/CherryStudio",
    agentsDbPath: "/tmp/CherryStudio/Data/agents.db",
    indexedDbPath: "/tmp/CherryStudio/IndexedDB/file__0.indexeddb.leveldb",
    indexedDbAvailable: true,
    indexedDbMissing: false,
    indexedDbTopicCount: 431,
    agentDbMissing: true,
    exportRootMissing: true,
    envCherryStudioExportRoot: false,
    ...overrides,
  };
}

function sessionSummary(id: string, title: string, index: number) {
  return {
    id,
    index,
    title,
    createdAt: "2026-05-01T00:00:00.000Z",
    lastUpdatedAt: "2026-05-01T00:00:00.000Z",
    messageCount: 2,
    workspaceId: "cherry-studio-indexeddb",
    workspacePath: "Cherry Studio",
    preview: "hello cherry",
    source: "cherry-studio",
  };
}

function sessionsBody(sessions: unknown[], total = sessions.length, offset = 0) {
  return {
    ok: true,
    cherryRoot: "/tmp/CherryStudio",
    agentsDbPath: "/tmp/CherryStudio/Data/agents.db",
    indexedDbPath: "/tmp/CherryStudio/IndexedDB/file__0.indexeddb.leveldb",
    indexedDbTopicCount: 431,
    diagnostics: [{ kind: "exportRootMissing", message: "export root not configured" }],
    scannedCount: total,
    truncated: false,
    total,
    limit: 50,
    offset,
    sessions,
  };
}

function detailBody(id: string, title: string) {
  return {
    ok: true,
    warnings: [],
    session: {
      id,
      title,
      createdAt: "2026-05-01T00:00:00.000Z",
      lastUpdatedAt: "2026-05-01T00:00:00.000Z",
      messageCount: 2,
      workspaceId: "cherry-studio-indexeddb",
      workspacePath: "Cherry Studio",
      source: "cherry-studio",
      messages: [
        { id: "m1", role: "user", content: "hello", timestamp: "2026-05-01T00:00:00.000Z" },
        { id: "m2", role: "assistant", content: "world", timestamp: "2026-05-01T00:00:01.000Z" },
      ],
    },
  };
}

describe("Cherry Studio history pages", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("renders a paged read-only split view and hides optional export-root noise", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.startsWith("/api/cherry-studio-history/status")) {
          return json(statusBody());
        }
        if (url.includes("/api/cherry-studio-history/sessions/export%3Atopic.md")) {
          return json(detailBody("export:topic.md", "Cherry detail"));
        }
        if (url.startsWith("/api/cherry-studio-history/sessions?")) {
          return json(sessionsBody([sessionSummary("export:topic.md", "Cherry topic", 1)], 1, 0));
        }
        if (url.startsWith("/api/cherry-studio-history/search")) {
          return json({
            ok: true,
            q: "hello",
            results: [{
              sessionId: "export:topic.md",
              index: 1,
              workspacePath: "topic.md",
              createdAt: "2026-05-01T00:00:00.000Z",
              matchCount: 1,
              snippets: [{ messageRole: "user", text: "hello cherry" }],
            }],
          });
        }
        throw new Error(`Unhandled fetch: ${url}`);
      })
    );

    renderRoutes(["/cherry-studio-history?q=hello"]);

    expect(await screen.findByText("Cherry detail")).toBeInTheDocument();
    expect(screen.getByTestId("cherry-session-rail")).toBeInTheDocument();
    expect(screen.getByTestId("cherry-readonly-thread-shell")).toBeInTheDocument();
    expect(screen.getByText("world")).toBeInTheDocument();
    expect(screen.queryByText("exportRootMissing")).not.toBeInTheDocument();
    const readonlyThread = within(screen.getByTestId("cherry-readonly-thread-shell"));
    expect(readonlyThread.queryByRole("textbox")).not.toBeInTheDocument();
    expect(readonlyThread.queryByRole("button", { name: /发送/ })).not.toBeInTheDocument();
  });

  it("moves the left history rail through server-backed pages", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/cherry-studio-history/status")) {
        return json(statusBody());
      }
      if (url.includes("/api/cherry-studio-history/sessions/indexeddb%3Apage-1")) {
        return json(detailBody("indexeddb:page-1", "Cherry page 1"));
      }
      if (url.includes("/api/cherry-studio-history/sessions/indexeddb%3Apage-2")) {
        return json(detailBody("indexeddb:page-2", "Cherry page 2"));
      }
      if (url.startsWith("/api/cherry-studio-history/sessions?")) {
        const params = new URL(url, "http://x").searchParams;
        const offset = Number(params.get("offset") ?? "0");
        if (offset >= 50) {
          return json(sessionsBody([sessionSummary("indexeddb:page-2", "Cherry page 2", 51)], 51, 50));
        }
        return json(sessionsBody([sessionSummary("indexeddb:page-1", "Cherry page 1", 1)], 51, 0));
      }
      throw new Error(`Unhandled fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    renderRoutes(["/cherry-studio-history"]);

    expect(await screen.findByText("Cherry page 1")).toBeInTheDocument();
    expect(screen.getByText("第 1-1 条，共 51 条")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "下一页" }));

    expect(await screen.findByText("Cherry page 2")).toBeInTheDocument();
    expect(screen.getByText("第 51-51 条，共 51 条")).toBeInTheDocument();
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining("offset=50"),
        expect.anything()
      );
    });
  });

  it("keeps the legacy detail route readable inside the split view", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.startsWith("/api/cherry-studio-history/status")) {
          return json(statusBody());
        }
        if (url.includes("/api/cherry-studio-history/sessions/export%3Atopic.md")) {
          return json(detailBody("export:topic.md", "Cherry detail"));
        }
        if (url.startsWith("/api/cherry-studio-history/sessions?")) {
          return json(sessionsBody([sessionSummary("export:topic.md", "Cherry topic", 1)], 1, 0));
        }
        throw new Error(`Unhandled fetch: ${url}`);
      })
    );

    renderRoutes(["/cherry-studio-history/s/export%3Atopic.md"]);

    expect(await screen.findByText("Cherry detail")).toBeInTheDocument();
    expect(screen.getByText("hello")).toBeInTheDocument();
    expect(screen.getByText("world")).toBeInTheDocument();
  });
});
