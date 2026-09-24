// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * **发起一轮的那两个组件必须绑在当前会话的 thread 上。**
 *
 * `RegenerateRunner` 与 `EditResendBar` 都在 `<CopilotChat>` 外面(它们是兄弟,
 * 不是孩子),所以 `useAgent` 的 threadId 回退 —— 读 `CopilotChatConfigurationProvider`
 * 的那一步 —— 对它们不生效。不显式传 threadId 的话,`useAgent` 返回的是共享的
 * registry agent,它的 threadId 是构造时的随机 UUID;`runAgent` 带着它发出去,
 * 后端 `ensureLlmChatSession` 顺手建一个会话:界面上凭空多出一场对话,回答落在
 * 那里,当前会话什么都没发生,而且不报错。
 *
 * 这一条就盯着「useAgent 收到的 threadId 是当前会话 id」这一点。不测 CopilotKit
 * 内部怎么实现 —— 测的是我们这边的调用契约。
 */

const useAgentMock = vi.fn();
const runAgentMock = vi.fn(async () => ({}) as unknown);
const connectAgentMock = vi.fn(async () => ({}) as unknown);
const addMessageMock = vi.fn();

vi.mock("@copilotkit/react-core/v2", () => ({
  useAgent: (props: unknown) => {
    useAgentMock(props);
    return { agent: { addMessage: addMessageMock } };
  },
  useCopilotKit: () => ({
    copilotkit: { runAgent: runAgentMock, connectAgent: connectAgentMock },
  }),
}));

const { RegenerateRunner } = await import("../web/src/aiChat/RegenerateRunner");
const { EditResendBar } = await import("../web/src/aiChat/EditResendBar");

beforeEach(() => {
  useAgentMock.mockClear();
  runAgentMock.mockClear();
  connectAgentMock.mockClear();
  addMessageMock.mockClear();
});

afterEach(() => {
  // 本仓没开 vitest globals,自动 cleanup 不会注册 —— 不手动清的话下一条用例里
  // 会同时存在两个编辑框,getByRole 直接抛「找到多个」。
  cleanup();
  vi.unstubAllGlobals();
});

describe("发起一轮的组件与会话 thread 的绑定", () => {
  it("RegenerateRunner 把会话 id 当 threadId 传给 useAgent", () => {
    render(<RegenerateRunner sessionId="sess-42" trigger={0} />);
    expect(useAgentMock).toHaveBeenCalledWith({ agentId: "default", threadId: "sess-42" });
  });

  it("EditResendBar 把会话 id 当 threadId 传给 useAgent", () => {
    render(
      <EditResendBar sessionId="sess-42" draft="原文" onCancel={() => {}} onSent={() => {}} />
    );
    expect(useAgentMock).toHaveBeenCalledWith({ agentId: "default", threadId: "sess-42" });
  });

  it("trigger 变化时先 connect 再 run —— 顺序反了界面上一个问题会挂两个答案", async () => {
    const order: string[] = [];
    connectAgentMock.mockImplementation(async () => {
      order.push("connect");
      return {} as unknown;
    });
    runAgentMock.mockImplementation(async () => {
      order.push("run");
      return {} as unknown;
    });

    const { rerender } = render(<RegenerateRunner sessionId="s1" trigger={0} />);
    expect(order).toEqual([]); // 首次挂载不跑
    rerender(<RegenerateRunner sessionId="s1" trigger={1} />);
    await vi.waitFor(() => expect(order).toEqual(["connect", "run"]));
  });

  it("编辑框发送:先 addMessage 再 runAgent,发完才回调 onSent", async () => {
    const onSent = vi.fn();
    render(<EditResendBar sessionId="s1" draft="原来的问题" onCancel={() => {}} onSent={onSent} />);

    const box = screen.getByRole("textbox");
    expect(box).toHaveValue("原来的问题"); // 原文预填,不是空框
    await userEvent.clear(box);
    await userEvent.type(box, "改过的问题");
    await userEvent.click(screen.getByRole("button", { name: "发送" }));

    expect(addMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({ role: "user", content: "改过的问题" })
    );
    expect(runAgentMock).toHaveBeenCalled();
    expect(onSent).toHaveBeenCalled();
  });

  it("空内容不发送 —— 空提示词的那条报错就是这么来的", async () => {
    render(<EditResendBar sessionId="s1" draft="原文" onCancel={() => {}} onSent={() => {}} />);
    await userEvent.clear(screen.getByRole("textbox"));
    expect(screen.getByRole("button", { name: "发送" })).toBeDisabled();
    expect(runAgentMock).not.toHaveBeenCalled();
  });
});
