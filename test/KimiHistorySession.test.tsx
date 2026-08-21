// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import React from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import KimiHistorySession from "../web/src/pages/KimiHistorySession";

/**
 * kimi 会话详情页。
 *
 * 两个不能混的状态:
 *   - 会话**不存在** → 后端 404 → 页面显示错误
 *   - 会话存在但**没有可读正文** → 后端 200 加空数组 → 页面显示空态
 * 「没内容」长得像「不存在」是这一版明确要避免的。
 */

function renderPage(sessionId = "s1") {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[`/kimi-history/s/${sessionId}`]}>
        <Routes>
          <Route path="/kimi-history/s/:sessionId" element={<KimiHistorySession />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

const SESSION = {
  sessionId: "s1",
  title: "现在有以主板内存显卡这种元素的小游戏么",
  projectPath: "/work/craft-game/neicun-xianka",
  model: "kimi-code/k3",
  createdAt: "2026-08-19T02:00:00.000Z",
  lastUpdatedAt: "2026-08-19T06:00:00.000Z",
  agentCount: 4,
  humanMessageCount: 2,
  totalMessageCount: 5,
};

function stub(status: number, body: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(body), { status }))
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("KimiHistorySession", () => {
  it("显示标题、项目、agent 数与正文", async () => {
    stub(200, {
      ok: true,
      session: SESSION,
      messages: [
        { id: 1, role: "user", eventAtUtc: "2026-08-19T02:00:00.000Z", text: "我的问题" },
        { id: 2, role: "assistant", eventAtUtc: "2026-08-19T02:01:00.000Z", text: "Kimi 的回答" },
      ],
    });
    renderPage();

    expect(
      await screen.findByRole("heading", { name: /现在有以主板内存显卡/ })
    ).toBeInTheDocument();
    expect(screen.getByText("/work/craft-game/neicun-xianka")).toBeInTheDocument();
    expect(screen.getByText("4 个 agent")).toBeInTheDocument();
    expect(screen.getByText("问了 2 次")).toBeInTheDocument();
    expect(screen.getByText("我的问题")).toBeInTheDocument();
    expect(screen.getByText("Kimi 的回答")).toBeInTheDocument();
    expect(screen.getByText("我")).toBeInTheDocument();
    expect(screen.getByText("Kimi")).toBeInTheDocument();
  });

  it("含多个 agent 的长会话照常渲染,不崩", async () => {
    const messages = Array.from({ length: 303 }, (_, i) => ({
      id: i + 1,
      role: i % 2 === 0 ? "user" : "assistant",
      eventAtUtc: "2026-08-19T02:00:00.000Z",
      text: `第 ${i + 1} 条`,
    }));
    stub(200, { ok: true, session: { ...SESSION, agentCount: 8 }, messages });
    renderPage();

    expect(await screen.findByText("第 1 条")).toBeInTheDocument();
    expect(screen.getByText("第 303 条")).toBeInTheDocument();
    expect(screen.getByText("共 303 条正文")).toBeInTheDocument();
    expect(screen.getByText("8 个 agent")).toBeInTheDocument();
  });

  it("会话存在但没有可读正文 → 空态,不是错误", async () => {
    stub(200, {
      ok: true,
      session: { ...SESSION, humanMessageCount: 0, totalMessageCount: 2, title: "New Session" },
      messages: [],
    });
    renderPage();

    expect(await screen.findByText("这场会话没有可读的正文")).toBeInTheDocument();
    expect(screen.getByText(/全是工具调用与系统事件/)).toBeInTheDocument();
    // 标题仍在 —— 用户能看出这是哪一场,而不是一个错误页。
    expect(screen.getByRole("heading", { name: "New Session" })).toBeInTheDocument();
  });

  it("会话不存在 → 显示后端的错误信息", async () => {
    stub(404, { error: { message: "session not found" } });
    renderPage("nope");
    expect(await screen.findByText("session not found")).toBeInTheDocument();
    expect(screen.queryByText("这场会话没有可读的正文")).not.toBeInTheDocument();
  });

  it("有返回列表的入口", async () => {
    stub(200, { ok: true, session: SESSION, messages: [] });
    renderPage();
    const back = await screen.findByRole("link", { name: /返回列表/ });
    expect(back).toHaveAttribute("href", "/kimi-history");
  });
});
