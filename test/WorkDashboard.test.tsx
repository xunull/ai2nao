// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import React from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkDashboard } from "../web/src/pages/WorkDashboard";

function renderPage(initialEntry = "/dashboard") {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <Routes>
          <Route path="/dashboard" element={<WorkDashboard />} />
          <Route path="/codex-history/s/:sessionId" element={<div>Codex detail</div>} />
          <Route path="/claude-code-history/s/:sessionId" element={<div>Claude detail</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

describe("WorkDashboard", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("renders project totals, diagnostics, and recent sessions", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.startsWith("/api/work-dashboard")) {
          return json(dashboardResponse());
        }
        throw new Error(`Unhandled fetch: ${url}`);
      })
    );

    renderPage();

    expect(await screen.findByRole("heading", { name: "最近工作" })).toBeInTheDocument();
    expect(await screen.findByText("活跃项目")).toBeInTheDocument();
    expect(screen.getByText("项目搜索")).toBeInTheDocument();
    expect(screen.getByText("范围")).toBeInTheDocument();
    expect(screen.getAllByText("来源").length).toBeGreaterThan(0);
    expect(screen.getByText("2.00K")).toBeInTheDocument();
    expect(screen.getAllByText("ai2nao").length).toBeGreaterThan(0);
    expect(screen.getAllByText("/work/ai2nao").length).toBeGreaterThan(0);
    expect(screen.getByText("Codex · token-scan-truncated")).toBeInTheDocument();
    expect(screen.getByText("dashboard 首页设计")).toBeInTheDocument();
    expect(screen.getByText("消息数")).toBeInTheDocument();
    expect(screen.queryByText("状态")).not.toBeInTheDocument();
    expect(screen.getAllByText("Claude").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Codex").length).toBeGreaterThan(0);
  });

  it("updates query params when filters change", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/work-dashboard")) return json(dashboardResponse());
      throw new Error(`Unhandled fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    renderPage();

    await screen.findByText("dashboard 首页设计");
    await userEvent.selectOptions(screen.getByDisplayValue("最近 30 天"), "90");
    await userEvent.selectOptions(screen.getByDisplayValue("全部来源"), "codex");

    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([url]) => String(url).includes("rangeDays=90"))).toBe(true);
      expect(fetchMock.mock.calls.some(([url]) => String(url).includes("sources=codex"))).toBe(true);
    });
  });

  it("filters projects by path or label", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.startsWith("/api/work-dashboard")) return json(dashboardResponse());
        throw new Error(`Unhandled fetch: ${url}`);
      })
    );

    renderPage();

    await screen.findByText("dashboard 首页设计");
    await userEvent.type(screen.getByPlaceholderText("搜索项目路径或名称"), "notes");

    const projectList = screen.getByText("按最近对话排序").closest("aside")!;
    expect(within(projectList).getByText("notes")).toBeInTheDocument();
    expect(within(projectList).queryByText("ai2nao")).not.toBeInTheDocument();
  });
});

function dashboardResponse() {
  return {
    ok: true,
    generatedAt: "2026-06-07T10:00:00.000Z",
    range: {
      from: "2026-05-08T10:00:00.000Z",
      to: "2026-06-07T10:00:00.000Z",
      days: 30,
    },
    sources: ["claude-code", "codex", "opencode", "kimi"],
    availableSources: ["claude-code", "codex", "opencode", "kimi"],
    diagnostics: [
      {
        source: "codex",
        severity: "warning",
        kind: "token-scan-truncated",
        message: "只扫描最近 1 个会话 token。",
        count: 1,
      },
    ],
    totals: {
      projectCount: 2,
      sessionCount: 3,
      tokenUsage: {
        inputTokens: 1300,
        outputTokens: 700,
        totalTokens: 2000,
        coverage: "partial",
        coveredSessions: 2,
        totalSessions: 3,
        scannedSessions: 2,
        scanLimit: 5,
        truncated: true,
      },
      sourceCounts: { "claude-code": 1, codex: 2 },
    },
    projects: [
      {
        key: "path:/work/ai2nao",
        label: "ai2nao",
        path: "/work/ai2nao",
        identityConfidence: "high",
        lastUpdatedAt: "2026-06-07T09:30:00.000Z",
        sessionCount: 2,
        sourceCounts: { "claude-code": 1, codex: 1 },
        tokenUsage: {
          inputTokens: 1000,
          outputTokens: 500,
          totalTokens: 1500,
          coverage: "partial",
          coveredSessions: 1,
          totalSessions: 2,
          scannedSessions: 1,
          scanLimit: 1,
          truncated: true,
        },
        recentSessions: [
          {
            id: "codex-1",
            source: "codex",
            projectPath: "/work/ai2nao",
            identityConfidence: "high",
            title: "dashboard 首页设计",
            preview: "整理 Claude 和 Codex session。",
            createdAt: "2026-06-07T08:00:00.000Z",
            lastUpdatedAt: "2026-06-07T09:30:00.000Z",
            messageCount: 12,
            model: "gpt-5",
            detailHref: "/codex-history/s/codex-1",
          },
          {
            id: "claude-1",
            source: "claude-code",
            projectPath: "/work/ai2nao",
            identityConfidence: "high",
            title: "Claude code review",
            preview: "审查 dashboard 聚合边界。",
            createdAt: "2026-06-06T08:00:00.000Z",
            lastUpdatedAt: "2026-06-06T09:30:00.000Z",
            messageCount: 8,
            detailHref: "/claude-code-history/s/claude-1",
          },
        ],
      },
      {
        key: "path:/work/notes",
        label: "notes",
        path: "/work/notes",
        identityConfidence: "high",
        lastUpdatedAt: "2026-06-01T09:30:00.000Z",
        sessionCount: 1,
        sourceCounts: { "claude-code": 0, codex: 1 },
        tokenUsage: {
          inputTokens: 300,
          outputTokens: 200,
          totalTokens: 500,
          coverage: "full",
          coveredSessions: 1,
          totalSessions: 1,
          scannedSessions: 1,
          scanLimit: 1,
          truncated: false,
        },
        recentSessions: [
          {
            id: "codex-2",
            source: "codex",
            projectPath: "/work/notes",
            identityConfidence: "high",
            title: "整理本地笔记",
            preview: "同步最近记录。",
            createdAt: "2026-06-01T08:00:00.000Z",
            lastUpdatedAt: "2026-06-01T09:30:00.000Z",
            messageCount: 5,
            detailHref: "/codex-history/s/codex-2",
          },
        ],
      },
    ],
  };
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
  });
}
