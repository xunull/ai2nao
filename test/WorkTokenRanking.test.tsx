// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import React from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkTokenRanking } from "../web/src/pages/WorkTokenRanking";

function renderPage(initialEntry = "/dashboard/tokens") {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <Routes>
          <Route path="/dashboard/tokens" element={<WorkTokenRanking />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

describe("WorkTokenRanking", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("renders token ranking cards from the default Claude + Codex range", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/work-dashboard/token-projects")) {
        return json(tokenRankingResponse());
      }
      throw new Error(`Unhandled fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    renderPage();

    expect(await screen.findByRole("heading", { name: "Token 排行" })).toBeInTheDocument();
    expect(screen.getByDisplayValue("最近 6 个月")).toBeInTheDocument();
    expect(screen.getByDisplayValue("Claude + Codex")).toBeInTheDocument();
    expect(await screen.findByText("ai2nao")).toBeInTheDocument();
    expect(screen.getByText("2 个项目")).toBeInTheDocument();
    expect(screen.getByText("notes")).toBeInTheDocument();
    expect(screen.getByText("1.5M")).toBeInTheDocument();
    expect(screen.queryByText("部分 token")).not.toBeInTheDocument();
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/work-dashboard/token-projects?rangeMonths=6&sources=claude-code%2Ccodex");
  });

  it("updates API query params when filters change", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/work-dashboard/token-projects")) {
        return json(tokenRankingResponse());
      }
      throw new Error(`Unhandled fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    renderPage();

    await screen.findByText("ai2nao");
    await userEvent.selectOptions(screen.getByDisplayValue("最近 6 个月"), "all");
    await userEvent.selectOptions(screen.getByDisplayValue("Claude + Codex"), "codex");

    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([url]) => String(url).includes("rangeMonths=all"))).toBe(true);
      expect(fetchMock.mock.calls.some(([url]) => String(url).includes("sources=codex"))).toBe(true);
    });
  });
});

function tokenRankingResponse() {
  return {
    ok: true,
    generatedAt: "2026-06-07T10:00:00.000Z",
    range: {
      from: "2025-12-07T10:00:00.000Z",
      to: "2026-06-07T10:00:00.000Z",
      months: 6,
    },
    sources: ["claude-code", "codex"],
    diagnostics: [],
    projects: [
      {
        key: "path:/work/ai2nao",
        label: "ai2nao",
        path: "/work/ai2nao",
        totalTokens: 1_500_000,
      },
      {
        key: "path:/work/notes",
        label: "notes",
        path: "/work/notes",
        totalTokens: 500_000,
      },
    ],
  };
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
  });
}
