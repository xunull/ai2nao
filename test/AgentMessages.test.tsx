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

/**
 * role 筛选器(V53)。硬约束是**默认行为不变**:不选筛选器时请求里不该出现 role 参数,
 * 后端拿不到就走 is_human=1,与加 AI 内容之前逐条一致。
 */
describe("AgentMessages — role 筛选器", () => {
  const AI_SEARCH = {
    ok: true,
    hits: [
      {
        id: 11,
        source: "claude",
        sourceSessionId: "s11",
        eventAtUtc: "2026-08-17T03:00:00Z",
        snippet: "水位是已经处理干净的时间点",
        role: "assistant",
        answering: "帮我看下 watermark",
      },
      {
        id: 12,
        source: "claude",
        sourceSessionId: "s12",
        eventAtUtc: "2026-08-17T04:00:00Z",
        snippet: "孤儿会话里的回答",
        role: "assistant",
        answering: null,
      },
    ],
  };

  /** 记下每次搜索请求的 URL,用来断言 role 参数。 */
  function routerCapturing(urls: string[]) {
    return (url: string): Response => {
      if (url.includes("/analytics")) return jsonResponse(ANALYTICS);
      if (url.includes("/list")) return jsonResponse(LIST);
      if (url.includes("/search")) {
        urls.push(url);
        return jsonResponse(url.includes("role=assistant") ? AI_SEARCH : SEARCH);
      }
      return jsonResponse({ ok: true });
    };
  }

  const search = (q: string) => {
    fireEvent.change(screen.getByPlaceholderText("搜我说过的话…"), {
      target: { value: q },
    });
    fireEvent.click(screen.getByRole("button", { name: "搜索" }));
  };

  it("默认不带 role 参数 —— 老行为一字不变", async () => {
    const urls: string[] = [];
    installFetchMock(routerCapturing(urls));
    renderPage();
    await waitFor(() => screen.getByText("浏览到的消息"));

    search("关键词");
    await waitFor(() => expect(urls.length).toBeGreaterThan(0));
    expect(urls[0]).not.toContain("role=");
  });

  it("切到「AI 说的」→ 请求带 role=assistant", async () => {
    const urls: string[] = [];
    installFetchMock(routerCapturing(urls));
    renderPage();
    await waitFor(() => screen.getByText("浏览到的消息"));

    fireEvent.change(screen.getByLabelText("搜谁说的话"), {
      target: { value: "assistant" },
    });
    search("水位");
    await waitFor(() => expect(urls.length).toBeGreaterThan(0));
    expect(urls[urls.length - 1]).toContain("role=assistant");
  });

  it("AI 命中显示「在回答」的提问上下文", async () => {
    installFetchMock(routerCapturing([]));
    renderPage();
    await waitFor(() => screen.getByText("浏览到的消息"));

    fireEvent.change(screen.getByLabelText("搜谁说的话"), {
      target: { value: "assistant" },
    });
    search("水位");

    await waitFor(() =>
      expect(screen.getByText(/在回答：帮我看下 watermark/)).toBeInTheDocument()
    );
    // AI 标记让人一眼分清是谁说的。
    expect(screen.getAllByText("AI").length).toBeGreaterThan(0);
  });

  // 没有锚点有两种成因(claude 孤儿会话 / codex subagent 会话),UI 分不出来,
  // 所以文案保持中性 —— 早先写死「已随源文件删除」,对 codex 那种是假话。
  it("没有锚点 → 中性文案,不编造原因", async () => {
    installFetchMock(routerCapturing([]));
    renderPage();
    await waitFor(() => screen.getByText("浏览到的消息"));

    fireEvent.change(screen.getByLabelText("搜谁说的话"), {
      target: { value: "assistant" },
    });
    search("水位");

    await waitFor(() =>
      expect(screen.getByText("没有关联的提问")).toBeInTheDocument()
    );
  });

  it("默认筛选下的空态提示切到「AI 说的」", async () => {
    installFetchMock((url) => {
      if (url.includes("/analytics")) return jsonResponse(ANALYTICS);
      if (url.includes("/list")) return jsonResponse(LIST);
      if (url.includes("/search")) return jsonResponse({ ok: true, hits: [] });
      return jsonResponse({ ok: true });
    });
    renderPage();
    await waitFor(() => screen.getByText("浏览到的消息"));

    search("查不到的词");
    await waitFor(() =>
      expect(screen.getByText(/试试切到「AI 说的」/)).toBeInTheDocument()
    );
  });
});
