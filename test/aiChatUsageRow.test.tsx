// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import React from "react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AiChatSessionUsage } from "../web/src/aiChat/types";

/**
 * 一轮的用量行。
 *
 * 盯的都是**截图上看不出来**的错:
 * - 不只在该轮最后一条上渲染 → 同一笔钱在一轮里出现好几次;
 * - `≥` 漏了 → 把下限说成实数;
 * - 未定价 / 未知渲染成 `$0.00` → 把「不知道」说成「没花钱」。
 */

const state = vi.hoisted(() => ({ value: { usage: null as AiChatSessionUsage | null, error: null, refresh: vi.fn() } }));
vi.mock("../web/src/aiChat/usageContext", () => ({ useAiChatUsage: () => state.value }));

const { ChatUsageRow } = await import("../web/src/aiChat/ChatUsageRow");

afterEach(() => {
  cleanup();
  state.value = { usage: null, error: null, refresh: vi.fn() };
});

const call = (over: Record<string, unknown> = {}) => ({
  callId: "c:r1:answer:0:0",
  purpose: "answer",
  stepIndex: 0,
  attempt: 0,
  status: "completed",
  model: null,
  usage: { input: 100, noCache: 100, cacheRead: 20, cacheWrite: 0, output: 50, reasoning: 0 },
  costUsd: 0.0011,
  costState: "priced",
  startedAt: "2026-09-18T00:00:00.000Z",
  endedAt: "2026-09-18T00:00:01.000Z",
  ...over,
});

function seed(over: { atLeast?: boolean; calls?: unknown[]; displayMessageId?: string | null } = {}) {
  state.value = {
    usage: {
      byRun: {
        "r1": {
          displayMessageId: over.displayMessageId === undefined ? "a:r1:answer:0" : over.displayMessageId,
          calls: (over.calls ?? [call()]) as never,
          totals: {
            input: 100, output: 50, reasoning: 0, cacheRead: 20, cacheWrite: 0,
            costUsd: 0.0011, atLeast: over.atLeast ?? false,
          },
        },
      },
      byAssistantMessage: {
        "a:r1:answer:0": { runId: "r1", callIds: ["c:r1:answer:0:0"] },
        "a:r1:answer:1": { runId: "r1", callIds: ["c:r1:answer:0:0"] },
      },
      byReasoningMessage: {},
      session: {
        input: 100, output: 50, reasoning: 0, cacheRead: 20, cacheWrite: 0, costUsd: 0.0011, atLeast: false,
        costStates: { pending: 0, unknown: 0, unpriced: 0, partial: 0, priced: 1 },
      },
      context: null,
      compactions: { stack: [], events: [] },
    } as unknown as AiChatSessionUsage,
    error: null,
    refresh: state.value.refresh,
  };
}

describe("一轮用量行", () => {
  it("没有用量数据时什么都不渲染", () => {
    const { container } = render(<ChatUsageRow messageId="a:r1:answer:0" />);
    expect(container).toBeEmptyDOMElement();
  });

  it("★ 只在该轮最后一条上渲染 —— 否则同一笔钱会显示好几次", () => {
    seed();
    const { container } = render(<ChatUsageRow messageId="a:r1:answer:1" />);
    // a:r1:answer:1 属于同一轮,但不是 displayMessageId。
    expect(container).toBeEmptyDOMElement();
  });

  it("在 displayMessageId 上显示整轮合计", () => {
    seed();
    render(<ChatUsageRow messageId="a:r1:answer:0" />);
    expect(screen.getByText(/输入 100/)).toBeInTheDocument();
    expect(screen.getByText(/输出 50/)).toBeInTheDocument();
    expect(screen.getByText(/\$0\.0011/)).toBeInTheDocument();
  });

  it("★ atLeast 时加 `≥` —— 漏了就把下限说成实数", () => {
    seed({ atLeast: true });
    render(<ChatUsageRow messageId="a:r1:answer:0" />);
    expect(screen.getByText(/≥\$0\.0011/)).toBeInTheDocument();
  });

  it("★ 明细里 未定价 / 未知 不能显示成 $0.00", async () => {
    seed({
      calls: [
        call({ callId: "c1", costState: "unpriced", costUsd: null }),
        call({ callId: "c2", costState: "unknown", costUsd: null }),
        call({ callId: "c3", costState: "pending", costUsd: null }),
      ],
    });
    render(<ChatUsageRow messageId="a:r1:answer:0" />);
    await userEvent.click(screen.getByRole("button", { name: "明细" }));
    expect(screen.getByText("未定价")).toBeInTheDocument();
    // unknown 与 pending 都是「厂商没报 / 还没结算」,显示 —— 而不是 $0.00。
    expect(screen.getAllByText("—")).toHaveLength(2);
    expect(screen.queryByText("$0.00")).not.toBeInTheDocument();
  });

  it("★ 已取消但已计费:合计用 amber 写「已取消 · 已计费」,是唯一上色的用量状态", () => {
    seed({ calls: [call({ status: "aborted", costUsd: 0.0011 })] });
    render(<ChatUsageRow messageId="a:r1:answer:0" />);
    const tag = screen.getByText(/已取消 · 已计费/);
    expect(tag).toHaveTextContent("已取消 · 已计费 $0.0011");
    expect(tag.className).toContain("amber");
  });

  it("★ 取消了但厂商没报用量(花费未知)时不说「已计费」—— 不知道就不编", () => {
    seed({ calls: [call({ status: "aborted", costUsd: null, costState: "unknown" })] });
    render(<ChatUsageRow messageId="a:r1:answer:0" />);
    expect(screen.queryByText(/已计费/)).not.toBeInTheDocument();
  });

  it("明细里的步骤用人话、从 1 数;补答不带序号", async () => {
    seed({
      calls: [
        call({ callId: "c0", stepIndex: 0, attempt: 1 }),
        call({ callId: "c1", purpose: "finalize", stepIndex: 0 }),
      ],
    });
    render(<ChatUsageRow messageId="a:r1:answer:0" />);
    await userEvent.click(screen.getByRole("button", { name: "明细" }));
    const rows = screen.getAllByRole("row").slice(1).map((r) => r.textContent ?? "");
    expect(rows[0]).toMatch(/^回答 12/); // 步骤「回答 1」、尝试「2」(账本里是 attempt 1)
    expect(rows[1]).toMatch(/^补答1/);
  });
});
