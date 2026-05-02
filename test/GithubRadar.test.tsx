// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GithubRadar } from "../web/src/pages/GithubRadar";

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <GithubRadar />
    </QueryClientProvider>
  );
}

function status(configured = true) {
  return {
    token: {
      configured,
      source: configured ? "env" : null,
      configPath: "/tmp/github.json",
      envVar: "GITHUB_TOKEN",
      insecureFilePermissions: false,
    },
    sync: {
      last_full_sync_at: null,
      last_full_sync_duration_ms: null,
      last_full_sync_error: null,
      last_incremental_sync_at: null,
      last_incremental_sync_duration_ms: null,
      last_incremental_sync_error: null,
      last_repos_updated_at: null,
      last_starred_at: null,
      in_progress: false,
    },
    counts: { repos: 0, stars: configured ? 1 : 0 },
  };
}

function radar(reason = "") {
  const repo = {
    repo_id: 1,
    owner: "u",
    name: "agent-kit",
    full_name: "u/agent-kit",
    description: "agent framework",
    html_url: "https://example.com/u/agent-kit",
    language: "TypeScript",
    topics: ["agent"],
    stargazers_count: 10,
    starred_at: "2026-04-20T00:00:00Z",
    archived: false,
    pushed_at: "2026-04-01T00:00:00Z",
    note: reason
      ? {
          repo_id: 1,
          reason,
          status: "try_next",
          last_reviewed_at: null,
          source: "user",
          created_at: "2026-05-01T00:00:00Z",
          updated_at: "2026-05-01T00:00:00Z",
        }
      : null,
    effective_status: reason ? "try_next" : "new",
    signals: reason ? ["recently_starred", "active_recently"] : ["missing_reason", "recently_starred", "active_recently"],
  };
  return {
    generated_at: "2026-05-01T00:00:00Z",
    thresholds: {
      stale_before: "2024-11-01T00:00:00Z",
      needs_review_before: "2025-05-01T00:00:00Z",
      recently_starred_since: "2026-04-01T00:00:00Z",
      active_recently_since: "2026-02-01T00:00:00Z",
    },
    counts: {
      total_stars: 1,
      missing_reason: reason ? 0 : 1,
      needs_review: 0,
      stale: 0,
      archived: 0,
      recently_starred: 1,
      active_recently: 1,
      try_next: reason ? 1 : 0,
    },
    clusters: [
      {
        tag: "agent",
        count: 1,
        missing_reason_count: reason ? 0 : 1,
        needs_review_count: 0,
        stale_count: 0,
        last_starred_at: "2026-04-20T00:00:00Z",
      },
    ],
    language_only: [
      {
        tag: "language:go",
        count: 1,
        missing_reason_count: 0,
        needs_review_count: 0,
        stale_count: 0,
        last_starred_at: "2025-01-01T00:00:00Z",
      },
    ],
    queues: {
      missing_reason: reason ? [] : [repo],
      needs_review: [],
      stale: [],
      try_next: reason ? [repo] : [],
      recently_starred: [repo],
    },
  };
}

describe("GithubRadar page", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("shows token setup guidance when GitHub token is missing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/api/github/status")) return json(status(false));
        throw new Error(`Unhandled fetch: ${url}`);
      })
    );

    renderPage();

    expect(await screen.findByText(/配置好 token/)).toBeInTheDocument();
    expect(screen.queryByText("复盘队列")).not.toBeInTheDocument();
  });

  it("renders metrics, topic clusters, language-only clusters, and repo editor", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/api/github/status")) return json(status(true));
        if (url.endsWith("/api/github/radar")) return json(radar());
        throw new Error(`Unhandled fetch: ${url}`);
      })
    );

    renderPage();

    expect(await screen.findByText("开源雷达")).toBeInTheDocument();
    expect(await screen.findByText("主题方向")).toBeInTheDocument();
    expect(screen.getByText("agent")).toBeInTheDocument();
    expect(screen.getByText("仅语言分组")).toBeInTheDocument();
    expect(screen.getByText("language:go")).toBeInTheDocument();
    expect(screen.getByText("u/agent-kit")).toBeInTheDocument();
    expect(screen.getByLabelText("收藏理由 u/agent-kit")).toBeInTheDocument();
  });

  it("disables save while pending and prevents duplicate save requests", async () => {
    let resolveSave!: () => void;
    const pending = new Promise<Response>((resolve) => {
      resolveSave = () =>
        resolve(
          json({
            note: {
              repo_id: 1,
              reason: "compare later",
              status: "try_next",
              last_reviewed_at: null,
              source: "user",
              created_at: "2026-05-01T00:00:00Z",
              updated_at: "2026-05-01T00:00:00Z",
            },
          })
        );
    });
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/github/status")) return json(status(true));
      if (url.endsWith("/api/github/radar")) return json(radar());
      if (url.endsWith("/api/github/radar/notes/1") && init?.method === "POST") {
        return pending;
      }
      throw new Error(`Unhandled fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    renderPage();

    await user.type(await screen.findByLabelText("收藏理由 u/agent-kit"), "compare later");
    const button = screen.getByRole("button", { name: "保存" });
    await user.click(button);
    await user.click(button);

    expect(
      fetchMock.mock.calls.filter((call) =>
        String(call[0]).endsWith("/api/github/radar/notes/1")
      )
    ).toHaveLength(1);
    expect(await screen.findByRole("button", { name: "保存中…" })).toBeDisabled();
    resolveSave();
  });

  it("keeps the draft visible when note save fails", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/github/status")) return json(status(true));
      if (url.endsWith("/api/github/radar")) return json(radar());
      if (url.endsWith("/api/github/radar/notes/1") && init?.method === "POST") {
        return new Response(JSON.stringify({ error: { message: "disk is locked" } }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        });
      }
      throw new Error(`Unhandled fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    renderPage();

    const textarea = await screen.findByLabelText("收藏理由 u/agent-kit");
    await user.type(textarea, "keep this draft");
    await user.click(screen.getByRole("button", { name: "保存" }));

    expect(await screen.findByText("disk is locked")).toBeInTheDocument();
    expect(screen.getByLabelText("收藏理由 u/agent-kit")).toHaveValue("keep this draft");
    expect(screen.getByRole("button", { name: "保存" })).toBeEnabled();
  });
});

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
  });
}
