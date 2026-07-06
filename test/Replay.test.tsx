// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Replay } from "../web/src/pages/Replay";

const RAW_FETCH = globalThis.fetch;

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <Replay />
    </QueryClientProvider>
  );
}
function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
  });
}

// 本地时刻构造(与页面 getHours/toLocaleDateString 同口径,断言不受 TZ 影响)。
const start1 = new Date(2026, 6, 5, 1, 23, 0).getTime(); // 7月5日
const end1 = new Date(2026, 6, 5, 2, 0, 0).getTime();
const start2 = new Date(2026, 6, 4, 21, 54, 0).getTime(); // 7月4日
const end2 = new Date(2026, 6, 4, 23, 12, 0).getTime();

const date2 = new Date(start2).toLocaleDateString("zh-CN", {
  month: "long",
  day: "numeric",
  weekday: "short",
});

const CARD1 = {
  startedAtMs: start1,
  endedAtMs: end1,
  firstEventKey: "k1",
  repoKeys: ["-w-x-ai2nao"],
  commitCount: 2,
  messageCount: 11,
  truncated: false,
};
const CARD2 = {
  startedAtMs: start2,
  endedAtMs: end2,
  firstEventKey: "k2",
  repoKeys: ["-w-x-insight"],
  commitCount: 4,
  messageCount: 38,
  truncated: false,
};

const TWO_SESSIONS = { ok: true, sessions: [CARD1, CARD2], skipped: 0, windowDays: 90 };

const DETAIL_K1 = {
  ok: true,
  session: CARD1,
  events: [
    {
      atMs: start1,
      type: "message",
      source: "codex",
      repoKey: "-w-x-ai2nao",
      id: "m1",
      cleanedText: "实现这个功能的时候是不是有些内容被砍掉了",
    },
    {
      atMs: start1 + 20 * 60000,
      type: "commit",
      source: "git",
      repoKey: "-w-x-ai2nao",
      id: "c1",
      subject: "docs(run): Makefile 技术说明",
      added: 148,
      deleted: 0,
      filesChanged: 3,
      matchedCount: 5,
    },
  ],
};
const DETAIL_K2 = {
  ok: true,
  session: CARD2,
  events: [
    {
      atMs: start2,
      type: "message",
      source: "claude",
      repoKey: "-w-x-insight",
      id: "m2",
      cleanedText: "按计划实现",
    },
    {
      atMs: start2 + 15 * 60000,
      type: "commit",
      source: "git",
      repoKey: "-w-x-insight",
      id: "c2",
      subject: "feat(cloc): 默认尊重 .gitignore",
      added: 122,
      deleted: 19,
      filesChanged: 4,
      matchedCount: 0,
    },
  ],
};

// 路由:/sessions 在前(避免被 /session 的子串抢),/session 再按 key 分流。
function installFetchMock(opts: { sessions?: unknown } = {}): void {
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/api/replay/sessions"))
      return jsonResponse(opts.sessions ?? TWO_SESSIONS);
    if (url.includes("/api/replay/session"))
      return jsonResponse(url.includes("key=k2") ? DETAIL_K2 : DETAIL_K1);
    return jsonResponse(TWO_SESSIONS);
  }) as unknown as typeof fetch;
}
afterEach(() => {
  cleanup();
  globalThis.fetch = RAW_FETCH;
});

describe("Replay — 那天回放页", () => {
  it("渲染会话队列(卡片日期 + N commit · M 对话)", async () => {
    installFetchMock();
    renderPage();
    await waitFor(() =>
      expect(screen.getByText("2 commit · 11 对话")).toBeInTheDocument()
    );
    // 第二段计数唯一,且其日期只出现在队列(工作区显示的是默认选中的第一段)。
    expect(screen.getByText("4 commit · 38 对话")).toBeInTheDocument();
    expect(screen.getByText(date2)).toBeInTheDocument();
  });

  it("默认选中最近一段并加载其时间线(commit 主题 + 匹配徽标)", async () => {
    installFetchMock();
    renderPage();
    await waitFor(() =>
      expect(screen.getByText("docs(run): Makefile 技术说明")).toBeInTheDocument()
    );
    expect(screen.getByText("匹配 5 条对话")).toBeInTheDocument();
  });

  it("空态:窗口内没有 mixed 工作会话", async () => {
    installFetchMock({ sessions: { ok: true, sessions: [], skipped: 0, windowDays: 90 } });
    renderPage();
    await waitFor(() =>
      expect(screen.getByText(/既有提交又有对话/)).toBeInTheDocument()
    );
  });

  it("点第二段 → 加载该段时间线(无匹配 commit)", async () => {
    installFetchMock();
    renderPage();
    await waitFor(() =>
      expect(screen.getByText("docs(run): Makefile 技术说明")).toBeInTheDocument()
    );
    fireEvent.click(screen.getByText("4 commit · 38 对话"));
    await waitFor(() =>
      expect(screen.getByText("feat(cloc): 默认尊重 .gitignore")).toBeInTheDocument()
    );
    expect(screen.getByText("无匹配")).toBeInTheDocument();
  });
});
