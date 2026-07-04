// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AiRhythm } from "../web/src/pages/AiRhythm";

const RAW_FETCH = globalThis.fetch;

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <AiRhythm />
    </QueryClientProvider>
  );
}
function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
  });
}
function installFetchMock(body: unknown): void {
  globalThis.fetch = vi.fn(async () => jsonResponse(body)) as unknown as typeof fetch;
}
afterEach(() => {
  cleanup();
  globalThis.fetch = RAW_FETCH;
});

describe("AiRhythm — 作息热力图页", () => {
  it("有数据 → 渲染 peak 洞察 + 诚实副标", async () => {
    installFetchMock({
      ok: true,
      cells: [
        { weekday: 3, hour: 22, count: 42 },
        { weekday: 1, hour: 8, count: 5 },
      ],
      maxCount: 42,
      total: 47,
      peak: { weekday: 3, hour: 22, count: 42 },
      generatedAt: "2026-07-08T12:00:00Z",
    });
    renderPage();
    await waitFor(() =>
      expect(screen.getByText("最活跃:周三 22:00 · 42 条")).toBeInTheDocument()
    );
    expect(screen.getByText(/已索引消息的快照/)).toBeInTheDocument();
  });

  it("空库 → peak null 友好提示(不崩,防除零)", async () => {
    installFetchMock({
      ok: true,
      cells: [],
      maxCount: 0,
      total: 0,
      peak: null,
      generatedAt: "2026-07-08T12:00:00Z",
    });
    renderPage();
    await waitFor(() =>
      expect(screen.getByText("还没有已索引的消息")).toBeInTheDocument()
    );
  });

  it("接口错 → 错误态", async () => {
    globalThis.fetch = vi.fn(
      async () => new Response("boom", { status: 500 })
    ) as unknown as typeof fetch;
    renderPage();
    await waitFor(() => expect(screen.getByText(/加载失败/)).toBeInTheDocument());
  });
});
