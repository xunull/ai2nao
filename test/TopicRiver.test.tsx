// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import React from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TopicRiver } from "../web/src/pages/TopicRiver";

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
  });
}

const CATEGORIES = json({
  configOk: true,
  configPath: "/home/config.json",
  configExists: true,
  categories: [
    { name: "社区", color: "#ff8a5c" },
    { name: "其他", color: "#8a8f98" },
  ],
});

function streamRes(opts: {
  source: string;
  ys: string[];
  built: boolean;
}): Response {
  return json({
    source: opts.source,
    profile: opts.source === "git" ? "-" : "Default",
    grain: "day",
    xs: opts.built ? ["2026-05-01", "2026-05-02"] : [],
    ys: opts.built ? opts.ys : [],
    cells: opts.built ? opts.ys.map((_, i) => [i + 1, 1]) : [],
    status: {
      ruleVersion: "v1",
      state: opts.built
        ? {
            last_rebuilt_at: "2026-05-04T00:00:00.000Z",
            last_error: null,
            source_event_count: 3,
            derived_event_count: 3,
          }
        : null,
      fresh: opts.built,
      staleReasons: opts.built ? [] : ["not_built"],
    },
  });
}

function renderPage(initialEntry = "/topics/river") {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <TopicRiver />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

describe("TopicRiver page", () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("shows the not-built empty state with the copyable rebuild command", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/api/topics/categories")) return CATEGORIES;
        if (url.includes("/api/topics/stream")) {
          return streamRes({ source: "chrome", ys: [], built: false });
        }
        throw new Error(`Unhandled fetch: ${url}`);
      })
    );

    renderPage();
    expect(await screen.findByText("主题河流尚未构建。")).toBeInTheDocument();
    expect(
      screen.getByText("node dist/cli.js topics rebuild --source chrome")
    ).toBeInTheDocument();
  });

  it("renders the browsing river: title, left index band, and the SVG", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/api/topics/categories")) return CATEGORIES;
        if (url.includes("/api/topics/stream")) {
          return streamRes({ source: "chrome", ys: ["社区", "其他"], built: true });
        }
        throw new Error(`Unhandled fetch: ${url}`);
      })
    );

    renderPage();
    expect(await screen.findByText("浏览主题河流")).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: /社区/ })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: /浏览主题河流/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "导出 PNG" })).toBeInTheDocument();
  });

  it("switches source to git: retitles, relabels the index, and fetches source=git&profile=-", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/topics/categories")) return CATEGORIES;
      if (url.includes("/api/topics/stream")) {
        return url.includes("source=git")
          ? streamRes({ source: "git", ys: ["ai2nao", "其他"], built: true })
          : streamRes({ source: "chrome", ys: ["社区", "其他"], built: true });
      }
      throw new Error(`Unhandled fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const user = userEvent.setup();
    renderPage();
    expect(await screen.findByText("浏览主题河流")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "git 提交" }));

    expect(await screen.findByText("git 提交河流")).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: /ai2nao/ })).toBeInTheDocument();
    expect(screen.getByText("仓库 · 点击可高亮")).toBeInTheDocument();

    await waitFor(() => {
      const streamUrls = fetchMock.mock.calls
        .map((c) => String(c[0]))
        .filter((u) => u.includes("/api/topics/stream?"));
      expect(streamUrls.some((u) => u.includes("source=git") && u.includes("profile=-"))).toBe(
        true
      );
    });
  });

  it("switches source to conversation: retitles, relabels index 主题, fetches source=conversation&profile=-", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/topics/categories")) return CATEGORIES;
      if (url.includes("/api/topics/stream")) {
        return url.includes("source=conversation")
          ? streamRes({ source: "conversation", ys: ["DNS", "其他"], built: true })
          : streamRes({ source: "chrome", ys: ["社区", "其他"], built: true });
      }
      throw new Error(`Unhandled fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const user = userEvent.setup();
    renderPage();
    expect(await screen.findByText("浏览主题河流")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "对话主题" }));

    expect(await screen.findByText("对话主题河流")).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: /DNS/ })).toBeInTheDocument();
    expect(screen.getByText("主题 · 点击可高亮")).toBeInTheDocument();

    await waitFor(() => {
      const streamUrls = fetchMock.mock.calls
        .map((c) => String(c[0]))
        .filter((u) => u.includes("/api/topics/stream?"));
      expect(
        streamUrls.some((u) => u.includes("source=conversation") && u.includes("profile=-"))
      ).toBe(true);
    });
  });
});
