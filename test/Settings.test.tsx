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
        // 服务端发的是**脱敏后**的配置：没有密钥原文，每个厂商实例只有一个
        // hasKey 布尔告诉界面它配过没有（见 schema.ts 的 redactLlmChat）。
        // 形状已经由服务端归一成 providers{} —— 旧的单模型配置在 parse 阶段
        // 就被搬成了「一个实例一条模型」，前端不再需要认识旧形状。
        values: {
          defaultModel: { providerId: "deepseek", model: "deepseek-reasoner" },
          providers: {
            deepseek: {
              provider: "deepseek",
              label: "DeepSeek",
              baseURL: "https://api.deepseek.com",
              enabled: true,
              hasKey: true,
              models: [{ model: "deepseek-reasoner", label: "deepseek-reasoner" }],
            },
          },
        },
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
    // 服务端搬过来的那一条必须显示出来 —— 老用户升级后 picker 不能是空的。
    expect(screen.getByRole("button", { name: /DeepSeek/ })).toBeInTheDocument();
    expect(screen.getByLabelText("模型 ID")).toHaveValue("deepseek-reasoner");
    // 密钥框仍然是空的 + 「留空则不改动」:服务端从不回传密钥，
    // 「已保存」这个状态靠脱敏时给每个实例映射出来的 hasKey 布尔。
    const keyBox = screen.getByLabelText("API Key");
    expect(keyBox).toHaveValue("");
    expect(keyBox).toHaveAttribute("placeholder", "已保存 · 留空则不改动");

    await user.click(screen.getByRole("button", { name: "通知" }));
    expect(await screen.findByRole("heading", { name: "飞书推送" })).toBeInTheDocument();
  });

  it("密钥框留空时不发 keys 字段 —— 这才是「不抹掉已存密钥」的机制", async () => {
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
    // 右栏跟着左栏的选中项直接展开，没有「编辑」这一跳。
    const model = await screen.findByLabelText("模型 ID");
    await user.clear(model);
    await user.type(model, "deepseek-v4-flash");
    await user.click(screen.getByRole("button", { name: "保存" }));

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain("/api/settings/secret/llm-chat");
    const body = calls[0].body as {
      providers: Record<string, { models: { model: string }[]; apiKey?: string }>;
    };
    // models 必须是完整数组：mergePatch 对数组是整体替换，发一半等于删掉另一半。
    expect(body.providers.deepseek.models).toHaveLength(1);
    expect(body.providers.deepseek.models[0].model).toBe("deepseek-v4-flash");
    // 关键：一个 apiKey 都不发，服务端保留已存的密钥。
    expect("apiKey" in body.providers.deepseek).toBe(false);
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
