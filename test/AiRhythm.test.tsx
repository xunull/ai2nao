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
// 页面打两个接口:按 URL 路由到各自的 mock body(缺省给个空壳,免得另一个卡加载)。
const EMPTY_HEATMAP = {
  ok: true,
  cells: [],
  maxCount: 0,
  total: 0,
  peak: null,
  generatedAt: "2026-07-08T12:00:00Z",
};
const EMPTY_STREAK = {
  ok: true,
  currentStreak: 0,
  longestStreak: 0,
  todayActive: false,
  lastActiveDay: null,
  totalActiveDays: 0,
  generatedAt: "2026-07-08T12:00:00Z",
};
const EMPTY_COMMANDS = {
  ok: true,
  commands: [],
  maxCount: 0,
  totalCommands: 0,
  distinctCommands: 0,
  generatedAt: "2026-07-08T12:00:00Z",
};
function installFetchMock(opts: {
  heatmap?: unknown;
  streak?: unknown;
  commands?: unknown;
}): void {
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/streak")) return jsonResponse(opts.streak ?? EMPTY_STREAK);
    if (url.includes("/commands"))
      return jsonResponse(opts.commands ?? EMPTY_COMMANDS);
    return jsonResponse(opts.heatmap ?? EMPTY_HEATMAP);
  }) as unknown as typeof fetch;
}
afterEach(() => {
  cleanup();
  globalThis.fetch = RAW_FETCH;
});

describe("AiRhythm — 作息热力图页", () => {
  it("有数据 → 渲染 peak 洞察 + 诚实副标", async () => {
    installFetchMock({
      heatmap: {
        ok: true,
        cells: [
          { weekday: 3, hour: 22, count: 42 },
          { weekday: 1, hour: 8, count: 5 },
        ],
        maxCount: 42,
        total: 47,
        peak: { weekday: 3, hour: 22, count: 42 },
        generatedAt: "2026-07-08T12:00:00Z",
      },
    });
    renderPage();
    await waitFor(() =>
      expect(screen.getByText("最活跃:周三 22:00 · 42 条")).toBeInTheDocument()
    );
    expect(screen.getByText(/已索引消息的快照/)).toBeInTheDocument();
  });

  it("空库 → peak null 友好提示(不崩,防除零)", async () => {
    installFetchMock({ heatmap: EMPTY_HEATMAP });
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

describe("AiRhythm — 连续天数卡", () => {
  it("当前连续活跃 → 数字 + 保持住", async () => {
    installFetchMock({
      streak: {
        ok: true,
        currentStreak: 12,
        longestStreak: 30,
        todayActive: true,
        lastActiveDay: "2026-07-08",
        totalActiveDays: 55,
        generatedAt: "2026-07-08T12:00:00Z",
      },
    });
    renderPage();
    await waitFor(() =>
      expect(screen.getByText("🔥 12")).toBeInTheDocument()
    );
    expect(screen.getByText("当前连续")).toBeInTheDocument();
    expect(screen.getByText("保持住 🔥")).toBeInTheDocument();
  });

  it("grace(今天未记录)→ 别断了提醒", async () => {
    installFetchMock({
      streak: {
        ok: true,
        currentStreak: 5,
        longestStreak: 5,
        todayActive: false,
        lastActiveDay: "2026-07-07",
        totalActiveDays: 5,
        generatedAt: "2026-07-08T12:00:00Z",
      },
    });
    renderPage();
    await waitFor(() =>
      expect(screen.getByText("今天还没记录,别断了 🔥")).toBeInTheDocument()
    );
  });

  it("已断 → 重新开始提示", async () => {
    installFetchMock({
      streak: {
        ok: true,
        currentStreak: 0,
        longestStreak: 8,
        todayActive: false,
        lastActiveDay: "2026-07-01",
        totalActiveDays: 20,
        generatedAt: "2026-07-08T12:00:00Z",
      },
    });
    renderPage();
    await waitFor(() =>
      expect(
        screen.getByText("连续已断,今天发一条重新开始")
      ).toBeInTheDocument()
    );
  });

  it("空库 → 还没有记录", async () => {
    installFetchMock({ streak: EMPTY_STREAK });
    renderPage();
    await waitFor(() =>
      expect(screen.getByText("还没有记录")).toBeInTheDocument()
    );
  });
});

describe("AiRhythm — 命令排行卡", () => {
  it("有榜 → 渲染 /名字 + 次数 + 汇总", async () => {
    installFetchMock({
      commands: {
        ok: true,
        commands: [
          { name: "gstack-office-hours", count: 178 },
          { name: "model", count: 74 },
        ],
        maxCount: 178,
        totalCommands: 824,
        distinctCommands: 40,
        generatedAt: "2026-07-08T12:00:00Z",
      },
    });
    renderPage();
    await waitFor(() =>
      expect(screen.getByText("/gstack-office-hours")).toBeInTheDocument()
    );
    expect(screen.getByText("824 次 · 40 种")).toBeInTheDocument();
    expect(screen.getByText("74")).toBeInTheDocument();
  });

  it("空库 → 还没有命令调用", async () => {
    installFetchMock({ commands: EMPTY_COMMANDS });
    renderPage();
    await waitFor(() =>
      expect(screen.getByText("还没有命令调用")).toBeInTheDocument()
    );
  });
});
