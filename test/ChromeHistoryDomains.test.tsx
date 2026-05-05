// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import React from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChromeHistoryDomains } from "../web/src/pages/ChromeHistoryDomains";

function renderPage(initialEntry = "/chrome-history/domains") {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <ChromeHistoryDomains />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

describe("ChromeHistoryDomains page", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("sets the WeChat article domain in URL-backed state and queries bounded visits", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/chrome-history/domains/status")) {
        return json({
          supported: true,
          profile: "Default",
          defaultHistoryPath: "/tmp/History",
          platform: "darwin",
          domainStatus: {
            profile: "Default",
            ruleVersion: 1,
            state: {
              last_rebuilt_at: "2026-05-04T00:00:00.000Z",
              last_error: null,
              source_visit_count: 2,
              derived_visit_count: 2,
              last_rebuild_duration_ms: 3,
            },
            currentSourceVisitCount: 2,
            currentDerivedVisitCount: 2,
            fresh: true,
            staleReasons: [],
          },
        });
      }
      if (url.includes("/api/chrome-history/domains/summary")) {
        return json({
          unique_domains: 1,
          total_visits: 1,
          top_domain: { domain: "mp.weixin.qq.com", count: 1 },
        });
      }
      if (url.includes("/api/chrome-history/domains/top")) {
        return json({
          items: [
            {
              domain: "mp.weixin.qq.com",
              count: 1,
              first_visit_day: "2026-05-01",
              last_visit_day: "2026-05-01",
            },
          ],
        });
      }
      if (url.includes("/api/chrome-history/domains/timeline")) {
        return json({ xs: [], ys: [], cells: [] });
      }
      if (url.includes("/api/chrome-history/domains/visits")) {
        return json({ items: [], next_cursor: null });
      }
      throw new Error(`Unhandled fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const user = userEvent.setup();
    renderPage("/chrome-history/domains?q=__biz");

    expect(await screen.findByText("Chrome 域名")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "微信文章" }));

    expect(screen.getByLabelText("域名")).toHaveValue("mp.weixin.qq.com");
    expect(await screen.findByText("没有匹配的微信文章访问。")).toBeInTheDocument();

    await waitFor(() => {
      const visitUrls = fetchMock.mock.calls
        .map((call) => String(call[0]))
        .filter((url) => url.includes("/api/chrome-history/domains/visits"));
      expect(visitUrls.some((url) => url.includes("domain=mp.weixin.qq.com"))).toBe(true);
      expect(visitUrls.some((url) => url.includes("q=__biz"))).toBe(true);
      expect(visitUrls.some((url) => url.includes("from="))).toBe(true);
      expect(visitUrls.some((url) => url.includes("per_page=50"))).toBe(true);
    });
  });

  it("hydrates domain and keyword controls from URL search params", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/api/chrome-history/domains/status")) {
          return json({
            supported: true,
            profile: "Default",
            defaultHistoryPath: "/tmp/History",
            platform: "darwin",
            domainStatus: {
              profile: "Default",
              ruleVersion: 1,
              state: null,
              currentSourceVisitCount: 0,
              currentDerivedVisitCount: 0,
              fresh: false,
              staleReasons: ["not_built"],
            },
          });
        }
        if (url.includes("/api/chrome-history/domains/summary")) {
          return json({ unique_domains: 0, total_visits: 0, top_domain: null });
        }
        if (url.includes("/api/chrome-history/domains/top")) return json({ items: [] });
        if (url.includes("/api/chrome-history/domains/timeline")) {
          return json({ xs: [], ys: [], cells: [] });
        }
        if (url.includes("/api/chrome-history/domains/visits")) {
          return json({ items: [], next_cursor: null });
        }
        throw new Error(`Unhandled fetch: ${url}`);
      })
    );

    renderPage("/chrome-history/domains?domains=mp.weixin.qq.com&q=agent");

    expect(await screen.findByLabelText("域名")).toHaveValue("mp.weixin.qq.com");
    expect(screen.getByLabelText("搜索 URL / 标题")).toHaveValue("agent");
    expect(await screen.findByText(/当前域名数据可能不是最新/)).toBeInTheDocument();
  });

  it("renders visit rows and lets manual domain input replace the active filter", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/chrome-history/domains/status")) {
        return json({
          supported: true,
          profile: "Default",
          defaultHistoryPath: "/tmp/History",
          platform: "darwin",
          domainStatus: {
            profile: "Default",
            ruleVersion: 1,
            state: {
              last_rebuilt_at: "2026-05-04T00:00:00.000Z",
              last_error: null,
              source_visit_count: 3,
              derived_visit_count: 3,
              last_rebuild_duration_ms: 4,
            },
            currentSourceVisitCount: 3,
            currentDerivedVisitCount: 3,
            fresh: true,
            staleReasons: [],
          },
        });
      }
      if (url.includes("/api/chrome-history/domains/summary")) {
        return json({
          unique_domains: 2,
          total_visits: 3,
          top_domain: { domain: "example.com", count: 2 },
        });
      }
      if (url.includes("/api/chrome-history/domains/top")) {
        return json({
          items: [
            {
              domain: "example.com",
              count: 2,
              first_visit_day: "2026-05-01",
              last_visit_day: "2026-05-02",
            },
            {
              domain: "github.com",
              count: 1,
              first_visit_day: "2026-05-02",
              last_visit_day: "2026-05-02",
            },
          ],
        });
      }
      if (url.includes("/api/chrome-history/domains/timeline")) {
        return json({ xs: ["2026-05-02"], ys: ["example.com"], cells: [[1]] });
      }
      if (url.includes("/api/chrome-history/domains/visits")) {
        return json({
          items: [
            {
              visit_id: 10,
              source_id: "legacy",
              domain: "example.com",
              url_kind: "web",
              url: "https://example.com/titled",
              title: "Titled visit",
              visit_time_unix_ms: 1_777_680_000_000,
              calendar_day: "2026-05-02",
            },
            {
              visit_id: 9,
              source_id: "legacy",
              domain: "example.com",
              url_kind: "web",
              url: "https://example.com/fallback",
              title: null,
              visit_time_unix_ms: 1_777_676_400_000,
              calendar_day: "2026-05-02",
            },
          ],
          next_cursor: null,
        });
      }
      throw new Error(`Unhandled fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const user = userEvent.setup();
    renderPage("/chrome-history/domains?domains=example.com,a.test");

    expect(await screen.findByText("Titled visit")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Titled visit/ })).toHaveAttribute(
      "href",
      "https://example.com/titled"
    );
    expect(screen.getAllByText("https://example.com/fallback")).toHaveLength(2);

    const timelineTab = screen.getByRole("button", { name: "时间矩阵" });
    expect(timelineTab).toHaveAttribute("aria-selected", "false");
    await user.click(timelineTab);
    expect(timelineTab).toHaveAttribute("aria-selected", "true");
    expect(
      screen.getByRole("img", { name: "域名访问时间矩阵" })
    ).toBeInTheDocument();

    const domainInput = screen.getByLabelText("域名");
    await user.clear(domainInput);
    await user.type(domainInput, " GitHub.COM ");

    expect(domainInput).toHaveValue("github.com");
    await waitFor(() => {
      const visitUrls = fetchMock.mock.calls
        .map((call) => String(call[0]))
        .filter((url) => url.includes("/api/chrome-history/domains/visits"));
      expect(visitUrls.some((url) => url.includes("domain=github.com"))).toBe(true);
      expect(visitUrls.every((url) => !url.includes("a.test"))).toBe(true);
    });
  });

  it("replaces the active domain when clicking ranking rows repeatedly", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/chrome-history/domains/status")) {
        return json({
          supported: true,
          profile: "Default",
          defaultHistoryPath: "/tmp/History",
          platform: "darwin",
          domainStatus: {
            profile: "Default",
            ruleVersion: 1,
            state: {
              last_rebuilt_at: "2026-05-04T00:00:00.000Z",
              last_error: null,
              source_visit_count: 3,
              derived_visit_count: 3,
              last_rebuild_duration_ms: 4,
            },
            currentSourceVisitCount: 3,
            currentDerivedVisitCount: 3,
            fresh: true,
            staleReasons: [],
          },
        });
      }
      if (url.includes("/api/chrome-history/domains/summary")) {
        return json({
          unique_domains: 2,
          total_visits: 3,
          top_domain: { domain: "example.com", count: 2 },
        });
      }
      if (url.includes("/api/chrome-history/domains/top")) {
        return json({
          items: [
            {
              domain: "example.com",
              count: 2,
              first_visit_day: "2026-05-01",
              last_visit_day: "2026-05-02",
            },
            {
              domain: "github.com",
              count: 1,
              first_visit_day: "2026-05-02",
              last_visit_day: "2026-05-02",
            },
          ],
        });
      }
      if (url.includes("/api/chrome-history/domains/timeline")) {
        return json({ xs: ["2026-05-02"], ys: ["example.com"], cells: [[1]] });
      }
      if (url.includes("/api/chrome-history/domains/visits")) {
        return json({ items: [], next_cursor: null });
      }
      throw new Error(`Unhandled fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const user = userEvent.setup();
    renderPage("/chrome-history/domains");

    await user.click(await screen.findByRole("button", { name: /example.com/ }));
    await user.click(screen.getByRole("button", { name: /github.com/ }));

    expect(screen.getByLabelText("域名")).toHaveValue("github.com");
    await waitFor(() => {
      const visitUrls = fetchMock.mock.calls
        .map((call) => String(call[0]))
        .filter((url) => url.includes("/api/chrome-history/domains/visits"));
      expect(visitUrls.some((url) => url.includes("domain=github.com"))).toBe(true);
      expect(visitUrls.every((url) => !url.includes("domain=example.com%2Cgithub.com"))).toBe(
        true
      );
    });
  });
});

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
  });
}
