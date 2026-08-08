// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Settings } from "../web/src/pages/Settings";

type Cred = {
  set: boolean;
  source: "env" | "db" | "file" | null;
  label: string;
  values: Record<string, unknown> | null;
};

function cred(over: Partial<Cred> = {}): Cred {
  return { set: false, source: null, label: "x", values: null, ...over };
}

function settingsPayload(over: Record<string, Partial<Cred>> = {}) {
  return {
    scanRoots: [],
    scanMaxDepth: 8,
    scanMaxDocs: 100,
    scanConcurrency: 16,
    replayGapMinutes: 120,
    github: { set: false, source: null },
    credentials: {
      "llm-chat": cred({
        set: true,
        source: "db",
        // The server sends the config WITHOUT the key — that is the contract
        // this page is built on.
        values: { provider: "deepseek", model: "deepseek-reasoner", baseURL: "https://api.deepseek.com" },
        ...over["llm-chat"],
      }),
      "rag-embedding": cred(over["rag-embedding"]),
      "web-search": cred(over["web-search"]),
      github: cred(over.github),
      feishu: cred(over.feishu),
      minimax: cred(over.minimax),
    },
    settings: {
      "rag-corpus": { set: false, source: null, label: "RAG 语料", values: null },
    },
  };
}

function json(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <Settings />
    </QueryClientProvider>
  );
}

describe("Settings page", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("switches categories and never renders a stored key", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json(settingsPayload()))
    );
    const user = userEvent.setup();
    renderPage();

    // Lands on 通用.
    expect(await screen.findByRole("heading", { name: "默认扫描根目录" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "AI 与模型" }));
    expect(await screen.findByRole("heading", { name: "AI 对话模型" })).toBeInTheDocument();
    // Non-secret fields come back and populate the form…
    expect(screen.getByLabelText("模型")).toHaveValue("deepseek-reasoner");
    // …but the key box is empty with a "leave it alone" placeholder, because the
    // server never sends the key at all.
    const keyBox = screen.getByLabelText("API Key");
    expect(keyBox).toHaveValue("");
    expect(keyBox).toHaveAttribute("placeholder", "已保存 · 留空则不改动");

    await user.click(screen.getByRole("button", { name: "通知" }));
    expect(await screen.findByRole("heading", { name: "飞书推送" })).toBeInTheDocument();
  });

  it("saving with an empty key box omits apiKey — which is what stops it wiping the key", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (init?.method === "PATCH") {
          calls.push({ url, body: JSON.parse(String(init.body)) });
          return json({ credential: cred({ set: true, source: "db" }) });
        }
        return json(settingsPayload());
      })
    );
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole("button", { name: "AI 与模型" }));
    const model = await screen.findByLabelText("模型");
    await user.clear(model);
    await user.type(model, "deepseek-chat");
    await user.click(screen.getByRole("button", { name: "保存" }));

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain("/api/settings/secret/llm-chat");
    const body = calls[0].body as Record<string, unknown>;
    expect(body.model).toBe("deepseek-chat");
    // The whole point: no apiKey field at all, so the server keeps the stored one.
    expect("apiKey" in body).toBe(false);
  });

  it("an env-managed credential says so and disables the input", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        json(settingsPayload({ github: { set: true, source: "env", values: null } }))
      )
    );
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole("button", { name: "数据源" }));
    expect(await screen.findByRole("heading", { name: "GitHub Token" })).toBeInTheDocument();
    // Saving would "succeed" while the env var kept winning — so say it, and
    // don't let the user type into a field that cannot take effect.
    expect(screen.getByText(/由 GITHUB_TOKEN 接管/)).toBeInTheDocument();
    expect(screen.getByLabelText("Token")).toBeDisabled();
  });

  it("a credential still on the legacy JSON file says migration will move it", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        json(settingsPayload({ "web-search": { set: true, source: "file", values: {} } }))
      )
    );
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole("button", { name: "数据源" }));
    expect(await screen.findByText(/仍在读旧的 JSON 文件/)).toBeInTheDocument();
  });

  it("回放分段阈值:显示当前值,失焦时 PATCH 出去", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === "PATCH") {
          calls.push({ url: String(input), body: JSON.parse(String(init.body)) });
        }
        return json(settingsPayload());
      })
    );
    const user = userEvent.setup();
    renderPage();

    // 落在「通用」上,和扫描设置同一屏。
    const box = await screen.findByLabelText("分段间隔");
    expect(box).toHaveValue(120);

    await user.clear(box);
    await user.type(box, "30");
    await user.tab(); // 失焦提交,和旁边几个数字框一致

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain("/api/settings");
    expect(calls[0].body).toEqual({ replayGapMinutes: 30 });
  });

  it("回放分段阈值:越界的输入不发请求,并弹回原值", async () => {
    const calls: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === "PATCH") calls.push(init.body);
        return json(settingsPayload());
      })
    );
    const user = userEvent.setup();
    renderPage();

    const box = await screen.findByLabelText("分段间隔");
    await user.clear(box);
    await user.type(box, "0");
    await user.tab();

    // 服务端也会拒(400),但让一个必然失败的请求飞出去只会换来一条红字。
    expect(calls).toHaveLength(0);
    expect(box).toHaveValue(120);
  });
});
