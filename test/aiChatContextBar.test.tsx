// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import React from "react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AiChatContextView, AiChatSessionUsage } from "../web/src/aiChat/types";

/**
 * 上下文占用条。
 *
 * 盯的都是**静默错**:窗口未知时把 null 当 0 会显示「已用 100%」;折叠点为 null 时
 * 按钮若没置灰,点下去会把 `undefined` 发给后端;`≈` 漏了的话用户会把估算当实测;
 * 路由返回的可操作文案被换成 `Conflict`,用户就不知道该做什么。
 */

const fresh = () => ({
  sessionId: "s1",
  usage: null as AiChatSessionUsage | null,
  error: null as string | null,
  refresh: vi.fn(),
  notifyCompactionChanged: vi.fn(),
});
const state = vi.hoisted(() => ({ value: null as unknown as ReturnType<typeof fresh> }));
vi.mock("../web/src/aiChat/usageContext", () => ({
  useAiChatUsage: () => state.value,
}));

const { ChatContextBar } = await import("../web/src/aiChat/ChatContextBar");

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const ctx = (over: Partial<AiChatContextView> = {}): AiChatContextView => ({
  model: { provider: "p", model: "m", label: "L" },
  contextWindow: 100_000,
  outputReserve: 8192,
  estimatedInput: 3_000,
  estimateOnly: false,
  breakdown: { system: 500, summary: 0, recent: 2_000, toolResults: 500, images: 0 },
  breakdownTotal: 3_000,
  toolResultsOmitted: false,
  autoCompaction: true,
  suggestedCompactUpTo: 12,
  compactCostEstimateUsd: null,
  ...over,
});

function mount(over: Partial<AiChatContextView> = {}) {
  state.value = { ...fresh(), usage: { context: ctx(over) } as unknown as AiChatSessionUsage };
  return render(<ChatContextBar sessionId="s1" />);
}

/** 记录每次请求;`reply` 决定响应。 */
function stubFetch(reply: () => Response) {
  const calls: { url: string; method: string; body: unknown }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        url: String(input),
        method: String(init?.method ?? "GET"),
        body: JSON.parse(String(init?.body ?? "{}")),
      });
      return reply();
    })
  );
  return calls;
}
/** 压缩按钮:平时叫「立即压缩」,接近上限叫「现在压缩」。 */
const COMPACT = /^(立即|现在)压缩/;
const ok = () => new Response(JSON.stringify({}), { headers: { "Content-Type": "application/json" } });

describe("上下文占用条", () => {
  it("没有 context 时什么都不渲染 —— null 是「未知」,不是「占用为 0」", () => {
    state.value = fresh();
    const { container } = render(<ChatContextBar sessionId="s1" />);
    expect(container).toBeEmptyDOMElement();
  });

  it("★ 窗口未知:不显示百分比,也不画进度条", () => {
    const { container } = mount({ contextWindow: null });
    expect(screen.getByText(/窗口未知/)).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/%/);
  });

  it("窗口已知:显示百分比", () => {
    mount({ contextWindow: 100_000, estimatedInput: 3_000 });
    expect(screen.getByText(/3%/)).toBeInTheDocument();
  });

  it("★ 纯估算加 `≈`,实测不加", () => {
    const { container, unmount } = mount({ estimateOnly: true });
    expect(container.textContent).toContain("≈");
    unmount();
    expect(mount({ estimateOnly: false }).container.textContent).not.toContain("≈");
  });

  it("★ 超窗时百分比照实显示(>100%),不钳到 100 —— 这是刻意的", () => {
    mount({ contextWindow: 10_000, estimatedInput: 14_000 });
    expect(screen.getByText(/140%/)).toBeInTheDocument();
  });

  it("★ 折叠点为 null 时按钮置灰 —— 否则会把 undefined 发给后端", () => {
    mount({ suggestedCompactUpTo: null });
    expect(screen.getByRole("button", { name: COMPACT })).toBeDisabled();
  });

  it("★ 点「现在压缩」用的是后端给的折叠点,成功后通知重挂聊天区", async () => {
    const calls = stubFetch(ok);
    mount({ suggestedCompactUpTo: 42 });
    await userEvent.click(screen.getByRole("button", { name: COMPACT }));
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toContain("/compact/s1");
    expect(calls[0]!.body).toEqual({ upToMessageIndex: 42 });
    // 只刷新用量不够:聊天区还拿着折叠前的消息,必须重挂才会重新 connect。
    expect(state.value.notifyCompactionChanged).toHaveBeenCalledTimes(1);
  });

  it("★ 路由的字符串错误原样显示,不被换成 Conflict", async () => {
    stubFetch(
      () =>
        new Response(JSON.stringify({ error: "这个会话正在生成回答，请等它结束后再压缩。" }), {
          status: 409,
          headers: { "Content-Type": "application/json" },
        })
    );
    mount();
    await userEvent.click(screen.getByRole("button", { name: COMPACT }));
    expect(await screen.findByRole("alert")).toHaveTextContent("正在生成回答");
    expect(state.value.notifyCompactionChanged).not.toHaveBeenCalled();
  });

  it("★ 点数字弹出分项;对得上基准时说明口径不同", async () => {
    mount({ estimateOnly: false });
    expect(screen.queryByText("近期对话")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /上下文/ }));
    expect(screen.getByText("近期对话")).toBeInTheDocument();
    expect(screen.getByText("工具结果")).toBeInTheDocument();
    expect(screen.getByText(/口径|不必相加/)).toBeInTheDocument();
  });

  it("★ 自动压缩关着:常驻「自动压缩已关 · 恢复」,点恢复发 {auto:true}", async () => {
    const calls = stubFetch(ok);
    mount({ autoCompaction: false });
    expect(screen.getByText("自动压缩已关")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "恢复" }));
    expect(calls[0]!.method).toBe("PATCH");
    expect(calls[0]!.url).toContain("/api/llm-chat/sessions/s1/compaction-settings");
    expect(calls[0]!.body).toEqual({ auto: true });
    expect(state.value.refresh).toHaveBeenCalled();
  });

  it("★ 每个按钮都带 pointer-events-auto —— CopilotKit 的 disclaimer 容器是 pointer-events-none", () => {
    // 真实浏览器走查实测:不加这个类,按钮的 pointer-events 继承成 none,点击穿透到消息区。
    // jsdom 不算 CopilotKit 的 CSS,所以这里只能守「类还在」;真正的点击由走查脚本验证。
    mount({ autoCompaction: false, contextWindow: 10_000, estimatedInput: 9_500 });
    const buttons = screen.getAllByRole("button");
    expect(buttons.length).toBeGreaterThanOrEqual(3);
    for (const b of buttons) expect(b.className).toContain("pointer-events-auto");
  });

  it("★ 开着且接近上限:给「本会话不自动压缩」,发 {auto:false};不接近上限时不给", async () => {
    const calls = stubFetch(ok);
    const { unmount } = mount({ autoCompaction: true, contextWindow: 10_000, estimatedInput: 9_500 });
    await userEvent.click(screen.getByRole("button", { name: "本会话不自动压缩" }));
    expect(calls[0]!.body).toEqual({ auto: false });
    unmount();
    mount({ autoCompaction: true, contextWindow: 100_000, estimatedInput: 3_000 });
    expect(screen.queryByRole("button", { name: "本会话不自动压缩" })).not.toBeInTheDocument();
  });

  it("★ 平时写「立即压缩（约 $X）」;估不出价只写「立即压缩」;接近上限写「现在压缩」", () => {
    const { unmount } = mount({ compactCostEstimateUsd: 0.0123 });
    // 规格:压缩会调外部模型、会花钱 —— 点之前就得看见大概多少。
    expect(screen.getByRole("button", { name: "立即压缩（约 $0.012）" })).toBeInTheDocument();
    unmount();

    // 缺价格:不编一个 $0。
    const second = mount({ compactCostEstimateUsd: null });
    expect(screen.getByRole("button", { name: "立即压缩" })).toBeInTheDocument();
    second.unmount();

    mount({ contextWindow: 10_000, estimatedInput: 9_500, compactCostEstimateUsd: 0.0123 });
    expect(screen.getByRole("button", { name: "现在压缩" })).toBeInTheDocument();
  });

  it("★ 压缩进行中按钮原位显示「压缩中…」;开关动作不借用这个字样", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        await gate;
        return ok();
      })
    );
    const { unmount } = mount({ autoCompaction: false });
    await userEvent.click(screen.getByRole("button", { name: COMPACT }));
    expect(screen.getByRole("button", { name: "压缩中…" })).toBeDisabled();
    release();
    await screen.findByRole("button", { name: COMPACT });
    unmount();

    // 点「恢复」时压缩按钮只置灰,不说自己在压缩。
    let release2!: () => void;
    const gate2 = new Promise<void>((r) => (release2 = r));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        await gate2;
        return ok();
      })
    );
    mount({ autoCompaction: false });
    await userEvent.click(screen.getByRole("button", { name: "恢复" }));
    expect(screen.queryByText("压缩中…")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: COMPACT })).toBeDisabled();
    release2();
  });

  it("★ 间距与按钮外观类带 `!` —— CopilotKit 对聊天区的元素级重置会把普通写法清零", () => {
    // jsdom 不加载 CopilotKit 的样式表,照不出被清零本身;这条只防有人把 `!` 顺手删掉。
    // 真正的验证在浏览器走查里(2026-09-19:去掉 `!` 时 padding 实测为 0)。
    const { container } = mount({ autoCompaction: true });
    expect((container.firstElementChild as HTMLElement).className).toMatch(/!px-4/);
    const btn = screen.getByRole("button", { name: COMPACT });
    expect(btn.className).toMatch(/!border /);
    expect(btn.className).toMatch(/!bg-white/);
  });
});

