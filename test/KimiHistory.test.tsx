// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import React from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import KimiHistory from "../web/src/pages/KimiHistory";

/**
 * kimi 会话列表页。
 *
 * 「提问」这一列数的是**真人提问**,不是消息总数 —— 真库里 kimi 的消息 92%
 * 是 AI 正文,数全部会显示成比实际互动量大一个量级的数字。下面用
 * humanMessageCount=3 / totalMessageCount=40 的对比钉住这一点。
 */

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/kimi-history"]}>
        <Routes>
          <Route path="/kimi-history" element={<KimiHistory />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

function session(over: Partial<Record<string, unknown>> = {}) {
  return {
    sessionId: "s1",
    title: "现在有以主板内存显卡这种元素的小游戏么",
    projectKey: "/work/craft-game/neicun-xianka",
    projectPath: "/work/craft-game/neicun-xianka",
    identityConfidence: "high",
    model: "kimi-code/k3",
    createdAt: "2026-08-19T02:00:00.000Z",
    lastUpdatedAt: "2026-08-19T06:00:00.000Z",
    agentCount: 4,
    humanMessageCount: 3,
    totalMessageCount: 40,
    preview: "首句预览与标题不同,这样断言才不会两处都命中",
    ...over,
  };
}

function stub(body: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(body)))
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("KimiHistory", () => {
  it("列出会话:标题、项目、agent 数、真人提问数", async () => {
    stub({ ok: true, sessions: [session()], diagnostics: [] });
    renderPage();

    expect(await screen.findByRole("heading", { name: "Kimi 会话" })).toBeInTheDocument();
    expect(await screen.findByText(/现在有以主板内存显卡/)).toBeInTheDocument();
    expect(screen.getByText("craft-game/neicun-xianka")).toBeInTheDocument();
    // 4 个 agent、问了 3 次 —— 而不是把 40 条消息当成互动量。
    expect(screen.getByText("4")).toBeInTheDocument();
    expect(screen.getByText("3")).toBeInTheDocument();
    expect(screen.queryByText("40")).not.toBeInTheDocument();
  });

  it("每行链到详情页", async () => {
    stub({ ok: true, sessions: [session()], diagnostics: [] });
    renderPage();
    const link = await screen.findByRole("link", { name: /现在有以主板内存显卡/ });
    expect(link).toHaveAttribute("href", "/kimi-history/s/s1");
  });

  it("零真人提问的会话显示 0,不消失", async () => {
    stub({
      ok: true,
      sessions: [session({ humanMessageCount: 0, totalMessageCount: 2, title: "New Session" })],
      diagnostics: [],
    });
    renderPage();
    expect(await screen.findByText("New Session")).toBeInTheDocument();
    expect(screen.getByText("0")).toBeInTheDocument();
  });

  it("搜索按标题与项目过滤", async () => {
    stub({
      ok: true,
      sessions: [
        session(),
        session({
          sessionId: "s2",
          title: "麻辣烫小游戏",
          projectPath: "/work/craft-game/malatang",
          preview: "帮我调研一样麻辣烫游戏",
        }),
      ],
      diagnostics: [],
    });
    renderPage();
    await screen.findByText("麻辣烫小游戏");
    await userEvent.type(screen.getByPlaceholderText("标题、项目或首句"), "麻辣烫");
    expect(screen.getByText("麻辣烫小游戏")).toBeInTheDocument();
    expect(screen.queryByText(/现在有以主板内存显卡/)).not.toBeInTheDocument();
  });

  it("诊断显示出来 —— 正文缺失不能静默", async () => {
    stub({
      ok: true,
      sessions: [session({ totalMessageCount: 0, humanMessageCount: 0 })],
      diagnostics: [
        { kind: "kimi-messages-not-ingested", message: "1 个 kimi 会话缺正文 —— kimi 正文同步从未运行", count: 1 },
      ],
    });
    renderPage();
    expect(await screen.findByText(/kimi 正文同步从未运行/)).toBeInTheDocument();
  });

  it("一场都没有时给出可操作的空态", async () => {
    stub({ ok: true, sessions: [], diagnostics: [] });
    renderPage();
    expect(await screen.findByText(/kimi.tokens.refresh/)).toBeInTheDocument();
  });
});
