// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LmStudioModels } from "../web/src/pages/LmStudioModels";

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <LmStudioModels />
    </QueryClientProvider>
  );
}

describe("LmStudioModels page", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("renders status warnings, model rows, and disables sync while pending", async () => {
    let resolveSync!: () => void;
    const pending = new Promise<Response>((resolve) => {
      resolveSync = () => resolve(json({ ok: true, status: "success", warnings: [] }));
    });
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/lmstudio/status")) {
        return json({
          modelsRoot: "/tmp/lm/models",
          rootSource: "app_settings",
          settingsPath: "/tmp/settings.json",
          alternativeRoots: [{ source: "home_settings", modelsRoot: "/tmp/other", settingsPath: "/tmp/home.json" }],
          warnings: [{ code: "settings_roots_conflict", message: "LM Studio settings disagree" }],
          counts: { total: 1, active: 1, missing: 0, totalSizeBytes: 7, largestSizeBytes: 7, largestModel: "org/repo" },
          lastRun: null,
        });
      }
      if (url.includes("/api/lmstudio/models")) {
        return json({
          rows: [
            {
              id: 1,
              model_key: "org/repo",
              models_root: "/tmp/lm/models",
              format: "gguf",
              weight_file_count: 1,
              auxiliary_file_count: 1,
              total_file_count: 2,
              total_size_bytes: 7,
              weight_size_bytes: 5,
              primary_file: "repo.gguf",
              warnings_json: "[]",
              last_modified_ms: Date.UTC(2026, 3, 30),
              missing_since: null,
              files: [{ rel_path: "repo.gguf", file_kind: "weight", format: "gguf", size_bytes: 5, is_symlink: 1, warnings: [] }],
            },
          ],
          total: 1,
          limit: 50,
          offset: 0,
        });
      }
      if (url.endsWith("/api/lmstudio/sync") && init?.method === "POST") return pending;
      throw new Error(`Unhandled fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    renderPage();

    expect(await screen.findByText(/已记录 1 个模型/)).toBeInTheDocument();
    expect(await screen.findByText("org/repo")).toBeInTheDocument();
    expect(screen.getByText(/LM Studio settings disagree/)).toBeInTheDocument();
    expect(screen.getAllByText(/repo.gguf/).length).toBeGreaterThan(0);

    const button = screen.getByRole("button", { name: "立即同步" });
    await user.click(button);
    await user.click(button);
    expect(fetchMock.mock.calls.filter((call) => String(call[0]).endsWith("/api/lmstudio/sync"))).toHaveLength(1);
    expect(await screen.findByRole("button", { name: "同步中…" })).toBeDisabled();
    resolveSync();
  });

  it("submits root, search, format, includeMissing, and pagination", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/lmstudio/status")) {
        return json({
          modelsRoot: "/tmp/lm/models",
          rootSource: "explicit",
          settingsPath: null,
          alternativeRoots: [],
          warnings: [],
          counts: { total: 51, active: 50, missing: 1, totalSizeBytes: 7, largestSizeBytes: 7, largestModel: "org/repo" },
          lastRun: null,
        });
      }
      if (url.includes("/api/lmstudio/models")) {
        return json({
          rows: [{ id: 1, model_key: "org/repo", models_root: "/tmp/lm/models", format: "gguf", weight_file_count: 1, auxiliary_file_count: 0, total_file_count: 1, total_size_bytes: 5, weight_size_bytes: 5, primary_file: "repo.gguf", warnings_json: "[]", last_modified_ms: null, missing_since: null, files: [] }],
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
    await user.type(screen.getByLabelText("models root"), "/tmp/lm/models");
    await user.type(screen.getByLabelText("模型"), "org");
    await user.selectOptions(screen.getByLabelText("format"), "gguf");
    await user.click(screen.getByLabelText("显示已移除"));
    await user.click(screen.getByRole("button", { name: "筛选" }));
    await waitFor(() => {
      expect(fetchMock.mock.calls.some((call) => String(call[0]).includes("root=%2Ftmp%2Flm%2Fmodels"))).toBe(true);
      expect(fetchMock.mock.calls.some((call) => String(call[0]).includes("q=org"))).toBe(true);
      expect(fetchMock.mock.calls.some((call) => String(call[0]).includes("format=gguf"))).toBe(true);
      expect(fetchMock.mock.calls.some((call) => String(call[0]).includes("includeMissing=1"))).toBe(true);
    });

    await user.click(screen.getByRole("button", { name: "下一页" }));
    await waitFor(() => {
      expect(fetchMock.mock.calls.some((call) => String(call[0]).includes("offset=50"))).toBe(true);
    });
  });
});

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
}
