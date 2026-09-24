import { test, expect, type Page } from "@playwright/test";

/**
 * 重新生成 / 编辑重发 / 分支切换,在**真的浏览器**里点真的按钮。
 *
 * 为什么必须是 e2e:这三个功能的语义有一半在 CopilotKit 的运行时约定里 ——
 * 回调只发事件、按钮「挂了监听才渲染」、`useAgent` 的 threadId 回退依赖组件
 * 在 React 树上的位置。tsc 与单测对这些一律照不出来,只有真的点一次才知道。
 */

type Msg = { id: string; role: string; content: string };

/** 服务端的树。e2e 里只需要它的形状,不需要真的 SQLite。 */
class Tree {
  nodes = new Map<string, { msg: Msg; parent: string | null }>();
  leaf: string | null = null;

  add(msg: Msg, parent: string | null): void {
    this.nodes.set(msg.id, { msg, parent });
    this.leaf = msg.id;
  }

  path(): Msg[] {
    const out: Msg[] = [];
    let cur = this.leaf;
    const seen = new Set<string>();
    while (cur && !seen.has(cur)) {
      seen.add(cur);
      const node = this.nodes.get(cur);
      if (!node) break;
      out.unshift(node.msg);
      cur = node.parent;
    }
    return out;
  }

  parentOf(id: string): string | null {
    return this.nodes.get(id)?.parent ?? null;
  }

  siblingsOf(id: string): string[] {
    const parent = this.parentOf(id);
    return [...this.nodes.entries()].filter(([, n]) => n.parent === parent).map(([k]) => k);
  }

  deepestFrom(id: string): string {
    let cur = id;
    for (;;) {
      const kids = [...this.nodes.entries()].filter(([, n]) => n.parent === cur).map(([k]) => k);
      if (kids.length === 0) return cur;
      cur = kids[kids.length - 1]!;
    }
  }
}

const sse = (v: unknown) => `data: ${JSON.stringify(v)}\n\n`;

async function mount(page: Page, tree: Tree) {
  const runs: { threadId: string; messages: Msg[] }[] = [];
  const leaked: string[] = [];
  let answerSeq = 0;

  // **没 mock 的 /api 一律掐断。**
  // vite 的 preview 继承 server.proxy,会把 /api 转给本机 :8787 —— 那是真实应用,
  // 连着真实的库。漏一条路由的后果不是测试变红,是拿用户的数据和钱跑测试。
  // 先注册 = 最低优先级(Playwright 后注册的先匹配),所以它只兜没被 mock 的。
  await page.route("**/api/**", (route) => {
    leaked.push(new URL(route.request().url()).pathname);
    return route.abort();
  });

  await page.route("**/api/llm-chat/sessions*", (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/llm-chat/sessions" && route.request().method() === "GET") {
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          sessions: [{ id: "s1", title: "测试会话", message_count: tree.nodes.size }],
        }),
      });
    }
    return route.fulfill({ contentType: "application/json", body: "{}" });
  });

  await page.route("**/api/llm-chat/sessions/s1/branches", (route) => {
    const questions: Record<string, unknown> = {};
    const answers: Record<string, unknown> = {};
    for (const m of tree.path()) {
      const sibs = tree.siblingsOf(m.id);
      if (sibs.length <= 1) continue;
      const pos = { branchIndex: sibs.indexOf(m.id), numberOfBranches: sibs.length };
      (m.role === "user" ? questions : answers)[m.id] = pos;
    }
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ questions, answers }),
    });
  });

  await page.route("**/api/llm-chat/sessions/s1/branch", (route) => {
    const body = route.request().postDataJSON() as {
      action: string;
      messageId: string;
      branchIndex?: number;
    };
    if (body.action === "switch") {
      const target =
        body.branchIndex == null
          ? body.messageId
          : (tree.siblingsOf(body.messageId)[body.branchIndex] ?? body.messageId);
      tree.leaf = tree.deepestFrom(target);
    } else {
      tree.leaf = tree.parentOf(body.messageId);
    }
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        activeLeafMessageId: tree.leaf ?? "",
        activePathIds: tree.path().map((m) => m.id),
        needsRun: body.action !== "switch",
      }),
    });
  });

  for (const p of [
    ["**/api/llm-chat/status", { configured: true, provider: "openai-compatible", model: "m" }],
    ["**/api/rag/status", { ok: true, corpusRoots: [], embeddingEnabled: false, chunkCount: 0 }],
    ["**/api/web-search/status", { provider: "brave", configured: false, ok: false }],
    ["**/api/code-runner/status", { pyodide: { available: false }, docker: { available: false } }],
    ["**/api/bash-approvals**", { approvals: [] }],
    ["**/api/llm-chat/model-catalog**", { source: "manual", models: [] }],
    [
      "**/api/llm-chat/sessions/s1/usage",
      {
        usage: {
          byRun: {},
          byAssistantMessage: {},
          byReasoningMessage: {},
          session: {
            costUsd: 0,
            inputTokens: 0,
            outputTokens: 0,
            reasoningTokens: 0,
            cachedInputTokens: 0,
            costStates: {},
          },
          context: null,
          compactions: { stack: [], events: [] },
        },
      },
    ],
  ] as const) {
    await page.route(p[0], (route) =>
      route.fulfill({ contentType: "application/json", body: JSON.stringify(p[1]) })
    );
  }

  /**
   * CopilotKit 的**单端点**协议:所有调用都 POST 到 /api/copilotkit,靠 body 里的
   * `method` 分发 —— `info` 要 JSON,`agent/connect` 与 `agent/run` 要 SSE。
   * 按路径分发是错的:connect 会被当成 run,页面一加载就凭空多一个回答。
   */
  const copilot: Parameters<Page["route"]>[1] = async (route) => {
    const raw = route.request().postDataJSON() as {
      method?: string;
      body?: { threadId?: string; messages?: Msg[] };
    };
    const method = raw?.method ?? "";
    const threadId = raw?.body?.threadId ?? "(none)";

    if (method === "info") {
      // **`agents` 必须有。** 客户端拿它 `Object.entries(...)`,返回 `{}` 会抛,
      // 然后 runtime 进 Error 状态 —— 这时 `useAgent` 走的是 provisional 分支,
      // 而那个缓存是**每个组件自己的 useRef**:聊天区和 RegenerateRunner 各拿到
      // 一个互不相干的 agent 实例,一边跑完了另一边什么都不显示。
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          version: "1",
          agents: { default: { description: "ai2nao", capabilities: [] } },
        }),
      });
    }

    if (method === "agent/connect") {
      return route.fulfill({
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
        body: [
          sse({ type: "RUN_STARTED", threadId, runId: "c" }),
          sse({ type: "MESSAGES_SNAPSHOT", messages: tree.path() }),
          sse({ type: "RUN_FINISHED", threadId, runId: "c" }),
        ].join(""),
      });
    }

    if (method !== "agent/run") {
      return route.fulfill({ status: 400, contentType: "application/json", body: "{}" });
    }

    runs.push({ threadId, messages: raw?.body?.messages ?? [] });
    // 服务端的行为:客户端带来的新消息落库(挂在激活叶子下面),然后回答挂在它下面。
    for (const m of raw?.body?.messages ?? []) {
      if (!tree.nodes.has(m.id)) tree.add(m, tree.leaf);
    }
    answerSeq += 1;
    const answerId = `a-new-${answerSeq}`;
    const text = `第${answerSeq + 1}个回答`;
    tree.add({ id: answerId, role: "assistant", content: text }, tree.leaf);
    return route.fulfill({
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
      body: [
        sse({ type: "RUN_STARTED", threadId, runId: `r${answerSeq}` }),
        sse({ type: "TEXT_MESSAGE_START", messageId: answerId, role: "assistant" }),
        sse({ type: "TEXT_MESSAGE_CONTENT", messageId: answerId, delta: text }),
        sse({ type: "TEXT_MESSAGE_END", messageId: answerId }),
        sse({ type: "RUN_FINISHED", threadId, runId: `r${answerSeq}` }),
      ].join(""),
    });
  };
  await page.route("**/api/copilotkit", copilot);
  await page.route("**/api/copilotkit/**", copilot);

  return { runs, leaked };
}

function oneRound(): Tree {
  const tree = new Tree();
  tree.add({ id: "u1", role: "user", content: "第一个问题" }, null);
  tree.add({ id: "a1", role: "assistant", content: "第1个回答" }, "u1");
  return tree;
}

test("点重新生成:发出一轮、落在当前会话、新回答出现在界面上", async ({ page }) => {
  const tree = oneRound();
  const { runs, leaked } = await mount(page, tree);

  await page.goto("/ai-chat");
  await expect(page.getByText("第1个回答")).toBeVisible();

  await page.getByTestId("copilot-regenerate-button").first().click();

  await expect.poll(() => runs.length, { timeout: 10_000 }).toBe(1);
  expect(runs[0]!.threadId).toBe("s1");
  await expect(page.getByText("第2个回答")).toBeVisible();
  await expect(page.getByText("第1个回答")).toHaveCount(0);
  expect(leaked, "有请求漏到了本机的真实后端").toEqual([]);
});

test("点编辑:横幅里预填原文,改完发送成为新的一支", async ({ page }) => {
  const tree = oneRound();
  const { runs, leaked } = await mount(page, tree);

  await page.goto("/ai-chat");
  await expect(page.getByText("第1个回答")).toBeVisible();

  // CopilotKit 的工具栏是 hover 才出现的,不悬停就点不到。
  await page.getByTestId("copilot-user-message").first().hover();
  await page.getByTestId("copilot-edit-button").first().click();

  // 横幅自带编辑框,原文已经在里面 —— 当初那条
  // `Invalid prompt: messages must not be empty` 的由来正是原文从没送进任何输入框。
  const editor = page.getByTestId("edit-resend-input");
  await expect(editor).toHaveValue("第一个问题");
  await editor.fill("改过的问题");
  await page.getByRole("button", { name: "发送" }).click();

  await expect.poll(() => runs.length, { timeout: 10_000 }).toBe(1);
  expect(runs[0]!.threadId).toBe("s1");
  await expect(page.getByText("改过的问题")).toBeVisible();
  expect(leaked, "有请求漏到了本机的真实后端").toEqual([]);
});
