// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Atuin } from "../web/src/pages/Atuin";

function makeSummary(date: string, summary: string) {
  return {
    summary,
    nextUp: null,
    workMode: null,
    fragmentation: null,
    degraded: false,
    degradeReason: null,
    facts: {
      date,
      totalCommands: 3,
      distinctCwds: 1,
      repoMatches: 3,
      outsideIndexedRepos: 0,
      sparse: false,
      recap: summary,
      topRepoLabel: "proj",
      nextUpHint: null,
      repoFacts: [],
    },
    meta: {
      generatedAt: new Date().toISOString(),
      model: "fake-model",
      fromCache: false,
      usedLlm: true,
    },
  };
}

function deferredResponse<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function formatLocalDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function dayButtonLabel(date: Date): string {
  const weekday = ["星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"][
    date.getDay()
  ];
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日 ${weekday}`;
}

describe("Atuin daily summary UI", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("shows a loading state while the first summary request is pending", async () => {
    const currentDate = new Date();
    const currentDateStr = formatLocalDate(currentDate);
    const pendingSummary = deferredResponse<Response>();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/atuin/status")) {
        return new Response(JSON.stringify({ enabled: true, path: "/tmp/history.db" }));
      }
      if (url.endsWith("/api/daily-summary/status")) {
        return new Response(
          JSON.stringify({
            enabled: true,
            modelConfigured: true,
            model: "fake-model",
            cacheDbPath: "/tmp/daily-summary.db",
          })
        );
      }
      if (url.includes("/api/atuin/month")) {
        return new Response(
          JSON.stringify({
            year: currentDate.getFullYear(),
            month: currentDate.getMonth() + 1,
            timezone: "local",
            days: [{ day: currentDateStr, count: 2 }],
          })
        );
      }
      if (url.includes(`/api/atuin/day?date=${currentDateStr}`)) {
        return new Response(
          JSON.stringify({
            date: currentDateStr,
            timezone: "local",
            entries: [
              {
                id: "1",
                timestamp_ns: Date.now() * 1_000_000,
                duration: 0,
                exit: 0,
                command: "npm test",
                cwd: "/tmp/proj",
                hostname: "h",
                session: "s",
              },
            ],
          })
        );
      }
      if (url.endsWith("/api/daily-summary") && init?.method === "POST") {
        return pendingSummary.promise;
      }
      throw new Error(`Unhandled fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
      },
    });
    const user = userEvent.setup();
    render(
      <QueryClientProvider client={queryClient}>
        <Atuin />
      </QueryClientProvider>
    );

    await screen.findByText(`${currentDateStr} 的命令`);
    await user.click(screen.getAllByRole("button", { name: "生成摘要" })[0]);

    expect(await screen.findByText("正在生成摘要…")).toBeInTheDocument();

    pendingSummary.resolve(
      new Response(JSON.stringify(makeSummary(currentDateStr, "summary ready")), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );
    expect(await screen.findByText("summary ready")).toBeInTheDocument();
  });

  it("keeps the selected date as the source of truth under summary race conditions", async () => {
    const currentDate = new Date();
    const otherDate = new Date(currentDate);
    otherDate.setDate(currentDate.getDate() > 1 ? currentDate.getDate() - 1 : currentDate.getDate() + 1);
    const currentDateStr = formatLocalDate(currentDate);
    const otherDateStr = formatLocalDate(otherDate);
    const day15 = deferredResponse<Response>();
    const day16 = deferredResponse<Response>();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/atuin/status")) {
        return new Response(JSON.stringify({ enabled: true, path: "/tmp/history.db" }));
      }
      if (url.endsWith("/api/daily-summary/status")) {
        return new Response(
          JSON.stringify({
            enabled: true,
            modelConfigured: true,
            model: "fake-model",
            cacheDbPath: "/tmp/daily-summary.db",
          })
        );
      }
      if (url.includes("/api/atuin/month")) {
        return new Response(
          JSON.stringify({
            year: currentDate.getFullYear(),
            month: currentDate.getMonth() + 1,
            timezone: "local",
            days: [
              { day: currentDateStr, count: 2 },
              { day: otherDateStr, count: 2 },
            ],
          })
        );
      }
      if (url.includes(`/api/atuin/day?date=${currentDateStr}`)) {
        return new Response(
          JSON.stringify({
            date: currentDateStr,
            timezone: "local",
            entries: [
              {
                id: "1",
                timestamp_ns: Date.now() * 1_000_000,
                duration: 0,
                exit: 0,
                command: "npm test",
                cwd: "/tmp/proj",
                hostname: "h",
                session: "s",
              },
            ],
          })
        );
      }
      if (url.includes(`/api/atuin/day?date=${otherDateStr}`)) {
        return new Response(
          JSON.stringify({
            date: otherDateStr,
            timezone: "local",
            entries: [
              {
                id: "2",
                timestamp_ns: Date.now() * 1_000_000,
                duration: 0,
                exit: 0,
                command: "npm run build",
                cwd: "/tmp/proj",
                hostname: "h",
                session: "s",
              },
            ],
          })
        );
      }
      if (url.endsWith("/api/daily-summary") && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as { date: string };
        if (body.date === currentDateStr) return day15.promise;
        if (body.date === otherDateStr) return day16.promise;
      }
      throw new Error(`Unhandled fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const queryClient = new QueryClient({
      defaultOptions: {
        queries: {
          retry: false,
        },
        mutations: {
          retry: false,
        },
      },
    });
    const user = userEvent.setup();
    render(
      <QueryClientProvider client={queryClient}>
        <Atuin />
      </QueryClientProvider>
    );

    await screen.findByText(`${currentDateStr} 的命令`);
    await user.click(screen.getAllByRole("button", { name: "生成摘要" })[0]);

    await user.click(
      screen.getAllByRole("button", { name: dayButtonLabel(otherDate) })[0]
    );
    await screen.findByText(`${otherDateStr} 的命令`);
    await user.click(screen.getAllByRole("button", { name: "生成摘要" })[0]);

    day16.resolve(
      new Response(JSON.stringify(makeSummary(otherDateStr, "summary for second date")), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );
    await screen.findByText("summary for second date");

    day15.resolve(
      new Response(JSON.stringify(makeSummary(currentDateStr, "summary for first date")), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );

    await waitFor(() => {
      expect(screen.getByText("summary for second date")).toBeInTheDocument();
      expect(screen.queryByText("summary for first date")).not.toBeInTheDocument();
    });
  });
});

