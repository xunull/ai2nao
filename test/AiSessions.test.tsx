// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AiSessions } from "../web/src/pages/AiSessions";

/**
 * 每日会话页的下钻区：按工作目录分组。
 *
 * 这个文件是本轮改动**唯一**的守卫 —— 分组/排序/折叠/三态/组内封顶全在
 * `AiSessions.tsx` 里，query 层一行都不改。同族的 AiRhythm / ProjectCalendar /
 * WorkTokensTrend 都有组件测试，只有 AiSessions 没有（对抗性冷读抓到的）。
 *
 * fixture 全自造 —— **公开仓库禁止真实 home 路径**，而且 claude 的
 * `source_session_id` 内嵌 `-Users-<用户名>-…` 连字符形式，
 * `.gitleaks.toml` 的规则匹配的是 `/Users/…` 斜杠形式，**抓不到**。
 */

const RAW_FETCH = globalThis.fetch;
afterEach(() => {
  cleanup();
  globalThis.fetch = RAW_FETCH;
  vi.restoreAllMocks();
});

const jsonResponse = (body: unknown): Response =>
  new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });

type Sess = {
  source: string;
  sessionId: string;
  messages: number;
  title: string | null;
  activeMs: number | null;
  projectPath: string | null;
};

const sess = (o: Partial<Sess> & { sessionId: string }): Sess => ({
  source: "claude",
  messages: 10,
  title: `标题 ${o.sessionId}`,
  activeMs: 600_000,
  projectPath: "/work/app",
  ...o,
});

/** 图上只有一天，且那天有会话，这样点柱子必然落到 DAY。 */
const DAY = "2026-06-15";

function mockApi(daySessions: Sess[], byDay?: Record<string, Sess[]>): void {
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/api/ai-sessions/day/")) {
      const d = url.split("/day/")[1]!;
      return jsonResponse({ day: d, sessions: byDay?.[d] ?? daySessions });
    }
    return jsonResponse({
      window: "3m",
      from: DAY,
      to: "2026-06-16",
      active: Object.keys(byDay ?? { [DAY]: daySessions }).map((d) => ({
        day: d, sessions: 1, bySource: { claude: 1 },
      })),
      started: Object.keys(byDay ?? { [DAY]: daySessions }).map((d) => ({
        day: d, sessions: 1, bySource: { claude: 1 },
      })),
      coverage: { sources: ["claude", "codex", "kimi", "opencode"], note: "测试" },
    });
  }) as unknown as typeof fetch;
}

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <AiSessions />
    </QueryClientProvider>
  );
}

/** 点开那一天的下钻区。图表在 jsdom 里没有真实尺寸,所以直接调页面暴露的入口。 */
async function openDay(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await waitFor(() => expect(screen.getByTestId("open-day-" + DAY)).toBeInTheDocument());
  await user.click(screen.getByTestId("open-day-" + DAY));
  await waitFor(() => expect(screen.getByTestId("day-detail")).toBeInTheDocument());
}

const groupHeads = () => screen.queryAllByTestId(/^group-head-/);

describe("组头三态", () => {
  it("真路径 / kimi:conv-* / null 三种各自可区分,不合并", async () => {
    mockApi([
      sess({ sessionId: "a", projectPath: "/work/app" }),
      sess({ sessionId: "b", projectPath: "kimi:conv-fake", source: "kimi" }),
      sess({ sessionId: "c", projectPath: null, source: "kimi", title: null, activeMs: null }),
    ]);
    const user = userEvent.setup();
    renderPage();
    await openDay(user);

    // 三种状态必须是三个组 —— 合并任意两种都会让这条红。
    expect(groupHeads()).toHaveLength(3);
    expect(screen.getByText("/work/app")).toBeInTheDocument();
    expect(screen.getByText(/无工作目录/)).toBeInTheDocument();
    expect(screen.getByText(/无目录记录/)).toBeInTheDocument();
    // 后两者不能是同一句话 —— 一个是「设计如此」,一个是「数据缺失」。
    expect(screen.queryByText(/无工作目录/)).not.toBe(screen.queryByText(/无目录记录/));
  });

  /**
   * 冷读实测：同一天 SQL 的 COUNT(DISTINCT project_path) 给 7、
   * JS 的 new Set(paths).size 给 8，**正确答案是 8**（null 自成一组）。
   * 用 COUNT(DISTINCT) 的口径写实现,这条会红。
   */
  it("组头数 = 真目录数 + conv 各一组 + (有 null ? 1 : 0)", async () => {
    mockApi([
      sess({ sessionId: "a", projectPath: "/work/app" }),
      sess({ sessionId: "b", projectPath: "/work/app" }), // 同目录,不新增组
      sess({ sessionId: "c", projectPath: "/work/notes" }),
      sess({ sessionId: "d", projectPath: null }),
    ]);
    const user = userEvent.setup();
    renderPage();
    await openDay(user);

    expect(groupHeads()).toHaveLength(3); // app + notes + null
    expect(screen.getAllByTestId(/^group-head-/).filter((e) => /无目录记录/.test(e.textContent ?? "")))
      .toHaveLength(1);
  });
});

describe("排序", () => {
  it("组按会话数倒序;同数按组内最大消息数倒序", async () => {
    mockApi([
      sess({ sessionId: "s1", projectPath: "/work/big", messages: 5 }),
      sess({ sessionId: "s2", projectPath: "/work/big", messages: 4 }),
      // 字典序 aaa < zzz,但消息数 zzz(900) > aaa(3) —— **故意相反**。
      // 去掉 tie-break 就会退化成字典序,顺序变成 aaa,zzz,这条才有判别力。
      sess({ sessionId: "s3", projectPath: "/work/zzz", messages: 900 }),
      sess({ sessionId: "s4", projectPath: "/work/aaa", messages: 3 }),
    ]);
    const user = userEvent.setup();
    renderPage();
    await openDay(user);

    const labels = groupHeads().map((e) => e.getAttribute("data-path"));
    // big 有 2 场排第一;zzz 与 aaa 都是 1 场,zzz 的最大消息数更大排前面。
    expect(labels).toEqual(["/work/big", "/work/zzz", "/work/aaa"]);
  });

  it("组内按消息数倒序", async () => {
    mockApi([
      sess({ sessionId: "lo", projectPath: "/work/app", messages: 1, title: "少" }),
      sess({ sessionId: "hi", projectPath: "/work/app", messages: 99, title: "多" }),
    ]);
    const user = userEvent.setup();
    renderPage();
    await openDay(user);

    const rows = within(screen.getByTestId("group-body-/work/app")).getAllByRole("listitem");
    expect(rows[0]).toHaveTextContent("多");
    expect(rows[1]).toHaveTextContent("少");
  });
});

describe("折叠", () => {
  /**
   * 冷读实测：全量 809 个「天×目录」组里 617 个是单场组 = 76.3%。
   * 给单场组折叠三角省不下任何一行(组头本来就占一行),只是多要一次点击。
   */
  it("单场组内联,不给折叠三角", async () => {
    mockApi([sess({ sessionId: "only", projectPath: "/work/solo", title: "独一场" })]);
    const user = userEvent.setup();
    renderPage();
    await openDay(user);

    const head = screen.getByTestId("group-head-/work/solo");
    expect(head).toHaveTextContent("独一场"); // 标题就在组头行上
    expect(within(head).queryByRole("button")).toBeNull(); // 没有可点的折叠控件
  });

  it("首个多场组默认展开,其余折起", async () => {
    mockApi([
      sess({ sessionId: "a1", projectPath: "/work/first", messages: 9 }),
      sess({ sessionId: "a2", projectPath: "/work/first", messages: 8 }),
      sess({ sessionId: "b1", projectPath: "/work/second", messages: 7 }),
      sess({ sessionId: "b2", projectPath: "/work/second", messages: 6 }),
    ]);
    const user = userEvent.setup();
    renderPage();
    await openDay(user);

    expect(screen.queryByTestId("group-body-/work/first")).toBeInTheDocument();
    expect(screen.queryByTestId("group-body-/work/second")).toBeNull();

    // 组头是外层 div,可点的是里面那个 button(单场组没有 button,见上一条)。
    await user.click(within(screen.getByTestId("group-head-/work/second")).getByRole("button"));
    expect(screen.queryByTestId("group-body-/work/second")).toBeInTheDocument();
  });

  it("组内封顶 20 条,并显式说明总数(不静默截断)", async () => {
    mockApi(
      Array.from({ length: 25 }, (_, i) =>
        sess({ sessionId: `s${i}`, projectPath: "/work/app", messages: 100 - i })
      )
    );
    const user = userEvent.setup();
    renderPage();
    await openDay(user);

    const rows = within(screen.getByTestId("group-body-/work/app")).getAllByRole("listitem");
    expect(rows).toHaveLength(20);
    expect(screen.getByText(/共 25 场/)).toBeInTheDocument();
  });
});

describe("切换日期", () => {
  /**
   * 组件不卸载(`day` 只是一个 state),而日均 6.6 个目录里撞名是常态 ——
   * 不重置折叠态的话,上一天展开过的路径在新的一天还是展开的。
   */
  it("换一天后折叠态重置,只有新那天的首个多场组是展开的", async () => {
    const DAY2 = "2026-06-16";
    mockApi([], {
      [DAY]: [
        sess({ sessionId: "a1", projectPath: "/work/shared", messages: 9 }),
        sess({ sessionId: "a2", projectPath: "/work/shared", messages: 8 }),
        sess({ sessionId: "b1", projectPath: "/work/other", messages: 7 }),
        sess({ sessionId: "b2", projectPath: "/work/other", messages: 6 }),
      ],
      // 两天的**首个多场组是同一个路径**(/work/shared) —— 这样 firstMulti 不变,
      // 只有 `day` 真的在依赖里才会重置。否则这条测试是假绿(实测:把 day 从
      // deps 里删掉,用不同路径的 fixture 一条都不红)。
      [DAY2]: [
        sess({ sessionId: "c1", projectPath: "/work/shared", messages: 9 }),
        sess({ sessionId: "c2", projectPath: "/work/shared", messages: 8 }),
        sess({ sessionId: "d1", projectPath: "/work/other", messages: 3 }),
        sess({ sessionId: "d2", projectPath: "/work/other", messages: 2 }),
      ],
    });
    const user = userEvent.setup();
    renderPage();
    await openDay(user);
    // 在 DAY 上把第二个组也展开
    await user.click(within(screen.getByTestId("group-head-/work/other")).getByRole("button"));
    expect(screen.queryByTestId("group-body-/work/other")).toBeInTheDocument();

    await user.click(screen.getByTestId("open-day-" + DAY2));
    await waitFor(() => expect(screen.getByTestId("group-head-/work/other")).toBeInTheDocument());
    // 新那天:首个多场组(仍是 shared)展开,而上一天被手动展开过的 other 必须折起。
    expect(screen.queryByTestId("group-body-/work/shared")).toBeInTheDocument();
    expect(screen.queryByTestId("group-body-/work/other")).toBeNull();
  });
});

describe("下钻区独立滚动", () => {
  /**
   * 这条是本轮的主约束。冷读实测:1280×860 下平铺版 1.42 屏、
   * 上一稿的分组提案 1.99 屏。靠封顶数字治不住(16 个组头本身就超),
   * 只有把下钻区从页面滚动里摘出来才是结构性的。
   */
  it("下钻区自带 max-h 与 overflow-y-auto,不把页面撑开", async () => {
    mockApi([sess({ sessionId: "a" })]);
    const user = userEvent.setup();
    renderPage();
    await openDay(user);

    const panel = screen.getByTestId("day-detail-scroll");
    expect(panel.className).toMatch(/overflow-y-auto/);
    expect(panel.className).toMatch(/max-h-/);
  });
});
