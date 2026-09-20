// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 用量 context 的刷新时机。
 *
 * 规格:一轮结束、失败时都要刷新;左栏累计来自会话列表接口,所以还要通知页面刷新左栏。
 * 这些都是「漏了也不报错,只是数字不动」的那类问题。
 */

const a = vi.hoisted(() => {
  const s = { subscriber: null as null | Record<string, () => void>, unsubscribe: null as null | (() => void) };
  // 库里的 agent 是稳定对象;mock 也要稳定,否则每次渲染都重新订阅。
  const agent = {
    subscribe: (sub: Record<string, () => void>) => {
      s.subscriber = sub;
      const unsubscribe = () => {
        s.subscriber = null;
      };
      s.unsubscribe = unsubscribe;
      return { unsubscribe };
    },
  };
  return { s, agent };
});
vi.mock("@copilotkit/react-core/v2", () => ({ useAgent: () => ({ agent: a.agent }) }));

const { AiChatUsageProvider, useAiChatUsage } = await import("../web/src/aiChat/usageContext");

let usageCalls = 0;
/** 每次 /usage 依次返回的压缩栈(id 列表);用完了就是空栈。 */
let stackQueue: string[][] = [];
beforeEach(() => {
  usageCalls = 0;
  stackQueue = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (!url.includes("/usage")) throw new Error(`Unhandled fetch: ${url}`);
      usageCalls += 1;
      return new Response(
        JSON.stringify({
          usage: {
            session: { costUsd: usageCalls },
            compactions: { stack: (stackQueue.shift() ?? []).map((id) => ({ id })), events: [] },
          },
        }),
        { headers: { "Content-Type": "application/json" } }
      );
    })
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function Probe() {
  const { usage, notifyCompactionChanged, justCompactedId } = useAiChatUsage();
  return (
    <div>
      <span data-testid="cost">{String(usage?.session?.costUsd ?? "none")}</span>
      <span data-testid="just">{String(justCompactedId)}</span>
      <button type="button" onClick={notifyCompactionChanged}>
        changed
      </button>
    </div>
  );
}

describe("用量 context", () => {
  it("挂载时取一次", async () => {
    render(
      <AiChatUsageProvider sessionId="s1">
        <Probe />
      </AiChatUsageProvider>
    );
    await waitFor(() => expect(screen.getByTestId("cost")).toHaveTextContent("1"));
  });

  it("★ 一轮结束(以及失败)都重取,并通知页面刷新左栏", async () => {
    const onRunSettled = vi.fn();
    render(
      <AiChatUsageProvider sessionId="s1" onRunSettled={onRunSettled}>
        <Probe />
      </AiChatUsageProvider>
    );
    await waitFor(() => expect(screen.getByTestId("cost")).toHaveTextContent("1"));
    expect(a.s.subscriber).not.toBeNull();

    act(() => a.s.subscriber!.onRunFinalized!());
    await waitFor(() => expect(screen.getByTestId("cost")).toHaveTextContent("2"));
    act(() => a.s.subscriber!.onRunFailed!());
    await waitFor(() => expect(screen.getByTestId("cost")).toHaveTextContent("3"));
    expect(onRunSettled).toHaveBeenCalledTimes(2);
  });

  it("★ 压缩/撤销之后:重取用量,并通知页面重挂聊天区", async () => {
    const onCompactionChanged = vi.fn();
    render(
      <AiChatUsageProvider sessionId="s1" onCompactionChanged={onCompactionChanged}>
        <Probe />
      </AiChatUsageProvider>
    );
    await waitFor(() => expect(screen.getByTestId("cost")).toHaveTextContent("1"));
    act(() => screen.getByRole("button", { name: "changed" }).click());
    await waitFor(() => expect(screen.getByTestId("cost")).toHaveTextContent("2"));
    expect(onCompactionChanged).toHaveBeenCalledTimes(1);
  });

  it("★ refreshKey 变了就重取 —— 目录重拉后窗口大小才会出现在占用条上", async () => {
    const { rerender } = render(
      <AiChatUsageProvider sessionId="s1" refreshKey={0}>
        <Probe />
      </AiChatUsageProvider>
    );
    await waitFor(() => expect(screen.getByTestId("cost")).toHaveTextContent("1"));
    rerender(
      <AiChatUsageProvider sessionId="s1" refreshKey={1}>
        <Probe />
      </AiChatUsageProvider>
    );
    await waitFor(() => expect(screen.getByTestId("cost")).toHaveTextContent("2"));
  });

  it("卸载时退订 —— 否则切会话后旧会话的回合结束还会触发刷新", async () => {
    const { unmount } = render(
      <AiChatUsageProvider sessionId="s1">
        <Probe />
      </AiChatUsageProvider>
    );
    await waitFor(() => expect(a.s.subscriber).not.toBeNull());
    unmount();
    expect(a.s.subscriber).toBeNull();
  });

  it("★ 一轮结束后发现新的栈顶(自动压缩):标成「刚压缩」,并让页面重挂一次", async () => {
    // 自动压缩发生在一轮之中:没有路由返回可挂钩,只能靠数据发现。
    stackQueue = [[], ["k1"]];
    const onCompactionChanged = vi.fn();
    render(
      <AiChatUsageProvider sessionId="s1" onCompactionChanged={onCompactionChanged}>
        <Probe />
      </AiChatUsageProvider>
    );
    await waitFor(() => expect(screen.getByTestId("cost")).toHaveTextContent("1"));
    // 首次加载不算「刚压缩」,也不重挂 —— 否则每次打开会话都会展开分隔线。
    expect(screen.getByTestId("just")).toHaveTextContent("null");
    expect(onCompactionChanged).not.toHaveBeenCalled();

    act(() => a.s.subscriber!.onRunFinalized!());
    await waitFor(() => expect(screen.getByTestId("just")).toHaveTextContent("k1"));
    expect(onCompactionChanged).toHaveBeenCalledTimes(1);
  });

  it("★ 手动压缩已由 notify 重挂过,数据侧发现栈顶变化时不再挂第二次", async () => {
    stackQueue = [[], ["k1"]];
    const onCompactionChanged = vi.fn();
    render(
      <AiChatUsageProvider sessionId="s1" onCompactionChanged={onCompactionChanged}>
        <Probe />
      </AiChatUsageProvider>
    );
    await waitFor(() => expect(screen.getByTestId("cost")).toHaveTextContent("1"));
    act(() => screen.getByRole("button", { name: "changed" }).click());
    await waitFor(() => expect(screen.getByTestId("just")).toHaveTextContent("k1"));
    // 重挂两次会让聊天区闪两下、connect 两次。
    expect(onCompactionChanged).toHaveBeenCalledTimes(1);
  });

  it("★ 撤销后栈顶退回更早那条 —— 不算「刚压缩」", async () => {
    stackQueue = [["k1", "k2"], ["k1"]];
    render(
      <AiChatUsageProvider sessionId="s1">
        <Probe />
      </AiChatUsageProvider>
    );
    await waitFor(() => expect(screen.getByTestId("cost")).toHaveTextContent("1"));
    act(() => screen.getByRole("button", { name: "changed" }).click());
    await waitFor(() => expect(screen.getByTestId("cost")).toHaveTextContent("2"));
    // 按「栈顶变了」判的话,这里会把 k1 误标成刚压缩、把它的分隔线展开。
    expect(screen.getByTestId("just")).toHaveTextContent("null");
  });
});
