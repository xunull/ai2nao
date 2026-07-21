// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AiTools } from "../web/src/pages/AiTools";

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <AiTools />
    </QueryClientProvider>
  );
}

const TOOL = (over: Record<string, unknown>) => ({
  version: null,
  installPath: null,
  vendor: null,
  firstSeenAt: "2026-07-21T00:00:00.000Z",
  lastSeenAt: "2026-07-21T02:00:00.000Z",
  missingSince: null,
  ...over,
});

describe("AiTools page", () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("按 kind 分组展示,折叠工具的多来源显示为多个徽章(F2)", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/ai-tools/status")) {
        return json({ total: 2, present: 2, lastSyncAt: "2026-07-21T02:00:00.000Z" });
      }
      return json({
        total: 2,
        groups: [
          {
            kind: "desktop-app",
            label: "桌面 app",
            tools: [
              TOOL({
                toolKey: "claude-desktop",
                name: "Claude",
                kind: "desktop-app",
                vendor: "Anthropic",
                detectSources: ["mac_apps"],
                installPath: "/Applications/Claude.app",
              }),
            ],
          },
          {
            kind: "local-runtime",
            label: "本地运行时",
            tools: [
              TOOL({
                toolKey: "ollama",
                name: "Ollama",
                kind: "local-runtime",
                detectSources: ["brew", "path"],
                version: "0.1.0",
              }),
            ],
          },
        ],
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    renderPage();

    // 两个工具都渲染,并落在各自的 kind 分组里。
    expect(await screen.findByText("Claude")).toBeInTheDocument();
    expect(await screen.findByText("Ollama")).toBeInTheDocument();
    expect(screen.getByText("桌面 app")).toBeInTheDocument();
    expect(screen.getByText("本地运行时")).toBeInTheDocument();

    // F2:Ollama 折叠自 brew + path 两源 → 两个来源徽章都在。
    expect(screen.getByText("Homebrew")).toBeInTheDocument();
    expect(screen.getByText("PATH")).toBeInTheDocument();
    // Claude 只有「应用」来源。
    expect(screen.getByText("应用")).toBeInTheDocument();
  });

  it("空清单时提示先扫描", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/ai-tools/status")) {
        return json({ total: 0, present: 0, lastSyncAt: null });
      }
      return json({ total: 0, groups: [] });
    });
    vi.stubGlobal("fetch", fetchMock);

    renderPage();
    expect(await screen.findByText(/暂无记录/)).toBeInTheDocument();
  });
});
