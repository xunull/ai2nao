// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Settings } from "../web/src/pages/Settings";

/** 多模型形状的（已脱敏的）凭据值：models 完整，keys 只是 presence map。 */
const MULTI_VALUES = {
  defaultModelId: "ds",
  keys: { deepseek: true, moonshotai: false },
  models: [
    {
      id: "ds",
      label: "DeepSeek Chat",
      provider: "deepseek",
      model: "deepseek-v4-flash",
      baseURL: "https://api.deepseek.com",
      keyRef: "deepseek",
    },
    {
      id: "kimi",
      label: "Kimi K2",
      provider: "moonshotai",
      model: "kimi-k2",
      baseURL: "https://api.moonshot.ai/v1",
      keyRef: "moonshotai",
    },
  ],
};

const STATUS = {
  configured: true,
  defaultModelId: "ds",
  models: [
    { id: "ds", label: "DeepSeek Chat", provider: "deepseek", model: "deepseek-v4-flash", available: true, credentialSource: "config" },
    { id: "kimi", label: "Kimi K2", provider: "moonshotai", model: "kimi-k2", available: false, credentialSource: "none" },
  ],
  availableProviders: [
    { id: "deepseek", defaultBaseURL: "https://api.deepseek.com" },
    { id: "moonshotai", defaultBaseURL: "https://api.moonshot.ai/v1" },
    { id: "volcengine", defaultBaseURL: "https://ark.cn-beijing.volces.com/api/v3" },
    { id: "minimax", defaultBaseURL: "https://api.minimaxi.com/v1" },
    // 后端加了一家而前端没给中文标签 —— 必须降级成显示原始 id，不能消失。
    { id: "some-new-vendor", defaultBaseURL: "https://example.invalid/v1" },
  ],
};

function json(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function settingsPayload(values: unknown) {
  const blank = { set: false, source: null, label: "x", values: null };
  return {
    scanRoots: [],
    scanMaxDepth: 8,
    scanMaxDocs: 100,
    scanConcurrency: 16,
    replayGapMinutes: 120,
    github: { set: false, source: null },
    credentials: {
      "llm-chat": { set: true, source: "db", label: "AI 对话模型", values },
      "rag-embedding": blank,
      "web-search": blank,
      github: blank,
      feishu: blank,
      minimax: blank,
    },
    settings: { "rag-corpus": { set: false, source: null, label: "RAG 语料", values: null } },
  };
}

/** 按 URL 分派；PATCH 的 body 收集起来供断言。 */
function mockApi(opts: { values?: unknown; status?: unknown } = {}) {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === "PATCH") {
        calls.push({ url, body: JSON.parse(String(init.body)) as Record<string, unknown> });
        return json({ ok: true });
      }
      if (url.includes("/api/llm-chat/status")) {
        if (opts.status === "error") return new Response("boom", { status: 500 });
        return json(opts.status ?? STATUS);
      }
      return json(settingsPayload("values" in opts ? opts.values : MULTI_VALUES));
    })
  );
  return calls;
}

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <Settings />
    </QueryClientProvider>
  );
}

async function openAiTab(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole("button", { name: "AI 与模型" }));
  await screen.findByRole("heading", { name: "AI 对话模型" });
}

describe("设置页 · 多模型条目", () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("列出全部模型，默认项被选中", async () => {
    mockApi();
    const user = userEvent.setup();
    renderPage();
    await openAiTab(user);

    expect(screen.getByText("DeepSeek Chat")).toBeInTheDocument();
    expect(screen.getByText("Kimi K2")).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /DeepSeek Chat/ })).toBeChecked();
    expect(screen.getByRole("radio", { name: /Kimi K2/ })).not.toBeChecked();
  });

  it("可用性来自后端，不是前端猜的", async () => {
    mockApi();
    const user = userEvent.setup();
    renderPage();
    await openAiTab(user);

    // 「未配 key」只可能来自模型行的可用性徽章（SourceBadge 不会说这个），
    // 而它的值来自后端的 credentialSource，不是前端拿 keys 猜的。
    expect(screen.getByText("未配 key")).toBeInTheDocument();
  });

  it("默认项没有删除按钮 —— 删掉它会连带换掉每日摘要用的模型", async () => {
    mockApi();
    const user = userEvent.setup();
    renderPage();
    await openAiTab(user);

    expect(screen.queryByRole("button", { name: "删除「DeepSeek Chat」" })).toBeNull();
    expect(screen.getByRole("button", { name: "删除「Kimi K2」" })).toBeInTheDocument();
  });

  it("换默认项之后，原来的默认项才可删", async () => {
    mockApi();
    const user = userEvent.setup();
    renderPage();
    await openAiTab(user);

    await user.click(screen.getByRole("radio", { name: /Kimi K2/ }));
    expect(screen.getByRole("button", { name: "删除「DeepSeek Chat」" })).toBeInTheDocument();
  });

  it("服务商下拉由接口驱动：后端新增的家会出现，缺中文标签则显示原始 id", async () => {
    mockApi();
    const user = userEvent.setup();
    renderPage();
    await openAiTab(user);
    await user.click(screen.getAllByRole("button", { name: "编辑" })[0]);

    const select = await screen.findByLabelText("服务商");
    const options = Array.from(select.querySelectorAll("option")).map((o) => o.textContent);
    expect(options).toContain("火山方舟");
    expect(options).toContain("MiniMax");
    // 前端只维护 id → 中文标签；漏一个的后果是显示原始 id，而不是那家消失。
    expect(options).toContain("some-new-vendor");
  });

  it("保存时 models 发的是完整数组 —— mergePatch 对数组是整体替换", async () => {
    const calls = mockApi();
    const user = userEvent.setup();
    renderPage();
    await openAiTab(user);
    await user.click(screen.getByRole("button", { name: "保存" }));

    const body = calls[0].body as { models: unknown[]; defaultModelId: string; keys?: unknown };
    expect(body.models).toHaveLength(2);
    expect(body.defaultModelId).toBe("ds");
    // 一个密钥框都没动 → 不发 keys，服务端保留已存的。
    expect("keys" in body).toBe(false);
  });

  it("只发有输入的那把密钥，没动的不发 —— mergePatch 递归合并，不会抹掉其余", async () => {
    const calls = mockApi();
    const user = userEvent.setup();
    renderPage();
    await openAiTab(user);

    await user.type(screen.getByLabelText("Moonshot（Kimi）"), "sk-new-moonshot");
    await user.click(screen.getByRole("button", { name: "保存" }));

    const body = calls[0].body as { keys: Record<string, string> };
    expect(Object.keys(body.keys)).toEqual(["moonshotai"]);
    expect(body.keys.moonshotai).toBe("sk-new-moonshot");
  });

  it("新增的条目会带上所选服务商的默认 base URL", async () => {
    const calls = mockApi();
    const user = userEvent.setup();
    renderPage();
    await openAiTab(user);

    await user.click(screen.getByRole("button", { name: "+ 添加模型" }));
    await user.type(await screen.findByLabelText("模型"), "deepseek-v4-pro");
    await user.click(screen.getByRole("button", { name: "保存" }));

    const body = calls[0].body as { models: { baseURL: string; model: string }[] };
    expect(body.models).toHaveLength(3);
    expect(body.models[2]).toMatchObject({
      model: "deepseek-v4-pro",
      baseURL: "https://api.deepseek.com",
    });
  });

  it("status 接口挂了也不白屏 —— 一个可选查询不该有这种爆炸半径", async () => {
    mockApi({ status: "error" });
    const user = userEvent.setup();
    renderPage();
    await openAiTab(user);

    // 模型列表来自 /api/settings，与 status 无关，仍然渲染。
    expect(screen.getByText("DeepSeek Chat")).toBeInTheDocument();
    // 只是可用性徽章没了（列表本身不依赖 status）。
    expect(screen.queryByText("未配 key")).toBeNull();
  });

  it("完全没配过时给出引导，而不是一个空表格", async () => {
    mockApi({ values: null, status: { ...STATUS, configured: false, models: [], defaultModelId: null } });
    const user = userEvent.setup();
    renderPage();
    await openAiTab(user);

    expect(screen.getByText(/还没有配置任何模型/)).toBeInTheDocument();
    // 但服务商下拉的数据已经就位，点「添加模型」就能开始配。
    expect(screen.getByRole("button", { name: "+ 添加模型" })).toBeInTheDocument();
  });
});
