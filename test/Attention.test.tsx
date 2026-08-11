// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { Attention } from "../web/src/pages/Attention";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const DAY = "2026-08-10";
const at = (h: number, mi = 0): number =>
  new Date(2026, 7, 10, h, mi, 0, 0).getTime();

type StatusOver = Partial<{
  status: string;
  message: string;
  action: string;
  spanCount: number;
  lastSuccessAt: string | null;
}>;

function span(o: Partial<Record<string, unknown>> = {}) {
  return {
    id: 1,
    bundleId: "com.example.editor",
    appName: "Example Editor",
    startMs: at(9),
    endMs: at(10),
    durationMs: 3600_000,
    partIndex: 0,
    mergedFrom: 1,
    events: [],
    ...o,
  };
}

function mountWith(opts: {
  status?: StatusOver;
  spans?: ReturnType<typeof span>[];
  unattributed?: number;
} = {}) {
  const spans = opts.spans ?? [];
  const totalMs = spans.reduce((a, s) => a + (s.durationMs as number), 0);
  const status = {
    status: "ok",
    message: "数据源可读，同步正常。",
    sourcePath: "/fake/knowledgeC.db",
    runtime: "packaged-app",
    lastSuccessAt: "2026-08-10T12:00:00Z",
    lastRunAt: "2026-08-10T12:00:00Z",
    spanCount: spans.length,
    coverageFromMs: null,
    coverageToMs: null,
    ...opts.status,
  };

  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/api/attention/status")) {
      return new Response(
        JSON.stringify({
          ok: status.status === "ok",
          status,
          unsupportedSources: [
            { source: "atuin", reason: "是聚合表而不是事件表，答不了区间内跑了哪几条命令" },
          ],
        })
      );
    }
    if (url.includes("/api/attention/days")) {
      return new Response(
        JSON.stringify({ ok: true, days: [{ day: DAY, spans: spans.length, total_ms: totalMs }] })
      );
    }
    if (url.includes("/api/attention/day")) {
      return new Response(
        JSON.stringify({
          ok: true,
          day: {
            localDay: DAY,
            totalMs,
            spanCount: spans.length,
            spans,
            byBundle: spans.length
              ? [
                  {
                    bundleId: "com.example.editor",
                    appName: "Example Editor",
                    totalMs,
                    spanCount: spans.length,
                  },
                ]
              : [],
            eventCounts: { commit: 1, visit: 2, token: 3, message: 4 },
            unattributedEvents: opts.unattributed ?? 0,
          },
          unsupportedSources: [],
        })
      );
    }
    throw new Error(`Unhandled fetch: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);

  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <Attention />
      </MemoryRouter>
    </QueryClientProvider>
  );
  return { fetchMock };
}

describe("Attention —— 五态各自说清楚为什么是空的", () => {
  it("未授权时点名该授权给谁，而不是一片空白", async () => {
    mountWith({
      status: {
        status: "not_authorized",
        message: "knowledgeC 存在但一个字节都读不到。",
        action: "菜单栏「服务 → 完全磁盘访问设置…」可以直接打开那个面板。",
        spanCount: 0,
      },
    });
    await waitFor(() => expect(screen.getByText(/一个字节都读不到/)).toBeInTheDocument());
    expect(screen.getByText(/完全磁盘访问设置/)).toBeInTheDocument();
    expect(screen.getByText("not_authorized")).toBeInTheDocument();
  });

  it("任务从没跑过时引导去 scheduler", async () => {
    mountWith({
      status: {
        status: "never_run",
        message: "数据源可读，但同步任务从没成功跑过。",
        action: "去 /scheduler 启用 attention.sync。",
        spanCount: 0,
        lastSuccessAt: null,
      },
    });
    await waitFor(() => expect(screen.getByText(/从没成功跑过/)).toBeInTheDocument());
    expect(screen.getByText(/scheduler/)).toBeInTheDocument();
  });

  it("非打包运行时说明为什么只支持桌面版", async () => {
    mountWith({
      status: {
        status: "unsupported_runtime",
        message: "注意力层只在打包的 ai2nao.app 里启用。",
        action: "用 make app 打包后运行。",
        spanCount: 0,
      },
    });
    await waitFor(() =>
      expect(screen.getByText(/只在打包的 ai2nao\.app 里启用/)).toBeInTheDocument()
    );
  });

  it("停更时把最后一次成功时间摆出来", async () => {
    mountWith({
      status: {
        status: "stale",
        message: "同步任务曾经成功过，但最后一次是 5 天前。",
        spanCount: 0,
      },
    });
    await waitFor(() => expect(screen.getByText(/5 天前/)).toBeInTheDocument());
    expect(screen.getByText(/最后一次成功同步/)).toBeInTheDocument();
  });

  it("列出暂时接不上的数据源，而不是假装那段时间什么都没做", async () => {
    mountWith({ status: { status: "never_run", message: "x", spanCount: 0 } });
    await waitFor(() => expect(screen.getByText(/聚合表/)).toBeInTheDocument());
    expect(screen.getByText("atuin")).toBeInTheDocument();
  });
});

describe("Attention —— 有数据时", () => {
  it("渲染时间带、时长排行和交叉计数", async () => {
    mountWith({ spans: [span()] });
    await waitFor(() => expect(screen.getByText("Example Editor")).toBeInTheDocument());
    // 总时长在 toolbar、排行、日期下拉里各出现一次 —— 断言它确实渲染了就够。
    expect(screen.getAllByText("1.0 小时").length).toBeGreaterThan(0);
    expect(screen.getByText("1 段")).toBeInTheDocument();
    // 四类交叉计数各自可见。
    expect(screen.getByText(/提交 1/)).toBeInTheDocument();
    expect(screen.getByText(/浏览 2/)).toBeInTheDocument();
    expect(screen.getByText(/Token 3/)).toBeInTheDocument();
    expect(screen.getByText(/提问 4/)).toBeInTheDocument();
  });

  it("把未归属事件显式摆出来", async () => {
    // 不显示的话，交叉结果看起来比实际完整 —— 三成事件不知道当时人在哪。
    mountWith({ spans: [span()], unattributed: 271 });
    await waitFor(() => expect(screen.getByText(/未归属 271/)).toBeInTheDocument());
  });

  it("没有未归属事件时不显示那个提示", async () => {
    mountWith({ spans: [span()], unattributed: 0 });
    await waitFor(() => expect(screen.getByText("Example Editor")).toBeInTheDocument());
    expect(screen.queryByText(/未归属/)).not.toBeInTheDocument();
  });

  it("点一段之后右侧出该段的证据", async () => {
    mountWith({
      spans: [
        span({
          events: [
            { kind: "commit", atMs: at(9, 30), label: "修好那个东西", detail: "repo-a +12/-3" },
            { kind: "token", atMs: at(9, 40), label: "Claude × 7", detail: "in 3,068,620 / out 15,614" },
          ],
        }),
      ],
    });
    await waitFor(() => expect(screen.getByText("Example Editor")).toBeInTheDocument());
    expect(screen.getByText(/点上面时间带里的任意一段/)).toBeInTheDocument();

    const bar = document.querySelector("button[title*='Example Editor']");
    expect(bar).not.toBeNull();
    await userEvent.click(bar as Element);

    await waitFor(() => expect(screen.getByText("修好那个东西")).toBeInTheDocument());
    expect(screen.getByText("Claude × 7")).toBeInTheDocument();
    expect(screen.getByText(/09:00–10:00/)).toBeInTheDocument();
  });

  it("选中一段没有证据时说清楚，并提醒缺口", async () => {
    mountWith({ spans: [span({ events: [] })] });
    await waitFor(() => expect(screen.getByText("Example Editor")).toBeInTheDocument());
    await userEvent.click(document.querySelector("button[title*='Example Editor']") as Element);
    await waitFor(() =>
      expect(screen.getByText(/这一段里没有可交叉的事件/)).toBeInTheDocument()
    );
  });

  it("这一天没有记录时说明可能的原因", async () => {
    mountWith({ spans: [] });
    await waitFor(() =>
      expect(screen.getByText(/这天没有记录/)).toBeInTheDocument()
    );
  });
});
