import { test, expect, type Page } from "@playwright/test";

test("AI chat history flow saves, restores, and deletes a local session", async ({ page }) => {
  const store = new MockSessionStore();
  await mockAiChatApis(page, store);

  await page.goto("/ai-chat");
  await expect(page.getByRole("heading", { name: "AI 对话" })).toBeVisible();
  await expect(page.getByText("Local AI Studio")).toBeVisible();

  await page.getByRole("textbox", { name: "消息内容" }).fill("总结今天的工作");
  await page.keyboard.press("Enter");

  await expect(page.getByText("这是一个确定性的测试回答。")).toBeVisible();
  await expect(page.getByRole("button", { name: /^总结今天的工作 \d+ 条消息$/ })).toBeVisible();

  await page.reload();
  await expect(page.getByRole("button", { name: /^总结今天的工作 \d+ 条消息$/ })).toBeVisible();
  await page.getByRole("button", { name: /^总结今天的工作 \d+ 条消息$/ }).click();
  await expect(page.getByText("这是一个确定性的测试回答。")).toBeVisible();

  await page.getByRole("textbox", { name: "消息内容" }).fill("继续说");
  await page.keyboard.press("Enter");
  await expect(page.getByText("继续说")).toBeVisible();
  await expect(page.getByRole("button", { name: /^总结今天的工作 4 条消息$/ })).toBeVisible();

  await page.getByRole("button", { name: /删除 总结今天的工作/ }).click();
  await expect(page.getByText("第一条消息后，会话会保存在这里。")).toBeVisible();
  await expect(page.getByText("问一个和你本机资料有关的问题。")).toBeVisible();
});

test("AI chat history keeps switched sessions isolated", async ({ page }) => {
  const store = new MockSessionStore();
  const chatRequests: unknown[] = [];
  await mockAiChatApis(page, store, chatRequests);

  await page.goto("/ai-chat");
  await page.getByRole("textbox", { name: "消息内容" }).fill("第一个问题");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: /^第一个问题 \d+ 条消息$/ })).toBeVisible();

  await page.getByRole("button", { name: "新对话" }).click();
  await page.getByRole("textbox", { name: "消息内容" }).fill("第二个问题");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: /^第二个问题 \d+ 条消息$/ })).toBeVisible();

  await page.getByRole("button", { name: /^第一个问题 \d+ 条消息$/ }).click();
  await page.getByRole("textbox", { name: "消息内容" }).fill("我刚才问你什么了");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: /^第一个问题 4 条消息$/ })).toBeVisible();

  const lastRequest = chatRequests.at(-1);
  const lastRequestText = extractChatRequestText(lastRequest);
  expect(lastRequestText).toContain("第一个问题");
  expect(lastRequestText).toContain("我刚才问你什么了");
  expect(lastRequestText).not.toContain("第二个问题");
});

async function mockAiChatApis(page: Page, store: MockSessionStore, chatRequests: unknown[] = []) {
  let streamNo = 0;
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

    if (sessionId && url.pathname.endsWith("/sync") && method === "POST") {
      const body = request.postDataJSON() as { title?: string; messages: unknown[] };
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ session: store.sync(sessionId, body.title, body.messages) }),
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
      body: JSON.stringify({ error: "unhandled mock route" }),
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
  await page.route("**/api/llm-chat", (route) => {
    const body = route.request().postDataJSON();
    chatRequests.push(body);
    const invalidMessage = (body as { messages?: unknown[] })?.messages?.find(
      (message) => !Array.isArray((message as { parts?: unknown })?.parts)
    );
    if (invalidMessage) {
      return route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({
          error: { message: "Cannot read properties of undefined (reading 'map')" },
        }),
      });
    }
    streamNo += 1;
    route.fulfill({
      status: 200,
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
      },
      body: [
        sse({ type: "start", messageId: `assistant-e2e-${streamNo}` }),
        sse({ type: "text-start", id: "txt" }),
        sse({ type: "text-delta", id: "txt", delta: "这是一个确定性的测试回答。" }),
        sse({ type: "text-end", id: "txt" }),
        sse({ type: "finish", finishReason: "stop" }),
        "data: [DONE]\n\n",
      ].join(""),
    });
  });
}

function sse(value: unknown) {
  return `data: ${JSON.stringify(value)}\n\n`;
}

class MockSessionStore {
  private sessions: Array<Record<string, unknown> & { id: string; title: string; messages: unknown[] }> = [];

  list() {
    return this.sessions.map(({ messages: _messages, ...session }) => session);
  }

  create(title = "新对话") {
    const now = new Date().toISOString();
    const session = {
      id: `s${this.sessions.length + 1}`,
      title,
      created_at: now,
      updated_at: now,
      last_message_at: null,
      message_count: 0,
      messages: [],
    };
    this.sessions.unshift(session);
    return this.list()[0];
  }

  get(id: string) {
    return this.sessions.find((session) => session.id === id) ?? this.sessions[0];
  }

  sync(id: string, title: string | undefined, messages: unknown[]) {
    const session = this.sessions.find((item) => item.id === id);
    if (!session) throw new Error("missing session");
    const now = new Date().toISOString();
    session.title = title || session.title;
    session.updated_at = now;
    session.last_message_at = now;
    session.message_count = messages.length;
    session.messages = messages.map((message, index) => ({
      id: `${id}:${index}`,
      session_id: id,
      message_id: (message as { id?: string }).id ?? `m${index}`,
      message_index: index,
      role: (message as { role?: string }).role ?? "user",
      raw_json: JSON.stringify(message),
      plain_text: textFromMessage(message),
      preview: textFromMessage(message),
      status: null,
      created_at: now,
      updated_at: now,
    }));
    return session;
  }

  delete(id: string) {
    this.sessions = this.sessions.filter((session) => session.id !== id);
  }

}

function textFromMessage(message: unknown) {
  const m = message as { content?: Array<{ text?: string }>; parts?: Array<{ text?: string }> };
  const parts = m.parts ?? m.content ?? [];
  return parts.map((part) => part.text ?? "").join("\n").trim();
}

function extractChatRequestText(request: unknown) {
  const messages = (request as { messages?: unknown[] } | undefined)?.messages ?? [];
  return messages.map(textFromMessage).join("\n");
}
