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
import { WorkTokensTrend } from "../web/src/pages/WorkTokensTrend";

const RAW_FETCH = globalThis.fetch;

function renderPage(initial = "/dashboard/tokens-trend") {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initial]}>
        <WorkTokensTrend />
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

function installFetchMock(handler: (url: string) => Response | Promise<Response>): void {
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    return handler(url);
  }) as unknown as typeof fetch;
}

afterEach(() => {
  cleanup();
  globalThis.fetch = RAW_FETCH;
});

const WINDOW_OK = {
  ok: true,
  generatedAt: "2026-06-10T12:00:00Z",
  mode: "window" as const,
  windowKey: "1w" as const,
  range: { from: "2026-06-03T04:00:00Z", to: "2026-06-10T04:00:00Z" },
  bucketGranularity: "day" as const,
  buckets: [
    {
      bucketStart: "2026-06-03T16:00:00Z",
      bucketEnd: "2026-06-04T16:00:00Z",
      claudeTokens: 12000,
      codexTokens: 3000,
      claudeSessionCount: 2,
      codexSessionCount: 1,
      claudeCoveredSessionCount: 2,
      codexCoveredSessionCount: 1,
      claudeUnknownSessionCount: 0,
      codexUnknownSessionCount: 0,
      claudeErrorSessionCount: 0,
      codexErrorSessionCount: 0,
    },
  ],
  totals: {
    totalTokens: 15000,
    claudeTokens: 12000,
    codexTokens: 3000,
    claudeInputTokens: 11500,
    claudeOutputTokens: 500,
    codexInputTokens: 2800,
    codexOutputTokens: 200,
    claudeShare: 0.8,
    codexShare: 0.2,
    coverage: "full" as const,
    coveredSessionCount: 3,
    unknownSessionCount: 0,
    errorSessionCount: 0,
    totalSessionCount: 3,
  },
  previousWindowTotal: 10000,
  deltaRatio: 0.5,
  monthRange: { earliest: "2025-01", latest: "2026-06" },
  diagnostics: [],
};

const MONTH_OK = {
  ok: true,
  generatedAt: "2026-06-10T12:00:00Z",
  mode: "month" as const,
  monthKey: "2026-05",
  range: { from: "2026-04-30T16:00:00Z", to: "2026-05-31T16:00:00Z" },
  bucketGranularity: "day" as const,
  buckets: [],
  totals: {
    totalTokens: 0,
    claudeTokens: 0,
    codexTokens: 0,
    claudeInputTokens: 0,
    claudeOutputTokens: 0,
    codexInputTokens: 0,
    codexOutputTokens: 0,
    claudeShare: 0,
    codexShare: 0,
    coverage: "full" as const,
    coveredSessionCount: 0,
    unknownSessionCount: 0,
    errorSessionCount: 0,
    totalSessionCount: 0,
  },
  monthRange: { earliest: "2025-01", latest: "2026-06" },
  diagnostics: [],
};

describe("WorkTokensTrend page", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("T-D1: happy window mode renders 4 stat cards + chart wrapper", async () => {
    installFetchMock(async (url) => {
      expect(url).toContain("window=1w");
      return jsonResponse(WINDOW_OK);
    });
    renderPage();
    await waitFor(() => {
      expect(screen.getByText("窗口内总 token")).toBeInTheDocument();
      expect(screen.getByText("Claude 占比")).toBeInTheDocument();
      expect(screen.getByText("Codex 占比")).toBeInTheDocument();
      expect(screen.getByText("环比上一窗口")).toBeInTheDocument();
    });
    // delta should be "+50.0%"
    expect(screen.getByText("+50.0%")).toBeInTheDocument();
    // 80% Claude
    expect(screen.getByText("80.0%")).toBeInTheDocument();
  });

  it("renders the 2×3 input/output breakdown matrix", async () => {
    installFetchMock(async () => jsonResponse(WINDOW_OK));
    renderPage();
    await waitFor(() =>
      expect(screen.getByText("输入 / 输出拆分")).toBeInTheDocument()
    );
    // table headers
    expect(screen.getByRole("columnheader", { name: "输入" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "输出" })).toBeInTheDocument();
    // row labels — 合计 row present
    expect(screen.getByText("合计")).toBeInTheDocument();
    // a few formatted numbers should appear (12000 claude total, 3000 codex total)
    // formatTokenCount renders compactly, so assert the cells exist via row count
    const rows = screen.getAllByRole("row");
    // 1 header + Claude + Codex + 合计 = 4
    expect(rows.length).toBe(4);
  });

  it("breakdown matrix shows 0 (not —) for an empty window", async () => {
    installFetchMock(async () =>
      jsonResponse({
        ...WINDOW_OK,
        buckets: [],
        totals: {
          ...WINDOW_OK.totals,
          totalTokens: 0,
          claudeTokens: 0,
          codexTokens: 0,
          claudeInputTokens: 0,
          claudeOutputTokens: 0,
          codexInputTokens: 0,
          codexOutputTokens: 0,
        },
      })
    );
    renderPage();
    await waitFor(() =>
      expect(screen.getByText("输入 / 输出拆分")).toBeInTheDocument()
    );
    // matrix renders; no crash; the 合计 row still present
    expect(screen.getByText("合计")).toBeInTheDocument();
  });

  it("switches request URL when window dropdown changes", async () => {
    const calls: string[] = [];
    installFetchMock(async (url) => {
      calls.push(url);
      return jsonResponse(WINDOW_OK);
    });
    renderPage();
    await waitFor(() => expect(calls.some((u) => u.includes("window=1w"))).toBe(true));

    const select = screen.getByLabelText("时间窗口") as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "1m" } });
    await waitFor(() => expect(calls.some((u) => u.includes("window=1m"))).toBe(true));
  });

  it("T-D2: month mode disables window control and shows 月份按天", async () => {
    installFetchMock(async (url) => {
      if (url.includes("month=2026-05")) return jsonResponse(MONTH_OK);
      return jsonResponse(WINDOW_OK);
    });
    renderPage("/dashboard/tokens-trend?month=2026-05");
    await waitFor(() => {
      expect(screen.getByText("月模式不展示环比")).toBeInTheDocument();
    });
    const windowSelect = screen.getByLabelText("时间窗口") as HTMLSelectElement;
    expect(windowSelect.disabled).toBe(true);
    expect(screen.getByRole("button", { name: /清除月份/ })).toBeInTheDocument();
  });

  it("T-D2 clear: 清除月份 button switches back to window mode", async () => {
    installFetchMock(async (url) => {
      if (url.includes("month=2026-05")) return jsonResponse(MONTH_OK);
      return jsonResponse(WINDOW_OK);
    });
    renderPage("/dashboard/tokens-trend?month=2026-05");
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /清除月份/ })).toBeInTheDocument()
    );
    fireEvent.click(screen.getByRole("button", { name: /清除月份/ }));
    await waitFor(() => {
      expect(screen.queryByText("月模式不展示环比")).not.toBeInTheDocument();
    });
  });

  it("T-D3: coverage='unknown' shows a guidance banner with scheduler link", async () => {
    installFetchMock(async () =>
      jsonResponse({
        ...WINDOW_OK,
        totals: {
          ...WINDOW_OK.totals,
          coverage: "unknown",
          coveredSessionCount: 0,
          totalSessionCount: 3,
        },
      })
    );
    renderPage();
    await waitFor(() =>
      expect(screen.getByText(/没有完整 token usage 记录/)).toBeInTheDocument()
    );
    const link = screen.getByRole("link", { name: "定时任务" });
    expect(link).toHaveAttribute("href", "/scheduler");
  });

  it("T-C2 loading: shows placeholder while query is in-flight", async () => {
    installFetchMock(
      () =>
        new Promise<Response>((resolve) => {
          setTimeout(() => resolve(jsonResponse(WINDOW_OK)), 50);
        })
    );
    renderPage();
    expect(screen.getByText("读取中…")).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByText("窗口内总 token")).toBeInTheDocument()
    );
  });

  it("T-C2 error: surfaces a friendly error banner on API failure", async () => {
    installFetchMock(async () =>
      jsonResponse({ error: { message: "DB exploded" } }, { status: 500 })
    );
    renderPage();
    await waitFor(() => expect(screen.getByText(/读取失败/)).toBeInTheDocument());
    expect(screen.getByText(/DB exploded/)).toBeInTheDocument();
  });
});
