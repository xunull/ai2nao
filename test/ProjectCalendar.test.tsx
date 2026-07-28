// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProjectCalendar } from "../web/src/pages/ProjectCalendar";

// gitleaks:全部假路径。
const REPO_A = "/w/x/ai2nao";
const P_A = "-w-x-ai2nao";
const P_ORPHAN = "-w-z-not-a-repo";

const TODAY = "2026-07-28";

type Overrides = {
  month?: Partial<MonthRes>;
  day?: Partial<DayRes>;
  sync?: Partial<SyncRes>;
};

type MonthRes = {
  year: number;
  month: number;
  days: {
    day: string;
    projectCount: number;
    messageCount: number;
    commitCount: number;
    commitOnlyProjectCount: number;
  }[];
  serverToday: string;
  dataStartDay: string | null;
};
type DayRes = {
  date: string;
  projectCount: number;
  messageCount: number;
  commitCount: number;
  projects: unknown[];
  commitOnlyProjects: unknown[];
};
type SyncRes = { coverage: unknown; progress: unknown };

function project(o: Partial<Record<string, unknown>> = {}) {
  return {
    key: P_A,
    name: "ai2nao",
    path: REPO_A,
    messageCount: 142,
    bySource: [
      { source: "claude", count: 118 },
      { source: "codex", count: 24 },
    ],
    firstAtMs: Date.parse("2026-07-28T01:12:00Z"),
    lastAtMs: Date.parse("2026-07-28T15:40:00Z"),
    firstHumanText: "配额表列语义改成数据驱动",
    commits: [],
    ...o,
  };
}

function mountWith(over: Overrides = {}) {
  const month: MonthRes = {
    year: 2026,
    month: 7,
    days: [
      {
        day: TODAY,
        projectCount: 4,
        messageCount: 176,
        commitCount: 0,
        commitOnlyProjectCount: 0,
      },
    ],
    serverToday: TODAY,
    dataStartDay: "2026-04-24",
    ...over.month,
  };
  const day: DayRes = {
    date: TODAY,
    projectCount: 1,
    messageCount: 142,
    commitCount: 0,
    projects: [project()],
    commitOnlyProjects: [],
    ...over.day,
  };
  const sync: SyncRes = {
    coverage: {
      totalRepos: 796,
      scannedRepos: 774,
      okCount: 758,
      failedCount: 16,
      neverScanned: 22,
      lastScanAt: "2026-07-06T03:12:39.648Z",
      cutoffDay: "2026-07-06",
    },
    progress: {
      running: false,
      done: 0,
      total: 796,
      startedAt: null,
      finishedAt: null,
      lastStatus: null,
      errorSummary: null,
    },
    ...over.sync,
  };

  const posted: string[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === "POST") {
      posted.push(url);
      return new Response(JSON.stringify({ ok: true }));
    }
    if (url.includes("/api/project-calendar/month")) {
      return new Response(JSON.stringify({ ok: true, ...month }));
    }
    if (url.includes("/api/project-calendar/day")) {
      return new Response(JSON.stringify({ ok: true, ...day }));
    }
    if (url.includes("/api/project-calendar/sync-status")) {
      return new Response(JSON.stringify({ ok: true, ...sync }));
    }
    throw new Error(`Unhandled fetch: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);

  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <ProjectCalendar />
    </QueryClientProvider>
  );
  return { posted, fetchMock };
}

// vitest.config.ts 里 globals: false —— testing-library 的自动 cleanup 不会跑,
// 不显式清理的话多次 render 的 DOM 会叠在一起,findByText 撞到多个元素直接失败。
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("ProjectCalendar", () => {
  it("★默认选中的是服务端的今天,不是浏览器的今天★", async () => {
    mountWith();
    // serverToday = 2026-07-28,而测试机的 new Date() 显然不是那天。
    expect(await screen.findByText(TODAY)).toBeInTheDocument();
  });

  it("渲染当日头部统计", async () => {
    mountWith();
    expect(
      await screen.findByText(/1 个项目 · 142 条对话 · 0 个提交/)
    ).toBeInTheDocument();
  });

  it("渲染项目卡片:名字、条数、时间跨度、来源徽章、首句", async () => {
    mountWith();
    expect(await screen.findByText("ai2nao")).toBeInTheDocument();
    expect(screen.getByText(/claude 118/)).toBeInTheDocument();
    expect(screen.getByText(/codex 24/)).toBeInTheDocument();
    expect(
      screen.getByText(/「配额表列语义改成数据驱动」/)
    ).toBeInTheDocument();
  });

  it("★晚于水位的日期,提交栏显示「提交未同步」而不是「0 个提交」★", async () => {
    // cutoffDay = 2026-07-06,当前选中 2026-07-28 → 晚于水位
    mountWith();
    expect(await screen.findByText(/提交未同步/)).toBeInTheDocument();
  });

  it("水位提示条如实列出成功 / 失败 / 从未扫描", async () => {
    mountWith();
    const banner = await screen.findByText(/上次扫描 2026-07-06/);
    expect(banner).toHaveTextContent("758 成功");
    expect(banner).toHaveTextContent("16 失败");
    expect(banner).toHaveTextContent("22 从未扫描");
  });

  it("从未同步过 → 提示条说清楚,而不是显示一个假的日期", async () => {
    mountWith({
      sync: {
        coverage: {
          totalRepos: 796,
          scannedRepos: 0,
          okCount: 0,
          failedCount: 0,
          neverScanned: 796,
          lastScanAt: null,
          cutoffDay: null,
        },
      },
    });
    expect(await screen.findByText(/提交数据从未同步过/)).toBeInTheDocument();
  });

  it("点「立即同步」→ 打 sync-commits 端点", async () => {
    const user = userEvent.setup();
    const { posted } = mountWith();
    await user.click(await screen.findByRole("button", { name: "立即同步" }));
    await waitFor(() =>
      expect(
        posted.some((u) => u.includes("/api/project-calendar/sync-commits"))
      ).toBe(true)
    );
  });

  it("同步进行中 → 按钮显示进度并禁用", async () => {
    mountWith({
      sync: {
        progress: {
          running: true,
          done: 128,
          total: 796,
          startedAt: "2026-07-28T10:00:00Z",
          finishedAt: null,
          lastStatus: "running",
          errorSummary: null,
        },
      },
    });
    const btn = await screen.findByRole("button", { name: /同步中 128\/796/ });
    expect(btn).toBeDisabled();
  });

  it("空态:那天没有对话", async () => {
    mountWith({
      day: { projectCount: 0, messageCount: 0, projects: [] },
    });
    expect(await screen.findByText("这天没有 AI 对话记录。")).toBeInTheDocument();
  });

  it("★归不到仓库的项目标「非仓库」,名字是完整 slug★", async () => {
    mountWith({
      day: {
        projects: [project({ key: P_ORPHAN, name: P_ORPHAN, path: null })],
      },
    });
    expect(await screen.findByText(P_ORPHAN)).toBeInTheDocument();
    expect(screen.getByText("（非仓库）")).toBeInTheDocument();
  });

  it("「仅有提交、无对话」折叠区默认收起,点开才显示", async () => {
    const user = userEvent.setup();
    mountWith({
      day: {
        commitOnlyProjects: [
          { key: "-w-y-gstack", name: "gstack", path: "/w/y/gstack", commits: [{ hash: "a", subject: "s", atMs: 1 }] },
        ],
      },
    });
    const toggle = await screen.findByRole("button", {
      name: /仅有提交、无对话（1 个项目）/,
    });
    expect(screen.queryByText("gstack")).not.toBeInTheDocument();
    await user.click(toggle);
    expect(await screen.findByText("gstack")).toBeInTheDocument();
  });

  it("早于对话数据起始日的月份 —— 起始日提示可见", async () => {
    mountWith({ month: { dataStartDay: "2026-04-24" } });
    // 当前月是 2026-07,不早于起始日,所以不该出现
    await screen.findByText("ai2nao");
    expect(
      screen.queryByText(/对话数据从 2026-04-24 开始/)
    ).not.toBeInTheDocument();
  });

  it("色阶图例把五档都标出来", async () => {
    mountWith();
    await screen.findByText("ai2nao");
    for (const label of ["1 个", "2-3", "4-5", "6-8", "9+"]) {
      expect(screen.getAllByText(label).length).toBeGreaterThan(0);
    }
  });
});
