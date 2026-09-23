// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SaveHint } from "../web/src/components/SaveHint";
import { SAVED_HOLD_MS, useSaveStatus } from "../web/src/lib/useSaveStatus";

/**
 * 设置页保存反馈的状态机。
 *
 * 背景:那个页面原来 15 处保存全有失败提示、一处成功提示都没有,改完一个数字按 Tab
 * 走完全不知道存没存上。
 *
 * 两条最要紧的性质:
 *  1. 「已保存」**会自己消失**。不能用 react-query 的 isSuccess 当它 —— 那个一旦为真
 *     就一直为真,而设置页有七处是 onBlur / 增删即存、没有 dirty 可以拿来复位,
 *     绿字会永远挂着。
 *  2. 失败**不消失**。那是要你处理的东西,不是通知。
 */

type Mut = { isPending: boolean; isSuccess: boolean; isError: boolean };

/** 把 hook 挂在一个最小组件上,靠重新渲染喂不同的 mutation 状态。 */
function Probe({ mut, errorText }: { mut: Mut; errorText?: string }) {
  const status = useSaveStatus(mut);
  return (
    <div>
      <span data-testid="status">{status}</span>
      <SaveHint status={status} errorText={errorText} note="下次扫描时生效" />
    </div>
  );
}

const idle: Mut = { isPending: false, isSuccess: false, isError: false };
const pending: Mut = { isPending: true, isSuccess: false, isError: false };
const done: Mut = { isPending: false, isSuccess: true, isError: false };
const failed: Mut = { isPending: false, isSuccess: false, isError: true };

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const status = () => screen.getByTestId("status").textContent;

/** 定时器回调里有 setState,不包 act 的话断言时 React 还没提交。 */
const tick = (ms: number) => act(() => void vi.advanceTimersByTime(ms));

describe("useSaveStatus", () => {
  it("保存中显示「保存中…」", () => {
    render(<Probe mut={pending} />);
    expect(status()).toBe("saving");
    expect(screen.getByText("保存中…")).toBeInTheDocument();
  });

  it("从 pending 落到成功时亮起「已保存」,并带上生效说明", () => {
    const { rerender } = render(<Probe mut={pending} />);
    rerender(<Probe mut={done} />);
    expect(status()).toBe("saved");
    expect(screen.getByText("已保存 · 下次扫描时生效")).toBeInTheDocument();
  });

  it("三秒后自动消失", () => {
    const { rerender } = render(<Probe mut={pending} />);
    rerender(<Probe mut={done} />);
    expect(status()).toBe("saved");
    tick(SAVED_HOLD_MS - 1);
    expect(status()).toBe("saved");
    tick(1);
    expect(status()).toBe("idle");
    expect(screen.queryByText(/已保存/)).toBeNull();
  });

  it("isSuccess 一直为真也不会再亮 —— 认的是那个瞬间,不是那个值", () => {
    const { rerender } = render(<Probe mut={pending} />);
    rerender(<Probe mut={done} />);
    tick(SAVED_HOLD_MS);
    expect(status()).toBe("idle");
    // react-query 的 isSuccess 在下次 mutate 之前一直是 true;重渲染不该让绿字回来
    rerender(<Probe mut={done} />);
    expect(status()).toBe("idle");
  });

  it("失败显示红字,而且不会自动消失", () => {
    const { rerender } = render(<Probe mut={pending} errorText="boom" />);
    rerender(<Probe mut={failed} errorText="boom" />);
    expect(status()).toBe("error");
    tick(SAVED_HOLD_MS * 3);
    expect(status()).toBe("error");
    expect(screen.getByText("boom")).toBeInTheDocument();
  });

  it("没动过的时候什么都不渲染", () => {
    const { container } = render(<Probe mut={idle} />);
    expect(status()).toBe("idle");
    expect(container.textContent).toBe("idle");
  });

  it("第二次保存能再次亮起", () => {
    const { rerender } = render(<Probe mut={pending} />);
    rerender(<Probe mut={done} />);
    tick(SAVED_HOLD_MS);
    expect(status()).toBe("idle");
    rerender(<Probe mut={pending} />);
    rerender(<Probe mut={done} />);
    expect(status()).toBe("saved");
  });
});

describe("SaveHint", () => {
  it("清除动作用「已清除」", () => {
    render(<SaveHint status="saved" savedLabel="已清除" />);
    expect(screen.getByText("已清除")).toBeInTheDocument();
  });

  it("没有 note 时只说「已保存」", () => {
    render(<SaveHint status="saved" />);
    expect(screen.getByText("已保存")).toBeInTheDocument();
  });

  it("error 态但没有错误文本时不渲染空红字", () => {
    const { container } = render(<SaveHint status="error" />);
    expect(container.firstChild).toBeNull();
  });
});
