// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAiChatThreads } from "../web/src/aiChat/useAiChatThreads";
import type { AiChatSessionDetail, AiChatSessionSummary } from "../web/src/aiChat/types";

const mockThread = {
  cancelRun: vi.fn(),
  reset: vi.fn(),
  append: vi.fn(),
};

const mockThreads = {
  switchToNewThread: vi.fn(async () => undefined),
  switchToThread: vi.fn(async () => undefined),
};

const mockAui = {
  thread: () => mockThread,
};

let mockAuiState = {
  thread: {
    messages: [] as unknown[],
    isRunning: false,
  },
};

const sessionApi = vi.hoisted(() => ({
  listAiChatSessions: vi.fn(),
  getAiChatSession: vi.fn(),
  createAiChatSession: vi.fn(),
  syncAiChatSession: vi.fn(),
  deleteAiChatSession: vi.fn(),
}));

vi.mock("@assistant-ui/react", () => ({
  useAui: () => mockAui,
  useAssistantRuntime: () => ({ thread: mockThread, threads: mockThreads }),
  useAuiState: (selector: (state: typeof mockAuiState) => unknown) => selector(mockAuiState),
}));

vi.mock("../web/src/aiChat/sessionApi", () => sessionApi);

describe("useAiChatThreads", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mockThreads.switchToNewThread.mockResolvedValue(undefined);
    mockThreads.switchToThread.mockResolvedValue(undefined);
    mockAuiState = {
      thread: {
        messages: [],
        isRunning: false,
      },
    };
    sessionApi.listAiChatSessions.mockResolvedValue([]);
    sessionApi.getAiChatSession.mockResolvedValue(detail("s1", []));
    sessionApi.createAiChatSession.mockResolvedValue(summary("s1"));
    sessionApi.syncAiChatSession.mockResolvedValue(summary("s1", 2));
    sessionApi.deleteAiChatSession.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("restores a selected session atomically from raw UI messages", async () => {
    const restored = userMessage("m1", "第一个问题");
    sessionApi.getAiChatSession.mockResolvedValue(
      detail("s1", [
        row("r1", "s1", "m1", 0, "user", JSON.stringify(restored), "第一个问题"),
      ])
    );
    const { result } = renderHook(() => useAiChatThreads());

    await act(async () => {
      await result.current.selectSession("s1");
    });

    expect(mockThread.reset).toHaveBeenCalledWith([
      {
        id: restored.id,
        role: restored.role,
        content: [{ type: "text", text: "第一个问题" }],
        metadata: undefined,
        status: undefined,
      },
    ]);
    expect(result.current.activeSessionId).toBe("s1");
    expect(result.current.status).toBe("idle");
  });

  it("keeps the current runtime untouched when restore data is invalid", async () => {
    sessionApi.getAiChatSession.mockResolvedValue(
      detail("bad", [
        row("r1", "bad", "m1", 0, "user", JSON.stringify({ id: "m1", role: "user" }), ""),
      ])
    );
    const { result } = renderHook(() => useAiChatThreads());

    await act(async () => {
      await result.current.selectSession("bad");
    });

    expect(mockThread.reset).not.toHaveBeenCalled();
    expect(result.current.activeSessionId).toBeNull();
    expect(result.current.status).toBe("restore_error");
  });

  it("debounces autosave and sends only assistant-ui parts", async () => {
    mockAuiState = {
      thread: {
        messages: [userMessage("m1", "第一个问题")],
        isRunning: false,
      },
    };

    renderHook(() => useAiChatThreads());

    await act(async () => {
      await vi.advanceTimersByTimeAsync(599);
    });
    expect(sessionApi.syncAiChatSession).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
      await Promise.resolve();
    });

    expect(sessionApi.syncAiChatSession).toHaveBeenCalledTimes(1);
    const [, messages] = sessionApi.syncAiChatSession.mock.calls[0];
    expect(messages).toEqual([userMessage("m1", "第一个问题")]);
    expect(JSON.stringify(messages)).not.toContain("content");
  });

  it("starts a new thread immediately while saving the previous snapshot", async () => {
    mockAuiState = {
      thread: {
        messages: [userMessage("m1", "第一个问题")],
        isRunning: false,
      },
    };
    sessionApi.syncAiChatSession.mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve(summary("s1", 2)), 50))
    );
    const { result } = renderHook(() => useAiChatThreads());

    act(() => {
      result.current.startNew();
    });

    expect(mockThreads.switchToNewThread).toHaveBeenCalledTimes(1);
    expect(result.current.activeSessionId).toBeNull();

    await act(async () => {
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(50);
    });

    expect(mockThread.reset).toHaveBeenCalledWith([]);
    expect(sessionApi.syncAiChatSession).toHaveBeenCalledTimes(1);
    expect(sessionApi.syncAiChatSession.mock.calls[0][1]).toEqual([
      userMessage("m1", "第一个问题"),
    ]);
    expect(result.current.activeSessionId).toBeNull();
  });
});

function summary(id: string, messageCount = 0): AiChatSessionSummary {
  const now = "2026-05-06T08:00:00.000Z";
  return {
    id,
    title: id === "s1" ? "第一个问题" : "测试会话",
    created_at: now,
    updated_at: now,
    last_message_at: messageCount > 0 ? now : null,
    message_count: messageCount,
  };
}

function detail(id: string, messages: AiChatSessionDetail["messages"]): AiChatSessionDetail {
  return {
    ...summary(id, messages.length),
    messages,
  };
}

function row(
  id: string,
  sessionId: string,
  messageId: string,
  index: number,
  role: "system" | "user" | "assistant",
  rawJson: string,
  plainText: string
): AiChatSessionDetail["messages"][number] {
  const now = "2026-05-06T08:00:00.000Z";
  return {
    id,
    session_id: sessionId,
    message_id: messageId,
    message_index: index,
    role,
    raw_json: rawJson,
    plain_text: plainText,
    preview: plainText,
    status: null,
    created_at: now,
    updated_at: now,
  };
}

function userMessage(id: string, text: string) {
  return {
    id,
    role: "user",
    parts: [{ type: "text", text }],
  };
}
