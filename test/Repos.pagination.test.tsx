// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Repos } from "../web/src/pages/Repos";

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
  });
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

function repoPage(n: number) {
  return {
    repos: [
      {
        id: n,
        path_canonical: `/root/dir/page${n}-repo`,
        origin_url: `https://example.com/page${n}`,
        last_scanned_at: "2026-01-01",
      },
    ],
    total: 60, // 3 pages -> pager shown
    page: n,
    limit: 25,
  };
}

function renderRepos() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={["/repos"]}>
        <Repos />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Repos pagination", () => {
  it("keeps the current page visible while the next page loads (no full-page 加载中 flicker)", async () => {
    const page2 = deferred<void>();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("/api/status")) {
          return json({ repos: 60, manifests: 100, lastJob: null });
        }
        if (url.includes("page=2")) {
          await page2.promise; // hold page 2 open so we can inspect the transition
          return json(repoPage(2));
        }
        return json(repoPage(1));
      })
    );

    renderRepos();
    await screen.findByText("https://example.com/page1");
    expect(screen.getByText("仓库清单")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "下一页" }));

    // While page 2 is still loading, the previous page stays on screen and the
    // whole page is NOT replaced by the "加载中…" placeholder.
    expect(screen.queryByText("加载中…")).toBeNull();
    expect(screen.getByText("仓库清单")).toBeInTheDocument();
    expect(screen.getByText("https://example.com/page1")).toBeInTheDocument();
    // The stat cards ABOVE the table (not part of the table) must NOT flicker
    // either — they share the page's early-return guard, so this is the real
    // proof the whole page stays mounted, not just the table body.
    expect(screen.getByText("已索引文件")).toBeInTheDocument();
    expect(screen.getByText("当前页")).toBeInTheDocument();

    // Once page 2 resolves, the table swaps to the new rows in place.
    page2.resolve();
    await screen.findByText("https://example.com/page2");
    await waitFor(() =>
      expect(screen.queryByText("https://example.com/page1")).toBeNull()
    );
  });
});
