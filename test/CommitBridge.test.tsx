// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CommitBridge } from "../web/src/pages/CommitBridge";

const RAW_FETCH = globalThis.fetch;

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <CommitBridge />
    </QueryClientProvider>
  );
}
function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
  });
}

const EMPTY_REPOS = {
  ok: true,
  repos: [],
  coverage: {
    totalCommits: 0,
    commitsInReposWithConversation: 0,
    pctReposWithConversation: 0,
  },
};
const EMPTY_COMMITS = {
  ok: true,
  items: [],
  nextBefore: null,
  coverage: {
    totalCommits: 0,
    commitsInReposWithConversation: 0,
    pctReposWithConversation: 0,
  },
};
const EMPTY_COMMIT = {
  ok: true,
  commit: {},
  windowFromUtc: "2026-06-01T08:00:00.000Z",
  messages: [],
};

// 页面按 URL 打三个接口:/repos, /commits, /commit —— 分别路由到各自 mock。
function installFetchMock(opts: {
  repos?: unknown;
  commits?: unknown;
  commit?: unknown;
}): void {
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/commit-bridge/repos"))
      return jsonResponse(opts.repos ?? EMPTY_REPOS);
    if (url.includes("/commit-bridge/commits"))
      return jsonResponse(opts.commits ?? EMPTY_COMMITS);
    if (url.includes("/commit-bridge/commit"))
      return jsonResponse(opts.commit ?? EMPTY_COMMIT);
    return jsonResponse(EMPTY_COMMITS);
  }) as unknown as typeof fetch;
}
afterEach(() => {
  cleanup();
  globalThis.fetch = RAW_FETCH;
});

const ONE_COMMIT = {
  ok: true,
  items: [
    {
      repoKey: "/w/x/repo",
      commitHash: "cccc0001",
      authorDateUtc: "2026-06-01T14:00:00.000Z",
      committerDateUtc: "2026-06-01T14:00:00.000Z",
      subject: "fix: 修一个关键 bug",
      added: 10,
      deleted: 3,
      filesChanged: 2,
      projectKey: "-w-x-repo",
      matchedCount: 2,
    },
  ],
  nextBefore: null,
  coverage: {
    totalCommits: 1,
    commitsInReposWithConversation: 1,
    pctReposWithConversation: 1,
  },
};

describe("CommitBridge — 对话↔提交页", () => {
  it("有提交 → 渲染 commit 主题 + matched 徽标 + 诚实副标", async () => {
    installFetchMock({ commits: ONE_COMMIT });
    renderPage();
    await waitFor(() =>
      expect(screen.getByText("fix: 修一个关键 bug")).toBeInTheDocument()
    );
    expect(screen.getByText("2 条对话")).toBeInTheDocument();
    // 诚实标注:启发式 / 非因果
    expect(screen.getByText(/启发式/)).toBeInTheDocument();
    // coverage 行
    expect(
      screen.getByText(/你的 1 个提交里 1 个在有对话的仓库/)
    ).toBeInTheDocument();
  });

  it("空库 → 空态提示", async () => {
    installFetchMock({ commits: EMPTY_COMMITS });
    renderPage();
    await waitFor(() =>
      expect(screen.getByText(/还没有已索引的提交/)).toBeInTheDocument()
    );
  });

  it("点击 commit → 展开该窗口对话", async () => {
    installFetchMock({
      commits: ONE_COMMIT,
      commit: {
        ok: true,
        commit: ONE_COMMIT.items[0],
        windowFromUtc: "2026-06-01T13:00:00.000Z",
        messages: [
          {
            id: 1,
            source: "claude",
            eventAtUtc: "2026-06-01T13:10:00.000Z",
            cleanedText: "帮我修这个关键 bug",
          },
        ],
      },
    });
    renderPage();
    await waitFor(() =>
      expect(screen.getByText("fix: 修一个关键 bug")).toBeInTheDocument()
    );
    fireEvent.click(screen.getByText("fix: 修一个关键 bug"));
    await waitFor(() =>
      expect(screen.getByText("帮我修这个关键 bug")).toBeInTheDocument()
    );
  });

  it("点击 0 匹配的 commit → 诚实空窗口提示", async () => {
    installFetchMock({
      commits: {
        ...ONE_COMMIT,
        items: [{ ...ONE_COMMIT.items[0], matchedCount: 0 }],
      },
      commit: {
        ok: true,
        commit: ONE_COMMIT.items[0],
        windowFromUtc: "2026-06-01T13:00:00.000Z",
        messages: [],
      },
    });
    renderPage();
    await waitFor(() =>
      expect(screen.getByText("fix: 修一个关键 bug")).toBeInTheDocument()
    );
    expect(screen.getByText("无")).toBeInTheDocument();
    fireEvent.click(screen.getByText("fix: 修一个关键 bug"));
    await waitFor(() =>
      expect(screen.getByText(/没找到对应对话/)).toBeInTheDocument()
    );
  });
});
