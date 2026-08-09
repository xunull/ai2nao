// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Home } from "../web/src/pages/Home";

type Lead = {
  id: string;
  severity: "info" | "notable" | "warning";
  title: string;
  detail?: string;
  href: string;
  asOf: string;
};

function lead(over: Partial<Lead> = {}): Lead {
  return {
    id: "tokens.today",
    severity: "info",
    title: "今天 token 1.2M,比近 7 日中位数高 62%",
    href: "/dashboard/tokens-trend",
    asOf: "2026-08-09T02:00:00.000Z",
    ...over,
  };
}

function json(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function stub(payload: Record<string, unknown>) {
  vi.stubGlobal("fetch", vi.fn(async () => json({ ok: true, ...payload })));
}

function renderHome() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <Home />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

describe("首页「今天」", () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("渲染线索,每条都是能点的链接,指向后端给的 href", async () => {
    stub({
      leads: [
        lead({ id: "quota.low", severity: "warning", title: "额度只剩 6%", href: "/providers" }),
        lead(),
      ],
      overflow: 0,
      errors: [],
    });
    renderHome();

    const first = await screen.findByRole("link", { name: /额度只剩 6%/ });
    expect(first).toHaveAttribute("href", "/providers");
    expect(screen.getByRole("link", { name: /比近 7 日中位数高 62%/ })).toHaveAttribute(
      "href",
      "/dashboard/tokens-trend"
    );
  });

  it("detail 显示在标题旁边", async () => {
    stub({ leads: [lead({ detail: "中位数 740k" })], overflow: 0, errors: [] });
    renderHome();
    expect(await screen.findByText("中位数 740k")).toBeInTheDocument();
  });

  it("没有线索时摆兜底卡片,而不是一片空白", async () => {
    stub({ leads: [], overflow: 0, errors: [], fallbackCards: ["streak", "rhythm", "source-trend"] });
    renderHome();

    expect(await screen.findByText(/今天这台机器上没什么反常的/)).toBeInTheDocument();
    const imgs = screen.getAllByRole("presentation", { hidden: true });
    expect(imgs.map((i) => i.getAttribute("src"))).toEqual([
      "/api/cards/streak.svg",
      "/api/cards/rhythm.svg",
      "/api/cards/source-trend.svg",
    ]);
  });

  it("没有线索也没有卡片时,给一句话而不是空屏", async () => {
    stub({ leads: [], overflow: 0, errors: [] });
    renderHome();
    expect(await screen.findByText("今天这台机器上没什么反常的。")).toBeInTheDocument();
  });

  it("overflow > 0 时给一个可展开的「还有 N 条」,默认收起", async () => {
    stub({ leads: [lead()], overflow: 3, errors: [] });
    const user = userEvent.setup();
    renderHome();

    const more = await screen.findByRole("button", { name: "还有 3 条" });
    await user.click(more);
    expect(screen.getByText(/还有 3 条没那么要紧的/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "还有 3 条" })).not.toBeInTheDocument();
  });

  it("overflow 为 0 时不出现折叠区", async () => {
    stub({ leads: [lead()], overflow: 0, errors: [] });
    renderHome();
    await screen.findByRole("link", { name: /比近 7 日中位数高 62%/ });
    expect(screen.queryByText(/还有/)).not.toBeInTheDocument();
  });

  it("探针报错单独一行,不混进线索列表,也不占版面", async () => {
    stub({
      leads: [lead()],
      overflow: 0,
      errors: [
        { probeId: "atuin.newdirs", message: "no such table" },
        { probeId: "tools.new", message: "no such table" },
      ],
    });
    renderHome();

    expect(await screen.findByText(/有 2 个探针没跑起来/)).toBeInTheDocument();
    expect(screen.getByText(/atuin\.newdirs、tools\.new/)).toBeInTheDocument();
    // 关键:报错没有变成一条可点的线索。
    expect(screen.queryByRole("link", { name: /探针/ })).not.toBeInTheDocument();
    expect(screen.getAllByRole("link")).toHaveLength(1);
  });

  it("errors 为空时不显示那一行", async () => {
    stub({ leads: [lead()], overflow: 0, errors: [] });
    renderHome();
    await screen.findByRole("link", { name: /比近 7 日中位数高 62%/ });
    expect(screen.queryByText(/探针没跑起来/)).not.toBeInTheDocument();
  });

  it("加载中给出提示,不是空屏", () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
    renderHome();
    expect(screen.getByText(/正在看今天发生了什么/)).toBeInTheDocument();
  });

  it("请求失败时说清楚,不静默空屏", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("boom", { status: 500 })));
    renderHome();
    expect(await screen.findByText(/读取失败/)).toBeInTheDocument();
  });
});
