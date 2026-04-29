// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import React from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AtuinDirectories } from "../web/src/pages/AtuinDirectories";

function renderPage(initialEntry = "/atuin/directories?mode=filtered") {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <AtuinDirectories />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

describe("AtuinDirectories page", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("renders status, top directories, and selected command aggregates", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/api/atuin/directories/status")) {
          return json({
            enabled: true,
            atuinPath: "/tmp/history.db",
            directoryActivity: {
              ruleVersion: 1,
              configPath: "/tmp/config.json",
              configOk: true,
              configIssues: [],
              filterConfigHash: "abc",
              state: {
                last_rebuilt_at: "now",
                last_error: null,
                error_code: null,
                source_entry_count: 3,
                derived_directory_count: 1,
                derived_command_count: 2,
                last_rebuild_duration_ms: 12,
              },
              currentDerivedDirectoryCount: 1,
              currentDerivedCommandCount: 2,
              fresh: true,
              staleReasons: [],
            },
          });
        }
        if (url.includes("/api/atuin/directories/top")) {
          return json({
            directories: [
              {
                cwd: "/repo",
                raw_command_count: 3,
                filtered_command_count: 2,
                raw_failed_count: 1,
                filtered_failed_count: 1,
                first_timestamp_ns: 1,
                last_timestamp_ns: 2_000_000,
                last_exit: 0,
                updated_at: "now",
              },
            ],
          });
        }
        if (url.includes("/api/atuin/directories/commands")) {
          return json({
            commands: [
              {
                cwd: "/repo",
                command: "npm test",
                raw_count: 2,
                filtered_count: 2,
                raw_failed_count: 1,
                filtered_failed_count: 1,
                first_timestamp_ns: 1,
                last_timestamp_ns: 2_000_000,
                last_exit: 0,
                updated_at: "now",
              },
            ],
          });
        }
        throw new Error(`Unhandled fetch: ${url}`);
      })
    );

    const user = userEvent.setup();
    renderPage();

    expect(await screen.findByText("Atuin 目录活动")).toBeInTheDocument();
    expect(await screen.findByText("/tmp/history.db")).toBeInTheDocument();
    await user.click(await screen.findByText("/repo"));
    expect(await screen.findByText("npm test")).toBeInTheDocument();
    expect(screen.getAllByText("2").length).toBeGreaterThan(0);
  });

  it("debounces search and shows config errors in status", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/atuin/directories/status")) {
        return json({
          enabled: false,
          atuinPath: null,
          directoryActivity: {
            ruleVersion: 1,
            configPath: "/tmp/config.json",
            configOk: false,
            configIssues: [{ path: "$.atuin.directoryActivity", message: "bad config" }],
            filterConfigHash: null,
            state: null,
            currentDerivedDirectoryCount: 0,
            currentDerivedCommandCount: 0,
            fresh: false,
            staleReasons: ["not_built", "config_error"],
          },
        });
      }
      if (url.includes("/api/atuin/directories/top")) {
        return json({ directories: [] });
      }
      if (url.includes("/api/atuin/directories/search")) {
        return json({ directories: [] });
      }
      throw new Error(`Unhandled fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const user = userEvent.setup();
    renderPage();

    expect(await screen.findByText(/bad config/)).toBeInTheDocument();
    await user.type(screen.getByLabelText("搜索目录"), "repo");
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some((call) =>
          String(call[0]).includes("/api/atuin/directories/search")
        )
      ).toBe(true)
    );
  });
});

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
  });
}
