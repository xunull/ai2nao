// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import React from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Cosmos } from "../web/src/pages/Cosmos";

void React;

const RAW_FETCH = globalThis.fetch;

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/dashboard/cosmos"]}>
        <Cosmos />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}

function installFetchMock(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>
): void {
  globalThis.fetch = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      return handler(url, init);
    }
  ) as unknown as typeof fetch;
}

afterEach(() => {
  cleanup();
  globalThis.fetch = RAW_FETCH;
});

const EMPTY_POINTS = {
  ok: true,
  generatedAt: "2026-06-14T12:00:00Z",
  pointCount: 0,
  projectionMethod: "none" as const,
  embeddingModel: null,
  points: [] as unknown[],
};

const POINTS_OK = {
  ok: true,
  generatedAt: "2026-06-14T12:00:00Z",
  pointCount: 2,
  projectionMethod: "umap" as const,
  embeddingModel: "text-embedding-v4",
  points: [
    {
      sessionId: "p:claude1",
      source: "claude" as const,
      projectKey: "/tmp/proj-a",
      projectPath: "/tmp/proj-a",
      totalTokens: 1_000_000,
      x: 1.5,
      y: -2.0,
      clusterId: null,
    },
    {
      sessionId: "p:codex1",
      source: "codex" as const,
      projectKey: "/tmp/proj-b",
      projectPath: "/tmp/proj-b",
      totalTokens: 50_000,
      x: -3.1,
      y: 4.2,
      clusterId: null,
    },
  ],
};

const STATUS_IDLE = {
  phase: "idle" as const,
  indexedCount: 0,
  totalCount: 0,
  embeddedCount: 0,
  startedAt: null,
  finishedAt: null,
  lastError: null,
};

describe("Cosmos page", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("empty state: shows placeholder copy when 0 points", async () => {
    installFetchMock(async (url) => {
      if (url.includes("/refresh-status")) return jsonResponse(STATUS_IDLE);
      return jsonResponse(EMPTY_POINTS);
    });
    renderPage();
    await waitFor(() =>
      expect(screen.getByText(/还没有 AI 对话被索引/)).toBeInTheDocument()
    );
    // export button disabled when no points
    const exportBtn = screen.getByRole("button", { name: /导出 PNG/ });
    expect(exportBtn).toBeDisabled();
  });

  // NOTE: Recharts does not run its layout pass under jsdom, so the
  // <Legend> / <Scatter name> labels ("Claude Code" / "Codex") and tooltips
  // never reach the DOM in tests. We assert on everything the page renders
  // OUTSIDE the chart (header subtitle, footer, buttons) — visual fidelity
  // of the scatter itself is deferred to manual QA. Same constraint the
  // tokens-trend spike documented.

  it("happy: header subtitle + footer reflect pointCount, projection, model", async () => {
    installFetchMock(async (url) => {
      if (url.includes("/refresh-status")) return jsonResponse(STATUS_IDLE);
      return jsonResponse(POINTS_OK);
    });
    renderPage();
    // header subtitle reflects pointCount + projection method
    await waitFor(() =>
      expect(screen.getByText(/2 个 AI session/)).toBeInTheDocument()
    );
    expect(screen.getByText(/umap/)).toBeInTheDocument();
    // embedding model surfaced (honest disclosure) — header + footer
    expect(screen.getAllByText(/text-embedding-v4/).length).toBeGreaterThan(0);
    // export enabled now that points exist
    expect(screen.getByRole("button", { name: /导出 PNG/ })).not.toBeDisabled();
  });

  it("sanitize: rendered DOM never contains session content / summary leaks", async () => {
    // The page only reads the sanitized DTO fields. Assert no forbidden
    // substring appears even though POINTS_OK has no summary field at all.
    installFetchMock(async (url) => {
      if (url.includes("/refresh-status")) return jsonResponse(STATUS_IDLE);
      return jsonResponse(POINTS_OK);
    });
    const { container } = renderPage();
    await waitFor(() =>
      expect(screen.getByText(/2 个 AI session/)).toBeInTheDocument()
    );
    expect(container.textContent ?? "").not.toContain("summary");
    expect(container.textContent ?? "").not.toContain("SECRET");
  });

  it("refresh: clicking 刷新 issues a POST to /api/work-cosmos/refresh", async () => {
    const calls: { url: string; method?: string }[] = [];
    installFetchMock(async (url, init) => {
      calls.push({ url, method: init?.method });
      if (url.includes("/refresh-status")) return jsonResponse(STATUS_IDLE);
      if (url.includes("/refresh")) return jsonResponse({ ok: true });
      return jsonResponse(POINTS_OK);
    });
    renderPage();
    await waitFor(() =>
      expect(screen.getByText(/2 个 AI session/)).toBeInTheDocument()
    );
    fireEvent.click(screen.getByRole("button", { name: /刷新/ }));
    await waitFor(() =>
      expect(
        calls.some(
          (c) =>
            c.url.includes("/api/work-cosmos/refresh") &&
            !c.url.includes("refresh-status") &&
            c.method === "POST"
        )
      ).toBe(true)
    );
  });

  it("error banner: surfaces refresh-status failure phase", async () => {
    installFetchMock(async (url) => {
      if (url.includes("/refresh-status")) {
        return jsonResponse({
          ...STATUS_IDLE,
          phase: "failed",
          lastError: "embeddings HTTP 401: unauthorized",
        });
      }
      return jsonResponse(POINTS_OK);
    });
    renderPage();
    await waitFor(() =>
      expect(screen.getByText(/刷新失败/)).toBeInTheDocument()
    );
    expect(screen.getByText(/unauthorized/)).toBeInTheDocument();
  });
});
