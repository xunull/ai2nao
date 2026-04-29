// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HuggingFaceModels } from "../web/src/pages/HuggingFaceModels";

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <HuggingFaceModels />
    </QueryClientProvider>
  );
}

describe("HuggingFaceModels page", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("renders empty state and disables sync while pending", async () => {
    let resolveSync!: () => void;
    const pending = new Promise<Response>((resolve) => {
      resolveSync = () => resolve(new Response(JSON.stringify({ ok: true, status: "success", warnings: [] })));
    });
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/huggingface/status")) {
        return json({
          cacheRoot: "/tmp/hf/hub",
          rootSource: "default",
          counts: { total: 0, active: 0, missing: 0, totalSizeBytes: 0, largestSizeBytes: 0, largestModel: null },
          lastRun: null,
        });
      }
      if (url.includes("/api/huggingface/models")) {
        return json({ rows: [], total: 0, limit: 50, offset: 0 });
      }
      if (url.endsWith("/api/huggingface/sync") && init?.method === "POST") return pending;
      throw new Error(`Unhandled fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    renderPage();

    expect(await screen.findByText("暂无模型记录。运行同步后再查看。")).toBeInTheDocument();
    const button = screen.getByRole("button", { name: "立即同步" });
    await user.click(button);
    await user.click(button);

    expect(fetchMock.mock.calls.filter((call) => String(call[0]).endsWith("/api/huggingface/sync"))).toHaveLength(1);
    expect(await screen.findByRole("button", { name: "同步中…" })).toBeDisabled();
    resolveSync();
  });

  it("renders summary, model rows, and partial warnings", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/api/huggingface/status")) {
          return json({
            cacheRoot: "/tmp/hf/hub",
            rootSource: "default",
            counts: {
              total: 1,
              active: 1,
              missing: 0,
              totalSizeBytes: 5,
              largestSizeBytes: 5,
              largestModel: "org/repo",
            },
            lastRun: {
              id: 1,
              status: "partial",
              started_at: "now",
              finished_at: "now",
              inserted: 1,
              updated: 0,
              marked_missing: 0,
              warnings_count: 1,
              error_summary: "Broken snapshot link",
            },
          });
        }
        if (url.includes("/api/huggingface/models")) {
          return json({
            rows: [
              {
                id: 1,
                repo_id: "org/repo",
                cache_root: "/tmp/hf/hub",
                refs_json: JSON.stringify({ main: "abc123" }),
                snapshot_count: 1,
                blob_count: 1,
                size_bytes: 5,
                warnings_json: JSON.stringify([{ message: "Broken snapshot link" }]),
                last_seen_at: "now",
                missing_since: null,
                revisions: [
                  { revision: "abc123", refs: ["main"], file_count: 1, last_modified_ms: Date.UTC(2026, 3, 26), warnings: [] },
                ],
              },
            ],
            total: 1,
            limit: 50,
            offset: 0,
          });
        }
        throw new Error(`Unhandled fetch: ${url}`);
      })
    );

    renderPage();

    expect(await screen.findByText(/已记录 1 个模型/)).toBeInTheDocument();
    expect(await screen.findByText("org/repo")).toBeInTheDocument();
    expect(await screen.findByText(/2026-04-26/)).toBeInTheDocument();
    expect(screen.getAllByText(/warning 1/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Broken snapshot link/).length).toBeGreaterThan(0);
  });

  it("submits root/search filters and paginates with includeMissing", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/huggingface/status")) {
        return json({
          cacheRoot: "/tmp/hf/hub",
          rootSource: "explicit",
          counts: { total: 51, active: 50, missing: 1, totalSizeBytes: 5, largestSizeBytes: 5, largestModel: "org/repo" },
          lastRun: null,
        });
      }
      if (url.includes("/api/huggingface/models")) {
        return json({
          rows: [{ id: 1, repo_id: "org/repo", cache_root: "/tmp/hf/hub", refs_json: "{}", snapshot_count: 0, blob_count: 1, size_bytes: 5, warnings_json: "[]", last_seen_at: "now", missing_since: null, revisions: [] }],
          total: 51,
          limit: 50,
          offset: url.includes("offset=50") ? 50 : 0,
        });
      }
      throw new Error(`Unhandled fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    renderPage();

    await screen.findByText("org/repo");
    await user.type(screen.getByLabelText("cache root"), "/tmp/hf/hub");
    await user.type(screen.getByLabelText("模型"), "org");
    await user.click(screen.getByLabelText("显示已移除"));
    await user.click(screen.getByRole("button", { name: "筛选" }));
    await waitFor(() => {
      expect(fetchMock.mock.calls.some((call) => String(call[0]).includes("root=%2Ftmp%2Fhf%2Fhub"))).toBe(true);
      expect(fetchMock.mock.calls.some((call) => String(call[0]).includes("q=org"))).toBe(true);
      expect(fetchMock.mock.calls.some((call) => String(call[0]).includes("includeMissing=1"))).toBe(true);
    });

    await user.click(screen.getByRole("button", { name: "下一页" }));
    await waitFor(() => {
      expect(fetchMock.mock.calls.some((call) => String(call[0]).includes("offset=50"))).toBe(true);
    });
  });

  it("shows sync errors without clearing loaded data", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/huggingface/status")) {
        return json({
          cacheRoot: "/tmp/hf/hub",
          rootSource: "default",
          counts: { total: 1, active: 1, missing: 0, totalSizeBytes: 5, largestSizeBytes: 5, largestModel: "org/repo" },
          lastRun: null,
        });
      }
      if (url.includes("/api/huggingface/models")) {
        return json({
          rows: [{ id: 1, repo_id: "org/repo", cache_root: "/tmp/hf/hub", refs_json: "{}", snapshot_count: 0, blob_count: 1, size_bytes: 5, warnings_json: "[]", last_seen_at: "now", missing_since: null, revisions: [] }],
          total: 1,
          limit: 50,
          offset: 0,
        });
      }
      if (url.endsWith("/api/huggingface/sync") && init?.method === "POST") {
        return new Response(JSON.stringify({ error: { message: "cannot read cache" } }), { status: 500 });
      }
      throw new Error(`Unhandled fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    renderPage();

    expect(await screen.findByText("org/repo")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "立即同步" }));

    expect(await screen.findByText("cannot read cache")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText("org/repo")).toBeInTheDocument());
  });
});

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
  });
}
