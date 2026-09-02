import { existsSync, mkdtempSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerCopilotKitRoutes } from "../src/llmChat/copilotRuntime.js";
import { getLlmChatSession } from "../src/llmChat/sessions.js";
import { openDatabase } from "../src/store/open.js";

const { streamTextMock } = vi.hoisted(() => ({ streamTextMock: vi.fn() }));

vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>();
  return { ...actual, streamText: streamTextMock };
});

const previousConfigPath = process.env.AI2NAO_LLM_CHAT_CONFIG;

afterEach(() => {
  streamTextMock.mockReset();
  if (previousConfigPath === undefined) delete process.env.AI2NAO_LLM_CHAT_CONFIG;
  else process.env.AI2NAO_LLM_CHAT_CONFIG = previousConfigPath;
});

/** 两条模型条目共用一把 key —— 本地端点,不需要真的能连。 */
const MULTI_DOC = {
  defaultModelId: "primary",
  keys: { local: "test-key" },
  models: [
    {
      id: "primary",
      label: "主模型",
      provider: "openai-compatible",
      model: "primary-model",
      baseURL: "http://127.0.0.1:11434/v1",
      keyRef: "local",
    },
    {
      id: "secondary",
      label: "备用模型",
      provider: "openai-compatible",
      model: "secondary-model",
      baseURL: "http://127.0.0.1:11434/v1",
      keyRef: "local",
    },
  ],
};

function tempPath(name: string): string {
  return join(mkdtempSync(join(tmpdir(), "ai2nao-multimodel-")), name);
}

async function* asyncParts(parts: unknown[]) {
  for (const p of parts) yield p;
}

function answerStream(id: string, text: string) {
  return {
    fullStream: asyncParts([
      { type: "text-start", id },
      { type: "text-delta", id, text },
      { type: "text-end", id },
      { type: "finish" },
    ]),
  };
}

function setup(doc: unknown) {
  const dbPath = tempPath("multimodel.db");
  const db = openDatabase(dbPath);
  const configPath = tempPath("llm-chat.json");
  writeFileSync(configPath, JSON.stringify(doc));
  process.env.AI2NAO_LLM_CHAT_CONFIG = configPath;
  const app = new Hono();
  registerCopilotKitRoutes(app, { db });
  return {
    db,
    app,
    cleanup() {
      db.close();
      if (existsSync(dbPath)) unlinkSync(dbPath);
      if (existsSync(configPath)) unlinkSync(configPath);
    },
  };
}

function run(app: Hono, threadId: string, userText: string, forwardedProps: unknown) {
  return app.request("/api/copilotkit/agent/default/run", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      threadId,
      runId: `run-${threadId}-${Math.random().toString(36).slice(2)}`,
      messages: [{ id: `u-${Math.random().toString(36).slice(2)}`, role: "user", content: userText }],
      tools: [],
      context: [],
      state: {},
      forwardedProps,
    }),
  });
}

/** 从落库的会话里取出每条 assistant 消息的模型快照。 */
function snapshots(db: Parameters<typeof getLlmChatSession>[0], threadId: string) {
  const session = getLlmChatSession(db, threadId);
  return (session?.messages ?? [])
    .filter((r) => r.role === "assistant")
    .map((r) => (JSON.parse(r.raw_json) as { ai2naoModel?: { modelId: string; model: string } }).ai2naoModel);
}

describe("多模型:每轮可切,不可用不静默换家", () => {
  it("SC7 未知 modelId → RUN_ERROR,且**根本没调模型** —— 证明不是静默回落默认", async () => {
    const { db, app, cleanup } = setup(MULTI_DOC);
    try {
      const res = await run(app, "t-unknown", "hi", { modelId: "根本不存在的-id" });
      const sse = await res.text();
      expect(sse).toContain("RUN_ERROR");
      // 这一条才是关键:若是静默回落,streamText 会被调用一次并给出默认模型的回答。
      expect(streamTextMock).not.toHaveBeenCalled();
      expect(sse).not.toContain("RUN_FINISHED");
    } finally {
      cleanup();
    }
  });

  it("SC7 选中的模型没配 key → RUN_ERROR,文案里带模型名", async () => {
    const { app, cleanup } = setup({
      ...MULTI_DOC,
      keys: {}, // 一把 key 都没有
      models: [
        { ...MULTI_DOC.models[0], provider: "deepseek", baseURL: "https://api.deepseek.com" },
      ],
    });
    try {
      const sse = await (await run(app, "t-nokey", "hi", { modelId: "primary" })).text();
      expect(sse).toContain("RUN_ERROR");
      expect(sse).toContain("主模型");
      expect(streamTextMock).not.toHaveBeenCalled();
    } finally {
      cleanup();
    }
  });

  it("modelId 缺失 → 用默认项,行为与改造前一致", async () => {
    const { db, app, cleanup } = setup(MULTI_DOC);
    streamTextMock.mockReturnValueOnce(answerStream("m1", "默认模型答的"));
    try {
      const sse = await (await run(app, "t-default", "hi", {})).text();
      expect(sse).toContain("RUN_FINISHED");
      expect(snapshots(db, "t-default")[0]?.modelId).toBe("primary");
    } finally {
      cleanup();
    }
  });

  it("SC4 同一场会话连发两条、中间换模型 → 两条回答的快照不同,且都落了库", async () => {
    const { db, app, cleanup } = setup(MULTI_DOC);
    streamTextMock
      .mockReturnValueOnce(answerStream("m1", "主模型答的"))
      .mockReturnValueOnce(answerStream("m2", "备用模型答的"));
    try {
      await (await run(app, "t-mix", "第一问", { modelId: "primary" })).text();
      await (await run(app, "t-mix", "第二问", { modelId: "secondary" })).text();

      const snaps = snapshots(db, "t-mix");
      expect(snaps).toHaveLength(2);
      expect(snaps[0]).toMatchObject({ modelId: "primary", model: "primary-model" });
      expect(snaps[1]).toMatchObject({ modelId: "secondary", model: "secondary-model" });
    } finally {
      cleanup();
    }
  });

  /**
   * **这条单独没有判别力,别指望它守 stampModelSnapshot 的「不覆盖」规则。**
   * 实测(2026-09-02):把 modelStamp.ts 里的 `if (existing) return m` 拆掉,本文件
   * 6 条照样全绿 —— 因为盖章只作用于 `generated.messages()`(这一轮新生成的),
   * 历史走的是 mergedMessages,根本不经过它,那道守卫在本路径上不可达。
   * 真正守「不覆盖」的是 llmChat.modelSelection.test.ts 里的单元用例(拆掉守卫会红)。
   *
   * 保留它的理由是另一件事:持久化路径日后被重构成「对全量消息重新推导快照」时,
   * 这条会红。名字按它真正守的东西起,不按我原本以为的起。
   */
  it("第二轮落库不扰动第一轮已存的快照(端到端,非「不覆盖」规则本身)", async () => {
    const { db, app, cleanup } = setup(MULTI_DOC);
    streamTextMock
      .mockReturnValueOnce(answerStream("m1", "主模型答的"))
      .mockReturnValueOnce(answerStream("m2", "备用模型答的"));
    try {
      await (await run(app, "t-keep", "第一问", { modelId: "primary" })).text();
      await (await run(app, "t-keep", "第二问", { modelId: "secondary" })).text();
      // 若 stampModelSnapshot 覆盖了已有快照,这里两条都会变成 secondary。
      expect(snapshots(db, "t-keep")[0]?.modelId).toBe("primary");
    } finally {
      cleanup();
    }
  });

  it("旧的单模型配置照常能跑,快照带合成 id", async () => {
    const { db, app, cleanup } = setup({
      provider: "openai-compatible",
      baseURL: "http://127.0.0.1:11434/v1",
      model: "legacy-model",
      apiKey: "test-key",
    });
    streamTextMock.mockReturnValueOnce(answerStream("m1", "老配置答的"));
    try {
      const sse = await (await run(app, "t-legacy", "hi", {})).text();
      expect(sse).toContain("RUN_FINISHED");
      expect(snapshots(db, "t-legacy")[0]?.model).toBe("legacy-model");
    } finally {
      cleanup();
    }
  });
});
