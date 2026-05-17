import { test, expect, type Page } from "@playwright/test";

test("AI chat renders a fixed-height CopilotKit workbench", async ({ page }) => {
  const store = new MockSessionStore();
  await mockAiChatApis(page, store);

  await page.goto("/ai-chat");

  await expect(page.getByRole("heading", { name: "AI 对话" })).toBeVisible();
  await expect(page.getByTestId("ai-chat-session-rail")).toBeVisible();
  await expect(page.getByTestId("ai-chat-thread-shell")).toBeVisible();
  await expect(page.getByText("AI Studio")).toBeVisible();

  const shellBox = await page.getByTestId("ai-chat-thread-shell").boundingBox();
  expect(shellBox?.height).toBeGreaterThan(520);
});

test("AI chat creates, switches, and deletes local CopilotKit sessions", async ({ page }) => {
  const store = new MockSessionStore();
  await mockAiChatApis(page, store);

  await page.goto("/ai-chat");
  await expect(page.getByTestId("ai-chat-session")).toHaveCount(1);

  await page.getByRole("button", { name: "新对话", exact: true }).first().click();
  await expect(page.getByTestId("ai-chat-session")).toHaveCount(2);

  await page.getByTestId("ai-chat-session").last().click();
  await expect(page.getByTestId("ai-chat-thread-shell")).toBeVisible();

  await page.getByRole("button", { name: "删除对话" }).first().click();
  await expect(page.getByTestId("ai-chat-session")).toHaveCount(1);
});

test("AI chat keeps switched CopilotKit sessions isolated at the runtime boundary", async ({ page }) => {
  const store = new MockSessionStore([
    sessionFixture("s1", "第一个问题", [
      { id: "u1", role: "user", content: "第一个问题" },
      { id: "a1", role: "assistant", content: "第一个回答" },
    ]),
    sessionFixture("s2", "第二个问题", [
      { id: "u2", role: "user", content: "第二个问题" },
      { id: "a2", role: "assistant", content: "第二个回答" },
    ]),
  ]);
  const runtimeRequests: unknown[] = [];
  await mockAiChatApis(page, store, runtimeRequests);

  await page.goto("/ai-chat");
  await page.getByRole("button", { name: /^第一个问题/ }).click();
  await page.getByTestId("copilot-chat-textarea").fill("我刚才问你什么了");
  await page.keyboard.press("Enter");
  await expect.poll(() => runtimeRequests.length).toBeGreaterThan(0);

  const lastRun = runtimeRequests.at(-1);
  const requestText = JSON.stringify(runtimeMessagesFromBody(lastRun));
  expect(requestText).toContain("第一个问题");
  expect(requestText).toContain("我刚才问你什么了");
  expect(requestText).not.toContain("第二个问题");
});

test("AI chat registers safe CopilotKit tools and page context with the runtime", async ({ page }) => {
  const store = new MockSessionStore();
  const runtimeRequests: unknown[] = [];
  await mockAiChatApis(page, store, runtimeRequests);

  await page.goto("/ai-chat");
  await page.getByTestId("copilot-chat-textarea").fill("帮我找一下本机资料");
  await page.keyboard.press("Enter");
  await expect.poll(() => runtimeRequests.length).toBeGreaterThan(0);

  const requestText = JSON.stringify(runtimeRequests.at(-1));
  expect(requestText).toContain("ai2nao_read_workspace_context");
  expect(requestText).toContain("ai2nao_search_rag_evidence");
  expect(requestText).toContain("ai2nao_confirm_session_delete");
  expect(requestText).toContain("ai2nao 当前 AI 对话工作台状态");
});

async function mockAiChatApis(page: Page, store: MockSessionStore, runtimeRequests: unknown[] = []) {
  await page.route("**/api/llm-chat/sessions**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    const parts = url.pathname.split("/").filter(Boolean);
    const sessionId = parts[parts.indexOf("sessions") + 1];

    if (url.pathname === "/api/llm-chat/sessions" && method === "GET") {
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ sessions: store.list() }),
      });
    }

    if (url.pathname === "/api/llm-chat/sessions" && method === "POST") {
      const body = request.postDataJSON() as { title?: string };
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ session: store.create(body.title) }),
      });
    }

    if (sessionId && method === "DELETE") {
      store.delete(sessionId);
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ ok: true }),
      });
    }

    if (sessionId && method === "GET") {
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ session: store.get(sessionId) }),
      });
    }

    return route.fulfill({
      status: 404,
      contentType: "application/json",
      body: JSON.stringify({ error: "unhandled session mock route" }),
    });
  });

  await page.route("**/api/llm-chat/status", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        configured: true,
        provider: "openai-compatible",
        model: "local-e2e-model",
        baseHost: "http://127.0.0.1:11434",
        configPath: "/tmp/llm-chat.json",
      }),
    })
  );

  await page.route("**/api/rag/status", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        dbPath: "/tmp/rag.db",
        configPath: "/tmp/rag.json",
        configPresent: true,
        corpusRoots: ["/Users/test/project-notes"],
        embeddingEnabled: true,
        chunkCount: 12,
      }),
    })
  );

  await page.route("**/api/rag/search", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        query: "test",
        hits: [
          {
            id: 1,
            sourceRoot: "/Users/test/project-notes",
            filePath: "README.md",
            content: "测试证据片段",
            ftsRank: -1,
          },
        ],
      }),
    })
  );

  const handleCopilotKitRoute: Parameters<Page["route"]>[1] = async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;

    if (path.endsWith("/info")) {
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({}),
      });
    }

    if (path.endsWith("/connect")) {
      const threadId = threadIdFromBody(request.postDataJSON());
      const session = store.get(threadId);
      return route.fulfill({
        status: 200,
        headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
        body: [
          sse({ type: "RUN_STARTED", threadId, runId: `${threadId}:connect` }),
          sse({ type: "MESSAGES_SNAPSHOT", messages: session?.messages ?? [] }),
          sse({ type: "RUN_FINISHED", threadId, runId: `${threadId}:connect` }),
        ].join(""),
      });
    }

    if (path === "/api/copilotkit" || path.endsWith("/run")) {
      const body = request.postDataJSON();
      const threadId = threadIdFromBody(body);
      const session = store.get(threadId);
      const mergedBody = mergeRuntimeMessages(body, session?.messages ?? []);
      runtimeRequests.push(mergedBody);
      return route.fulfill({
        status: 200,
        headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
        body: [
          sse({ type: "RUN_STARTED", threadId, runId: `${threadId}:run` }),
          sse({ type: "TEXT_MESSAGE_START", messageId: `${threadId}:assistant` }),
          sse({ type: "TEXT_MESSAGE_CONTENT", messageId: `${threadId}:assistant`, delta: "这是一个确定性的测试回答。" }),
          sse({ type: "TEXT_MESSAGE_END", messageId: `${threadId}:assistant` }),
          sse({ type: "RUN_FINISHED", threadId, runId: `${threadId}:run` }),
        ].join(""),
      });
    }

    return route.fulfill({
      status: 404,
      contentType: "application/json",
      body: JSON.stringify({ error: "unhandled copilotkit mock route" }),
    });
  };

  await page.route("**/api/copilotkit", handleCopilotKitRoute);
  await page.route("**/api/copilotkit/**", handleCopilotKitRoute);
}

function sse(value: unknown) {
  return `data: ${JSON.stringify(value)}\n\n`;
}

function threadIdFromBody(body: unknown) {
  return (
    (body as { threadId?: string })?.threadId ??
    (body as { input?: { threadId?: string } })?.input?.threadId ??
    (body as { body?: { threadId?: string } })?.body?.threadId ??
    "s1"
  );
}

function mergeRuntimeMessages(body: unknown, persistedMessages: unknown[]) {
  const record = body as { body?: { messages?: unknown[] }; input?: { messages?: unknown[] }; messages?: unknown[] };
  const incoming = record.body?.messages ?? record.input?.messages ?? record.messages ?? [];
  const merged = mergeMessagesById(persistedMessages, incoming);
  if (record.body) return { ...record, body: { ...record.body, messages: merged } };
  if (record.input) return { ...record, input: { ...record.input, messages: merged } };
  return { ...record, messages: merged };
}

function runtimeMessagesFromBody(body: unknown) {
  const record = body as { body?: { messages?: unknown[] }; input?: { messages?: unknown[] }; messages?: unknown[] };
  return record.body?.messages ?? record.input?.messages ?? record.messages ?? [];
}

function mergeMessagesById(...groups: unknown[][]) {
  const seen = new Set<string>();
  const merged: unknown[] = [];
  for (const message of groups.flat()) {
    const id = (message as { id?: string }).id;
    if (id && seen.has(id)) continue;
    if (id) seen.add(id);
    merged.push(message);
  }
  return merged;
}

function sessionFixture(id: string, title: string, messages: unknown[] = []) {
  const now = new Date().toISOString();
  return {
    id,
    title,
    created_at: now,
    updated_at: now,
    last_message_at: messages.length > 0 ? now : null,
    message_count: messages.length,
    messages,
  };
}

class MockSessionStore {
  private sessions: ReturnType<typeof sessionFixture>[];

  constructor(initialSessions?: ReturnType<typeof sessionFixture>[]) {
    this.sessions = initialSessions ?? [sessionFixture("s1", "新对话")];
  }

  list() {
    return this.sessions.map(({ messages: _messages, ...session }) => session);
  }

  create(title = "新对话") {
    const session = sessionFixture(`s${this.sessions.length + 1}`, title);
    this.sessions.unshift(session);
    return this.list()[0];
  }

  get(id: string) {
    return this.sessions.find((session) => session.id === id) ?? this.sessions[0];
  }

  delete(id: string) {
    this.sessions = this.sessions.filter((session) => session.id !== id);
  }
}
