// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import React from "react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * 压缩分隔线上的两个动作:撤销、查看原文。
 *
 * 规格:「撤销」在撤销闸拒绝时显示原因;「查看原文」打开 Sheet,内容来自分页原文接口。
 */

const u = vi.hoisted(() => ({ notify: vi.fn(), usage: null as unknown, just: null as string | null }));
vi.mock("../web/src/aiChat/usageContext", () => ({
  useAiChatUsage: () => ({
    sessionId: "s1",
    usage: u.usage,
    error: null,
    refresh: vi.fn(),
    notifyCompactionChanged: u.notify,
    justCompactedId: u.just,
  }),
}));

const { compactionActivityRenderer } = await import("../web/src/aiChat/CompactionDivider");

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  u.notify.mockReset();
  u.usage = null;
  u.just = null;
});

const CONTENT = {
  kind: "compaction" as const,
  id: "k1",
  trigger: "manual" as const,
  excludedMessageIds: ["u1", "a1"],
  summary: { decisions: ["决定"], constraints: [], state: [], nextSteps: [] },
  createdAt: "2026-09-18T00:00:00.000Z",
};

function mount(content: Record<string, unknown> = CONTENT) {
  const R = compactionActivityRenderer.render;
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <R content={content as never} />
    </QueryClientProvider>
  );
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("分隔线:撤销", () => {
  it("撤销的是这条压缩,成功后通知重挂", async () => {
    const calls: { url: string; body: unknown }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({ url: String(input), body: JSON.parse(String(init?.body ?? "{}")) });
        return json({ reverted: {} });
      })
    );
    mount();
    await userEvent.click(screen.getByRole("button", { name: "撤销" }));
    expect(calls[0]!.url).toContain("/compaction/s1/undo");
    expect(calls[0]!.body).toEqual({ compactionId: "k1" });
    expect(u.notify).toHaveBeenCalledTimes(1);
  });

  it("★ 撤销闸拒绝:原样显示原因,不重挂", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        json({ error: "撤销后上下文会超出模型窗口，已拒绝撤销 —— 否则下一轮会直接失败。" }, 409)
      )
    );
    mount();
    await userEvent.click(screen.getByRole("button", { name: "撤销" }));
    // apiPost 只认 {error:{message}},用它会显示成 Conflict —— 用户就不知道为什么撤不了。
    expect(await screen.findByRole("alert")).toHaveTextContent("撤销后上下文会超出模型窗口");
    expect(u.notify).not.toHaveBeenCalled();
  });
});

describe("分隔线:查看原文", () => {
  it("★ 按时间正序显示,并标出被压缩掉的那几条", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (!url.includes("/api/llm-chat/sessions/s1/messages")) throw new Error(`Unhandled fetch: ${url}`);
        // 接口最新在前
        return json({
          messages: [
            { messageId: "u2", messageIndex: 2, role: "user", text: "第二问", preview: "第二问", createdAt: "" },
            { messageId: "a1", messageIndex: 1, role: "assistant", text: "第一答", preview: "第一答", createdAt: "" },
            { messageId: "u1", messageIndex: 0, role: "user", text: "第一问", preview: "第一问", createdAt: "" },
          ],
          nextBefore: null,
        });
      })
    );
    mount();
    await userEvent.click(screen.getByRole("button", { name: "查看原文" }));
    const first = await screen.findByText("第一问");
    const second = screen.getByText("第二问");
    // 正序:第一问在第二问之前。
    expect(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // u1、a1 被折叠;u2 没有。
    expect(screen.getAllByText("已压缩")).toHaveLength(2);
  });
});

describe("分隔线:刚压缩完", () => {
  const summaryCall = (callId: string, costUsd: number, costState = "priced") => ({
    callId, purpose: "compact", stepIndex: 0, attempt: 0, status: "completed", model: null,
    usage: null, costUsd, costState, startedAt: "", endedAt: null,
  });

  it("★ 刚压缩完的那一条默认展开,并写出释放量与花费", () => {
    u.just = "k1";
    u.usage = {
      byRun: {
        rc: { displayMessageId: null, calls: [summaryCall("c1", 0.001), summaryCall("c2", 0.002)], totals: {} },
        // 别的轮的账不能算进这次压缩。
        r9: { displayMessageId: "a:r9:answer:0", calls: [summaryCall("x", 5)], totals: {} },
      },
    };
    mount({ ...CONTENT, summaryCallIds: ["c1", "c2"], freedTokens: 12_345 });
    expect(screen.getByText("决定")).toBeInTheDocument();
    expect(screen.getByText("释放 ≈12.3K token · 花费 $0.0030")).toBeInTheDocument();
  });

  it("★ 摘要账里有没定价的,花费写成下限 `≥`", () => {
    u.just = "k1";
    u.usage = { byRun: { rc: { calls: [summaryCall("c1", 0.001), summaryCall("c2", 0, "unpriced")] } } };
    mount({ ...CONTENT, summaryCallIds: ["c1", "c2"] });
    expect(screen.getByText("花费 ≥$0.0010")).toBeInTheDocument();
  });

  it("不是刚压缩的那条仍默认收起;老事件没有释放量就不写", async () => {
    u.just = "别的";
    mount();
    expect(screen.queryByText("决定")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /此处已压缩/ }));
    expect(screen.getByText("决定")).toBeInTheDocument();
    expect(screen.queryByText(/释放/)).not.toBeInTheDocument();
  });
});
