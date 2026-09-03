// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Settings } from "../web/src/pages/Settings";

/**
 * 厂商优先形状的（已脱敏的）凭据值。
 * 密钥不是原文而是 `hasKey` 布尔 —— 前端手上永远没有原文,这是脱敏的硬约束,
 * 也是「密钥搬运只能在服务端做」的原因。
 */
const MULTI_VALUES = {
  defaultModel: { providerId: "deepseek", model: "deepseek-v4-flash" },
  providers: {
    deepseek: {
      provider: "deepseek",
      label: "DeepSeek 官方",
      baseURL: "https://api.deepseek.com",
      enabled: true,
      hasKey: true,
      models: [{ model: "deepseek-v4-flash", label: "DeepSeek Chat" }],
    },
    moonshotai: {
      provider: "moonshotai",
      label: "Moonshot",
      baseURL: "https://api.moonshot.ai/v1",
      enabled: true,
      hasKey: false,
      models: [{ model: "kimi-k2", label: "Kimi K2" }],
    },
  },
};

const STATUS = {
  configured: true,
  defaultModelId: "deepseek:deepseek-v4-flash",
  defaultDisabled: false,
  models: [
    { id: "deepseek:deepseek-v4-flash", label: "DeepSeek Chat", provider: "deepseek", model: "deepseek-v4-flash", available: true, credentialSource: "config" },
    { id: "moonshotai:kimi-k2", label: "Kimi K2", provider: "moonshotai", model: "kimi-k2", available: false, credentialSource: "none" },
  ],
  providers: [
    { id: "deepseek", label: "DeepSeek 官方", provider: "deepseek", baseURL: "https://api.deepseek.com", enabled: true, credentialSource: "config", modelCount: 1 },
    { id: "moonshotai", label: "Moonshot", provider: "moonshotai", baseURL: "https://api.moonshot.ai/v1", enabled: true, credentialSource: "none", modelCount: 1 },
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
function mockApi(opts: { values?: unknown; status?: unknown; catalog?: unknown } = {}) {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === "PATCH") {
        calls.push({ url, body: JSON.parse(String(init.body)) as Record<string, unknown> });
        return json({ ok: true });
      }
      if (url.includes("/api/llm-chat/model-catalog")) {
        if (opts.catalog === "error") return new Response("boom", { status: 500 });
        return json(
          opts.catalog ?? {
            providers: { deepseek: ["deepseek-v4-flash", "deepseek-v4-pro"] },
            source: "cache",
            notes: { volcengine: "火山方舟的对话标识是推理接入点 id（ep-… ），不是模型名，需要手填。" },
          }
        );
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

/** 左栏选中某个厂商，右栏才会渲染它的详情。 */
async function pickProvider(user: ReturnType<typeof userEvent.setup>, name: string | RegExp) {
  await user.click(await screen.findByRole("button", { name }));
}

type ProvidersBody = {
  defaultModel: { providerId: string; model: string } | null;
  providers: Record<string, { models?: unknown[]; apiKey?: string; baseURL?: string } | null>;
};

describe("设置页 · 厂商优先", () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("左栏列出全部厂商，右栏显示选中那家的模型，默认项被选中", async () => {
    mockApi();
    const user = userEvent.setup();
    renderPage();
    await openAiTab(user);

    // 左栏两家都在。
    expect(screen.getByRole("button", { name: /DeepSeek 官方/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Moonshot/ })).toBeInTheDocument();
    // 右栏默认选中第一家，它名下的模型带默认 radio。
    expect(screen.getByRole("radio", { name: /DeepSeek Chat/ })).toBeChecked();
  });

  it("可用性来自后端，不是前端猜的", async () => {
    mockApi();
    const user = userEvent.setup();
    renderPage();
    await openAiTab(user);

    // 「未配 key」来自 status.providers[].credentialSource（含环境变量的判断），
    // 不是前端拿 hasKey 猜的 —— 靠环境变量拿 key 的那种前端根本看不见。
    // 断言落在左栏那两个按钮的可访问名上,而不是裸文本 ——
    // SourceBadge 也会说「已配置」,裸 getByText 会撞上它。
    expect(screen.getByRole("button", { name: /DeepSeek 官方.*已配置/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Moonshot.*未配 key/ })).toBeInTheDocument();
  });

  it("默认模型没有删除按钮 —— 删掉它会连带换掉每日摘要用的模型", async () => {
    mockApi();
    const user = userEvent.setup();
    renderPage();
    await openAiTab(user);

    expect(screen.queryByRole("button", { name: "删除模型「DeepSeek Chat」" })).toBeNull();
    expect(screen.getByText("默认项")).toBeInTheDocument();
  });

  it("★ 含默认模型的厂商整个不可删 —— 否则绕过上一条闸就能静默换家", async () => {
    mockApi();
    const user = userEvent.setup();
    renderPage();
    await openAiTab(user);

    expect(screen.queryByRole("button", { name: "删除这个服务商" })).toBeNull();
    expect(screen.getByText("含默认模型，不可删")).toBeInTheDocument();

    // 把默认换到别家之后，这家才可删。
    await pickProvider(user, /Moonshot/);
    await user.click(screen.getByRole("radio", { name: /Kimi K2/ }));
    await pickProvider(user, /DeepSeek 官方/);
    expect(screen.getByRole("button", { name: "删除这个服务商" })).toBeInTheDocument();
  });

  it("接口类型下拉由接口驱动：后端新增的家会出现，缺中文标签则显示原始 id", async () => {
    mockApi();
    const user = userEvent.setup();
    renderPage();
    await openAiTab(user);

    const select = await screen.findByLabelText("接口类型");
    const options = Array.from(select.querySelectorAll("option")).map((o) => o.textContent);
    expect(options).toContain("火山方舟");
    expect(options).toContain("MiniMax");
    // 前端只维护 id → 中文标签；漏一个的后果是显示原始 id，而不是那家消失。
    expect(options).toContain("some-new-vendor");
  });

  it("保存时每家的 models 发的是完整数组 —— mergePatch 对数组是整体替换", async () => {
    const calls = mockApi();
    const user = userEvent.setup();
    renderPage();
    await openAiTab(user);
    await user.click(screen.getByRole("button", { name: "保存" }));

    const body = calls[0].body as unknown as ProvidersBody;
    expect(body.providers.deepseek?.models).toHaveLength(1);
    expect(body.providers.moonshotai?.models).toHaveLength(1);
    expect(body.defaultModel).toEqual({ providerId: "deepseek", model: "deepseek-v4-flash" });
    // 一个密钥框都没动 → 一个 apiKey 都不发，服务端保留已存的。
    expect("apiKey" in (body.providers.deepseek ?? {})).toBe(false);
    expect("apiKey" in (body.providers.moonshotai ?? {})).toBe(false);
  });

  it("只发有输入的那把密钥，没动的不发 —— mergePatch 递归合并，不会抹掉其余", async () => {
    const calls = mockApi();
    const user = userEvent.setup();
    renderPage();
    await openAiTab(user);

    await pickProvider(user, /Moonshot/);
    await user.type(screen.getByLabelText("API Key"), "sk-new-moonshot");
    await user.click(screen.getByRole("button", { name: "保存" }));

    const body = calls[0].body as unknown as ProvidersBody;
    expect(body.providers.moonshotai?.apiKey).toBe("sk-new-moonshot");
    expect("apiKey" in (body.providers.deepseek ?? {})).toBe(false);
  });

  it("★ 删掉一个厂商发的是显式 null —— providers 是 map，省略只会被当成「别动」", async () => {
    const calls = mockApi();
    const user = userEvent.setup();
    renderPage();
    await openAiTab(user);

    await pickProvider(user, /Moonshot/);
    await user.click(screen.getByRole("button", { name: "删除这个服务商" }));
    await user.click(screen.getByRole("button", { name: "保存" }));

    const body = calls[0].body as unknown as ProvidersBody;
    expect(body.providers.moonshotai).toBeNull();
    expect(body.providers.deepseek).not.toBeNull();
  });

  it("新增的厂商会带上所选接口类型的默认 base URL", async () => {
    const calls = mockApi();
    const user = userEvent.setup();
    renderPage();
    await openAiTab(user);

    await user.click(screen.getByRole("button", { name: "+ 添加服务商" }));
    await user.click(screen.getByRole("button", { name: "保存" }));

    const body = calls[0].body as unknown as ProvidersBody;
    // availableProviders[0] 是 deepseek，id 被占了 → 新实例落在 deepseek-2。
    expect(body.providers["deepseek-2"]).toMatchObject({
      baseURL: "https://api.deepseek.com",
    });
  });

  it("★ 刚添加、还没选模型的厂商仍留在左栏 —— 那是配置新厂商必经的一秒", async () => {
    mockApi();
    const user = userEvent.setup();
    renderPage();
    await openAiTab(user);

    await user.click(screen.getByRole("button", { name: "+ 添加服务商" }));
    // 0 个模型，但左栏必须看得见它，否则用户以为没添加成功。
    expect(screen.getByRole("button", { name: /0 个模型/ })).toBeInTheDocument();
  });

  it("★ 默认厂商被关掉时给出黄条，并点名 RAG —— 它不是降级而是直接抛", async () => {
    mockApi({ status: { ...STATUS, defaultDisabled: true } });
    const user = userEvent.setup();
    renderPage();
    await openAiTab(user);

    expect(screen.getByText(/RAG 向量化会直接报错/)).toBeInTheDocument();
  });

  it("status 接口挂了也不白屏 —— 一个可选查询不该有这种爆炸半径", async () => {
    mockApi({ status: "error" });
    const user = userEvent.setup();
    renderPage();
    await openAiTab(user);

    // 厂商列表来自 /api/settings，与 status 无关，仍然渲染。
    expect(screen.getByRole("button", { name: /DeepSeek 官方/ })).toBeInTheDocument();
    // 只是后端那份可用性判断没了，降级用本地 hasKey（moonshotai 的 hasKey 是 false）。
    expect(screen.getByText("未配 key")).toBeInTheDocument();
  });

  it("完全没配过时给出引导，而不是一个空表格", async () => {
    mockApi({
      values: null,
      status: { ...STATUS, configured: false, models: [], providers: [], defaultModelId: null },
    });
    const user = userEvent.setup();
    renderPage();
    await openAiTab(user);

    expect(screen.getByText("还没有服务商")).toBeInTheDocument();
    // 但接口类型清单已经就位，点「添加服务商」就能开始配。
    expect(screen.getByRole("button", { name: "+ 添加服务商" })).toBeInTheDocument();
  });

  it("★ SC9 模型输入框带目录候选 —— 手敲一个已退役的模型名正是要修的症状", async () => {
    mockApi();
    const user = userEvent.setup();
    const { container } = renderPage();
    await openAiTab(user);

    const input = await screen.findByLabelText("模型 ID");
    const listId = input.getAttribute("list");
    expect(listId).toBeTruthy();
    const options = [...container.querySelectorAll(`#${listId} option`)].map((o) =>
      o.getAttribute("value")
    );
    expect(options).toEqual(["deepseek-v4-flash", "deepseek-v4-pro"]);
  });

  it("★ 用 datalist 而不是 select —— 目录列不全的必须还能手填", async () => {
    // 火山的对话标识是接入点 id(ep-…),私有部署更不在任何目录里。
    // select 会把这两种情况变成「配不了」。
    mockApi();
    const user = userEvent.setup();
    renderPage();
    await openAiTab(user);
    const input = await screen.findByLabelText("模型 ID");
    expect(input.tagName).toBe("INPUT");
    await user.clear(input);
    await user.type(input, "ep-20260903-自己的接入点");
    expect(input).toHaveValue("ep-20260903-自己的接入点");
  });

  it("★ 目录接口挂了不影响页面 —— 降级成纯手填,不是白屏", async () => {
    mockApi({ catalog: "error" });
    const user = userEvent.setup();
    const { container } = renderPage();
    await openAiTab(user);

    // 厂商列表照常(它来自 /api/settings,与目录无关)。
    expect(screen.getByRole("button", { name: /DeepSeek 官方/ })).toBeInTheDocument();
    const input = await screen.findByLabelText("模型 ID");
    expect(input).toHaveValue("deepseek-v4-flash");
    // 只是候选没了。
    const listId = input.getAttribute("list");
    expect([...container.querySelectorAll(`#${listId} option`)]).toHaveLength(0);
  });
});
