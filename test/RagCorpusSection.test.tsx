// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RagCorpusSection } from "../web/src/pages/settings/RagCorpusSection";

type Setting = {
  set: boolean;
  source: "db" | "file" | null;
  label: string;
  values: Record<string, unknown> | null;
};

function renderSection(setting: Setting, fetchMock: ReturnType<typeof vi.fn>) {
  vi.stubGlobal("fetch", fetchMock);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <RagCorpusSection setting={setting} onChanged={() => {}} />
    </QueryClientProvider>
  );
}

describe("RagCorpusSection", () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("save is disabled with no roots (server rejects an empty corpus anyway)", () => {
    renderSection({ set: false, source: null, label: "RAG 语料", values: null }, vi.fn());
    // Nothing configured → the only button reads 接管配置 and is off until a root exists.
    expect(screen.getByRole("button", { name: "接管配置" })).toBeDisabled();
  });

  it("adding a root enables save and PATCHes it to /api/settings/setting/rag-corpus", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), body: JSON.parse(String(init?.body)) });
      return new Response(JSON.stringify({ setting: {} }), { status: 200 });
    });
    renderSection({ set: false, source: null, label: "RAG 语料", values: null }, fetchMock);
    const user = userEvent.setup();

    await user.type(screen.getByLabelText("新增语料根目录"), "/Users/me/notes");
    await user.click(screen.getByRole("button", { name: "添加" }));

    const saveBtn = screen.getByRole("button", { name: "接管配置" });
    expect(saveBtn).toBeEnabled();
    await user.click(saveBtn);

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain("/api/settings/setting/rag-corpus");
    const body = calls[0].body as { corpusRoots: string[]; maxFileBytes: number };
    expect(body.corpusRoots).toEqual(["/Users/me/notes"]);
    expect(body.maxFileBytes).toBeGreaterThan(0);
  });

  it("populates from stored values and says it is settings-managed", () => {
    renderSection(
      {
        set: true,
        source: "db",
        label: "RAG 语料",
        values: { corpusRoots: ["/a", "/b"], maxFileBytes: 4 * 1024 * 1024 },
      },
      vi.fn()
    );
    expect(screen.getByText("/a")).toBeInTheDocument();
    expect(screen.getByText("/b")).toBeInTheDocument();
    expect(screen.getByText("已在设置中管理")).toBeInTheDocument();
    // db-managed → the button reads 保存, and a 清除 exists.
    expect(screen.getByRole("button", { name: "保存" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "清除" })).toBeInTheDocument();
  });

  it("while still on rag.json, the button offers to take the config over", () => {
    renderSection(
      { set: true, source: "file", label: "RAG 语料", values: { corpusRoots: ["/from/file"] } },
      vi.fn()
    );
    expect(screen.getByText(/rag\.json/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "接管配置" })).toBeEnabled();
  });
});
