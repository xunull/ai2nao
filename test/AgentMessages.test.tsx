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
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentMessages } from "../web/src/pages/AgentMessages";

const RAW_FETCH = globalThis.fetch;

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <AgentMessages />
    </QueryClientProvider>
  );
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
  });
}
function installFetchMock(handler: (url: string) => Response): void {
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) =>
    handler(typeof input === "string" ? input : input.toString())
  ) as unknown as typeof fetch;
}
afterEach(() => {
  cleanup();
  globalThis.fetch = RAW_FETCH;
});

const ANALYTICS = {
  ok: true,
  allTimeTotals: [{ source: "claude", count: 5, charSum: 10 }],
  timeline: {
    window: "1w",
    granularity: "day",
    range: { from: "", to: "" },
    buckets: [],
    windowTotal: 5,
    previousWindowTotal: 0,
    deltaRatio: null,
    lastBucketPartial: false,
  },
};
const LIST = {
  ok: true,
  items: [
    {
      id: 1,
      source: "claude",
      sourceSessionId: "s1",
      eventAtUtc: "2026-07-05T02:00:00Z",
      text: "浏览到的消息",
    },
  ],
  nextBefore: null,
};
const SEARCH = {
  ok: true,
  hits: [
    {
      id: 9,
      source: "codex",
      sourceSessionId: "s9",
      eventAtUtc: "2026-07-05T03:00:00Z",
      snippet: "命中片段",
    },
  ],
};

function router(url: string): Response {
  if (url.includes("/analytics")) return jsonResponse(ANALYTICS);
  if (url.includes("/list")) return jsonResponse(LIST);
  if (url.includes("/search")) return jsonResponse(SEARCH);
  return jsonResponse({ ok: true });
}

describe("AgentMessages — 浏览默认 / 搜索接管 / 清空回浏览(codex#3)", () => {
  it("搜索框空 → 显示窗口浏览列表", async () => {
    installFetchMock(router);
    renderPage();
    await waitFor(() =>
      expect(screen.getByText("浏览到的消息")).toBeInTheDocument()
    );
  });

  it("搜索 → 结果接管;清空输入 → 回浏览", async () => {
    installFetchMock(router);
    renderPage();
    await waitFor(() =>
      expect(screen.getByText("浏览到的消息")).toBeInTheDocument()
    );

    const input = screen.getByPlaceholderText("搜我说过的话…");
    fireEvent.change(input, { target: { value: "关键词" } });
    fireEvent.click(screen.getByRole("button", { name: "搜索" }));

    // 搜索结果接管:命中计数出现,浏览项消失
    await waitFor(() =>
      expect(screen.getByText(/命中 1 条/)).toBeInTheDocument()
    );
    expect(screen.queryByText("浏览到的消息")).not.toBeInTheDocument();

    // 清空输入 → 回到浏览
    fireEvent.change(input, { target: { value: "" } });
    await waitFor(() =>
      expect(screen.getByText("浏览到的消息")).toBeInTheDocument()
    );
  });
});
