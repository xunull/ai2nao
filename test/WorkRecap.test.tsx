// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import React from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkRecap } from "../web/src/pages/WorkRecap";

const RAW_FETCH = globalThis.fetch;

function renderWithRoute(initial = "/work-recap") {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initial]}>
        <WorkRecap />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}

type Handler = (
  url: string,
  init: RequestInit | undefined
) => Promise<Response> | Response;

function installFetchMock(handler: Handler): void {
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    return handler(url, init);
  }) as unknown as typeof fetch;
}

afterEach(() => {
  cleanup();
  globalThis.fetch = RAW_FETCH;
});

const HAPPY_RUN = {
  id: 42,
  windowKey: "7d",
  generatedAt: "2026-06-09T10:00:00Z",
  model: "deepseek:deepseek-chat",
  promptVersion: "work-recap@v1",
  facts: {
    windowKey: "7d",
    windowStart: "2026-06-02T10:00:00Z",
    windowEnd: "2026-06-09T10:00:00Z",
    authorEmail: "me@example.com",
    totalCommits: 12,
    projectCount: 2,
    projectShare: [
      { projectKey: "/a", projectLabel: "alpha", commitCount: 9, share: 0.75 },
      { projectKey: "/b", projectLabel: "bravo", commitCount: 3, share: 0.25 },
    ],
    commitTypeCounts: {
      feat: 7,
      fix: 3,
      refactor: 0,
      docs: 1,
      chore: 1,
      test: 0,
      style: 0,
      perf: 0,
      build: 0,
      ci: 0,
      revert: 0,
      other: 0,
    },
    dailyCounts: [],
    reposScanned: 8,
    reposTotal: 10,
    scanTruncated: false,
    scanTruncatedReason: null,
    diagnostics: [],
  },
  inference: {
    summary: "本周以 feat 为主，主战场在 alpha。",
    workMode: "build",
    workModeReason: "feat=7 远多于 fix=3",
    nextUp: ["完成 alpha 的 onboarding 流程"],
    fragmentation: "low",
    degraded: false,
    degradeReason: null,
  },
};

describe("WorkRecap page", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("F7 T-C2: shows empty-repos state after pressing generate when repos table is empty", async () => {
    installFetchMock(async (url, init) => {
      if (url.includes("/api/work-recap/latest")) {
        return jsonResponse({ ok: true, windowKey: "7d", run: null });
      }
      if (url.includes("/api/work-recap/list")) {
        return jsonResponse({ ok: true, windowKey: "7d", runs: [] });
      }
      if (init?.method === "POST" && url.includes("/api/work-recap/generate")) {
        return jsonResponse({
          ok: true,
          empty: true,
          reason: "no_repos_indexed",
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    renderWithRoute();

    const button = await screen.findByRole("button", { name: /生成 recap/ });
    fireEvent.click(button);

    await waitFor(() => {
      expect(
        screen.getByText(/还未扫描 git 仓库|尚未发现已索引的 git 仓库/i)
      ).toBeInTheDocument();
    });
  });

  it("renders a recap card when /latest returns a run", async () => {
    installFetchMock(async (url) => {
      if (url.includes("/api/work-recap/latest")) {
        return jsonResponse({ ok: true, windowKey: "7d", run: HAPPY_RUN });
      }
      if (url.includes("/api/work-recap/list")) {
        return jsonResponse({ ok: true, windowKey: "7d", runs: [HAPPY_RUN] });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    renderWithRoute();

    expect(
      await screen.findByText("本周以 feat 为主，主战场在 alpha。")
    ).toBeInTheDocument();
    expect(screen.getByText("看起来在 build")).toBeInTheDocument();
    expect(screen.getByText("alpha")).toBeInTheDocument();
    expect(screen.getByText("bravo")).toBeInTheDocument();
  });

  it("F7 T-C3: shows in-flight notice when generate returns 409", async () => {
    installFetchMock(async (url, init) => {
      if (url.includes("/api/work-recap/latest")) {
        return jsonResponse({ ok: true, windowKey: "7d", run: null });
      }
      if (url.includes("/api/work-recap/list")) {
        return jsonResponse({ ok: true, windowKey: "7d", runs: [] });
      }
      if (init?.method === "POST" && url.includes("/api/work-recap/generate")) {
        return jsonResponse(
          {
            ok: false,
            inflight: true,
            windowKey: "7d",
            startedAt: "2026-06-09T10:00:00Z",
          },
          { status: 409 }
        );
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    renderWithRoute();

    const button = await screen.findByRole("button", { name: /生成 recap/ });
    fireEvent.click(button);

    await waitFor(() => {
      expect(
        screen.getByText(/正在生成中（.*）/)
      ).toBeInTheDocument();
    });
  });

  it("renders degraded badge + factual fallback when inference is degraded", async () => {
    const degraded = {
      ...HAPPY_RUN,
      inference: {
        summary: "fallback factual summary",
        workMode: "low_signal" as const,
        workModeReason: "LLM unavailable",
        nextUp: [],
        fragmentation: "low" as const,
        degraded: true,
        degradeReason: "llm_unavailable" as const,
      },
    };
    installFetchMock(async (url) => {
      if (url.includes("/api/work-recap/latest")) {
        return jsonResponse({ ok: true, windowKey: "7d", run: degraded });
      }
      if (url.includes("/api/work-recap/list")) {
        return jsonResponse({ ok: true, windowKey: "7d", runs: [degraded] });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    renderWithRoute();

    expect(await screen.findByText("fallback factual summary")).toBeInTheDocument();
    expect(screen.getByText(/LLM 服务不可用/)).toBeInTheDocument();
  });

  it("switches data source when the window dropdown changes", async () => {
    const calls: string[] = [];
    installFetchMock(async (url) => {
      calls.push(url);
      if (url.includes("/api/work-recap/latest")) {
        return jsonResponse({ ok: true, windowKey: "7d", run: null });
      }
      if (url.includes("/api/work-recap/list")) {
        return jsonResponse({ ok: true, windowKey: "7d", runs: [] });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    renderWithRoute();

    await waitFor(() =>
      expect(calls.some((u) => u.includes("window=7d"))).toBe(true)
    );

    const select = screen.getByLabelText("时间窗口") as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "30d" } });

    await waitFor(() =>
      expect(calls.some((u) => u.includes("window=30d"))).toBe(true)
    );
  });
});
