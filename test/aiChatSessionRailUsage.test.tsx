// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 左栏每个会话的累计花费。
 *
 * 盯的是两个静默错:
 * - 旧会话没有累计(后端返回 `usage` 为 undefined)时,显示成 `$0.00` 就是把
 *   「还没算过」说成「没花钱」;
 * - `atLeast` 漏了 `≥`,把下限说成实数。
 *
 * 数据在**后端早就发了**(`listLlmChatSessions` 走 `withParsedUsage`),此前前端只是
 * 没有声明这个字段、也没渲染。
 */

vi.mock("@copilotkit/react-core/v2", () => ({
  CopilotKit: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="mock-copilotkit">{children}</div>
  ),
  CopilotChat: () => <div data-testid="mock-copilot-chat" />,
  CopilotChatAssistantMessage: () => <div data-testid="mock-assistant-message" />,
  CopilotChatUserMessage: () => <div data-testid="mock-user-message" />,
  CopilotChatReasoningMessage: Object.assign(
    () => <div data-testid="mock-reasoning-message" />,
    { Header: () => null, Content: () => null, Toggle: () => null }
  ),
  CopilotChatInput: Object.assign(() => <div data-testid="mock-chat-input" />, {
    AddMenuButton: () => <button type="button" data-testid="mock-add-menu-button" />,
  }),
  useAgent: () => ({ agent: undefined }),
  useDefaultRenderTool: vi.fn(),
  useRenderTool: vi.fn(),
}));

const { AiChat } = await import("../web/src/pages/AiChat");

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
}

/** 两个会话:一个有累计,一个是「旧会话」(后端不返回 usage 键)。 */
const SESSIONS = [
  {
    id: "s-paid", title: "花过钱的会话",
    created_at: "2026-09-18T00:00:00.000Z", updated_at: "2026-09-18T00:00:00.000Z",
    last_message_at: "2026-09-18T00:00:00.000Z", message_count: 4,
    usage: {
      input: 1000, output: 500, reasoning: 0, cacheRead: 0, cacheWrite: 0,
      costUsd: 0.18, atLeast: true,
    },
  },
  {
    id: "s-old", title: "旧会话",
    created_at: "2026-09-01T00:00:00.000Z", updated_at: "2026-09-01T00:00:00.000Z",
    last_message_at: "2026-09-01T00:00:00.000Z", message_count: 2,
  },
];

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  Element.prototype.scrollTo = vi.fn();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/llm-chat/status")) {
        return json({ configured: true, provider: "openai-compatible", model: "m", baseHost: "h", configPath: "/tmp/c.json" });
      }
      if (url.endsWith("/api/llm-chat/model-catalog")) return json({ source: "cache" });
      if (url.endsWith("/api/rag/status")) {
        return json({ ok: true, dbPath: "", configPath: "", defaultDbPath: "", configPresent: false,
          corpusRoots: [], embeddingEnabled: false, chunkCount: 0,
          manifest: { total: 0, indexed: 0, skipped: 0, partial: 0, error: 0, deleted: 0, ftsError: 0, vectorError: 0 },
          vectorStore: null });
      }
      if (url.endsWith("/api/web-search/status")) {
        return json({ provider: "brave", configured: false, ok: false, configPath: "",
          capabilities: { freshness: false, safeSearch: false, resultLanguage: false, pageFetch: false },
          cacheTtlMs: 0, error: null });
      }
      if (url.endsWith("/api/code-runner/status")) {
        return json({ pyodide: { available: true }, docker: { available: false, dockerVersion: null, image: "", imagePresent: false, error: null } });
      }
      if (url.endsWith("/api/llm-chat/sessions?limit=50")) return json({ sessions: SESSIONS });
      if (url.includes("/usage")) {
        return json({ usage: { byRun: {}, byAssistantMessage: {}, byReasoningMessage: {},
          session: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0, atLeast: false,
            costStates: { pending: 0, unknown: 0, unpriced: 0, partial: 0, priced: 0 } },
          context: null, compactions: { stack: [], events: [] } } });
      }
      throw new Error(`Unhandled fetch: ${url}`);
    })
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("左栏会话累计", () => {
  it("★ 有累计的会话显示 `≥$0.18`;旧会话不显示金额", async () => {
    render(<AiChat />);
    const rail = await screen.findByTestId("ai-chat-session-rail");

    // atLeast 为真 —— 合计里有 pending/unknown/unpriced/partial,是下限不是实数。
    expect(rail.textContent).toContain("≥$0.18");

    // 旧会话那一行:后端没给 usage 键,界面不能编一个 $0.00 出来。
    const oldRow = [...rail.querySelectorAll("[data-testid='ai-chat-session']")].find((el) =>
      el.textContent?.includes("旧会话")
    );
    expect(oldRow, "没找到旧会话那一行").toBeTruthy();
    expect(oldRow!.textContent).not.toContain("$");
  });

  it("★ 顶栏标题同行显示本会话累计(第一个会话被自动选中)", async () => {
    render(<AiChat />);
    expect(await screen.findByText(/本会话 ≥\$0\.18/)).toBeInTheDocument();
  });
});
