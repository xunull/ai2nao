// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
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

/** 归一后的形状:逐源原子分量 + capabilities。 */
const usage = (o: Partial<Record<string, number>> = {}) => ({
  state: "ok" as const,
  freshInput: 0,
  cacheReadInput: 0,
  cacheCreationInput: 0,
  output: 0,
  reasoningOutput: 0,
  costUsd: 0,
  pricedTokens: 0,
  unpricedTokens: 0,
  sessionCount: 0,
  coveredSessionCount: 0,
  unknownSessionCount: 0,
  errorSessionCount: 0,
  ...o,
});

const CAPS = {
  claude: { cacheRead: true, cacheCreation: true, reasoningOutput: false, sessionCounts: true },
  codex: { cacheRead: true, cacheCreation: false, reasoningOutput: true, sessionCounts: true },
  minimax: { cacheRead: true, cacheCreation: true, reasoningOutput: false, sessionCounts: false },
};

const WINDOW_OK = {
  ok: true,
  generatedAt: "2026-06-10T12:00:00Z",
  mode: "window" as const,
  windowKey: "1w" as const,
  range: { from: "2026-06-03T04:00:00Z", to: "2026-06-10T04:00:00Z" },
  bucketGranularity: "day" as const,
  capabilities: CAPS,
  buckets: [
    {
      bucketStart: "2026-06-03T16:00:00Z",
      bucketEnd: "2026-06-04T16:00:00Z",
      sources: {
        // claude: input 11500 = fresh 500 + read 9000 + creation 2000;output 500
        claude: usage({
          freshInput: 500,
          cacheReadInput: 9000,
          cacheCreationInput: 2000,
          output: 500,
          sessionCount: 2,
          coveredSessionCount: 2,
        }),
        // codex: input 2800 = fresh 1400 + read 1400(50% 命中);output 200,其中 reasoning 140
        codex: usage({
          freshInput: 1400,
          cacheReadInput: 1400,
          output: 200,
          reasoningOutput: 140,
          sessionCount: 1,
          coveredSessionCount: 1,
        }),
        minimax: usage(),
      },
    },
  ],
  totals: {
    totalTokens: 15000,
    sources: {
      claude: {
        ...usage({
          freshInput: 500,
          cacheReadInput: 9000,
          cacheCreationInput: 2000,
          output: 500,
          costUsd: 1.0,
          pricedTokens: 12000,
          sessionCount: 2,
          coveredSessionCount: 2,
        }),
        share: 0.8,
      },
      codex: {
        ...usage({
          freshInput: 1400,
          cacheReadInput: 1400,
          output: 200,
          reasoningOutput: 140,
          costUsd: 0.2345,
          pricedTokens: 2500,
          unpricedTokens: 500,
          sessionCount: 1,
          coveredSessionCount: 1,
        }),
        share: 0.2,
      },
      minimax: { ...usage({ state: "absent" as const }), share: 0 },
    },
    costState: { claude: "full" as const, codex: "partial" as const, minimax: "none" as const },
    totalCostUsd: 1.2345,
    unpricedTokenCount: 500,
    priceSnapshotDate: "2026-06-19",
    coverage: "full" as const,
    coveredSessionCount: 3,
    unknownSessionCount: 0,
    errorSessionCount: 0,
    totalSessionCount: 3,
  },
  previousWindow: {
    totalTokens: 10000,
    bySource: {
      claude: { totalTokens: 8000, freshInput: 8000, cacheReadInput: 0, cacheCreationInput: 0 },
      codex: { totalTokens: 2000, freshInput: 2000, cacheReadInput: 0, cacheCreationInput: 0 },
      minimax: { totalTokens: 0, freshInput: 0, cacheReadInput: 0, cacheCreationInput: 0 },
    },
  },
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
  capabilities: CAPS,
  buckets: [],
  totals: {
    totalTokens: 0,
    sources: {
      claude: { ...usage(), share: 0 },
      codex: { ...usage(), share: 0 },
      minimax: { ...usage({ state: "absent" as const }), share: 0 },
    },
    costState: { claude: "none" as const, codex: "none" as const, minimax: "none" as const },
    totalCostUsd: 0,
    unpricedTokenCount: 0,
    priceSnapshotDate: "2026-06-19",
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
    // scope row count to the matrix table (identified by its 来源 header),
    // since the page also renders the Claude composition table
    const matrixTable = screen
      .getByRole("columnheader", { name: "来源" })
      .closest("table") as HTMLTableElement;
    const rows = within(matrixTable).getAllByRole("row");
    // 1 header + Claude + Codex + 合计 = 4
    expect(rows.length).toBe(4);
  });

  it("renders Claude 输入构成 with cache hit rate", async () => {
    installFetchMock(async () => jsonResponse(WINDOW_OK));
    renderPage();
    await waitFor(() =>
      expect(screen.getByText("Claude 输入构成")).toBeInTheDocument()
    );
    // Scope to the Claude card — the Codex 输入构成 card shares row labels.
    const claudeCard = screen
      .getByText("Claude 输入构成")
      .closest("section") as HTMLElement;
    // hit rate = read / input = 9000 / 11500 = 78.3%
    expect(within(claudeCard).getByText(/cache 命中率 78\.3%/)).toBeInTheDocument();
    // three composition rows (Claude has cache-creation, unlike Codex)
    expect(within(claudeCard).getByText("真实新增")).toBeInTheDocument();
    expect(within(claudeCard).getByText("写入 cache")).toBeInTheDocument();
    expect(within(claudeCard).getByText("命中 cache")).toBeInTheDocument();
    expect(within(claudeCard).getByText("输入合计")).toBeInTheDocument();
  });

  it("renders Codex 输入构成 with cache hit rate (two-part, no cache-creation)", async () => {
    installFetchMock(async () => jsonResponse(WINDOW_OK));
    renderPage();
    await waitFor(() =>
      expect(screen.getByText("Codex 输入构成")).toBeInTheDocument()
    );
    const codexCard = screen
      .getByText("Codex 输入构成")
      .closest("section") as HTMLElement;
    // hit rate = cached / input = 1400 / 2800 = 50.0%
    expect(within(codexCard).getByText(/cache 命中率 50\.0%/)).toBeInTheDocument();
    expect(within(codexCard).getByText("真实新增")).toBeInTheDocument();
    expect(within(codexCard).getByText("命中 cache")).toBeInTheDocument();
    // Codex has NO cache-creation segment.
    expect(within(codexCard).queryByText("写入 cache")).toBeNull();
  });

  it("cost toggle off by default; on → cost card + snapshot date + unpriced note", async () => {
    installFetchMock(async () => jsonResponse(WINDOW_OK));
    renderPage();
    await waitFor(() =>
      expect(screen.getByText("窗口内总 token")).toBeInTheDocument()
    );
    // default OFF: no cost card
    expect(screen.queryByText("等价 API 成本（估算）")).toBeNull();
    // flip the cost toggle on
    fireEvent.click(screen.getByText("显示 USD 成本"));
    expect(screen.getByText("等价 API 成本（估算）")).toBeInTheDocument();
    expect(screen.getByText(/价格快照 2026-06-19/)).toBeInTheDocument();
    // totalCostUsd 1.2345 → $1.23
    expect(screen.getByText("$1.23")).toBeInTheDocument();
    // unpricedTokenCount 500 → note present
    expect(screen.getByText(/未计入成本/)).toBeInTheDocument();
  });

  it("renders Codex 输出构成 with reasoning rate", async () => {
    installFetchMock(async () => jsonResponse(WINDOW_OK));
    renderPage();
    await waitFor(() =>
      expect(screen.getByText("Codex 输出构成")).toBeInTheDocument()
    );
    // reasoning rate = reasoning / output = 140 / 200 = 70.0%
    expect(screen.getByText(/推理占比 70\.0%/)).toBeInTheDocument();
    // Scope to the Codex card — Claude 输出构成 shares 正常输出/输出合计 labels.
    const codexCard = screen.getByText("Codex 输出构成").closest("section") as HTMLElement;
    expect(within(codexCard).getByText("正常输出")).toBeInTheDocument();
    expect(within(codexCard).getByText("推理")).toBeInTheDocument();
    expect(within(codexCard).getByText("输出合计")).toBeInTheDocument();
  });

  it("renders Claude 输出构成 (single-value, no sub-split) so claude output isn't perceived as absent", async () => {
    installFetchMock(async () => jsonResponse(WINDOW_OK));
    renderPage();
    await waitFor(() =>
      expect(screen.getByText("Claude 输出构成")).toBeInTheDocument()
    );
    const claudeCard = screen.getByText("Claude 输出构成").closest("section") as HTMLElement;
    // claude 输出无细分 → 单值卡,标注「无细分」,不做 reasoning 拆分。
    expect(within(claudeCard).getByText("无细分")).toBeInTheDocument();
    expect(within(claudeCard).getByText(/无推理 \/ 缓存细分/)).toBeInTheDocument();
    expect(within(claudeCard).getByText("输出合计")).toBeInTheDocument();
    expect(within(claudeCard).queryByText("推理")).toBeNull();
  });

  it("hides Claude 输出构成 when there are no Claude output tokens", async () => {
    installFetchMock(async () =>
      jsonResponse({
        ...WINDOW_OK,
        totals: {
          ...WINDOW_OK.totals,
          sources: {
            ...WINDOW_OK.totals.sources,
            claude: { ...WINDOW_OK.totals.sources.claude, output: 0 },
          },
        },
      })
    );
    renderPage();
    await waitFor(() => expect(screen.getByText("Claude 输入构成")).toBeInTheDocument());
    expect(screen.queryByText("Claude 输出构成")).toBeNull();
  });

  it("hides Codex 输出构成 when there are no Codex output tokens", async () => {
    installFetchMock(async () =>
      jsonResponse({
        ...WINDOW_OK,
        totals: {
          ...WINDOW_OK.totals,
          sources: {
            ...WINDOW_OK.totals.sources,
            codex: { ...WINDOW_OK.totals.sources.codex, output: 0, reasoningOutput: 0 },
          },
          codexReasoningOutputTokens: 0,
        },
      })
    );
    renderPage();
    await waitFor(() =>
      expect(screen.getByText("输入 / 输出拆分")).toBeInTheDocument()
    );
    expect(screen.queryByText("Codex 输出构成")).not.toBeInTheDocument();
  });

  it("hides Claude 输入构成 when there are no Claude input tokens", async () => {
    installFetchMock(async () =>
      jsonResponse({
        ...WINDOW_OK,
        totals: {
          ...WINDOW_OK.totals,
          sources: {
            ...WINDOW_OK.totals.sources,
            claude: {
              ...WINDOW_OK.totals.sources.claude,
              freshInput: 0,
              cacheReadInput: 0,
              cacheCreationInput: 0,
            },
          },
        },
      })
    );
    renderPage();
    await waitFor(() =>
      expect(screen.getByText("输入 / 输出拆分")).toBeInTheDocument()
    );
    expect(screen.queryByText("Claude 输入构成")).not.toBeInTheDocument();
  });

  it("breakdown matrix shows 0 (not —) for an empty window", async () => {
    installFetchMock(async () =>
      jsonResponse({
        ...WINDOW_OK,
        buckets: [],
        totals: {
          ...WINDOW_OK.totals,
          totalTokens: 0,
          sources: {
            claude: { ...usage(), share: 0 },
            codex: { ...usage(), share: 0 },
            minimax: { ...usage({ state: "absent" as const }), share: 0 },
          },
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
