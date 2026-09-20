import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useAgent } from "@copilotkit/react-core/v2";
import { getAiChatSessionUsage } from "./sessionApi";
import type { AiChatSessionUsage } from "./types";

type AiChatUsageValue = {
  sessionId: string;
  usage: AiChatSessionUsage | null;
  error: string | null;
  refresh: () => void;
  /** 压缩或撤销成功之后调:重取用量,并让页面重挂 CopilotChat 拿裁剪后的快照。 */
  notifyCompactionChanged: () => void;
  /**
   * 刚刚新出现的那条压缩(手动或自动)的 id。分隔线据此在「刚压缩完的那一次」展开
   * (规格《7》:默认收起,只在刚压缩完的那一次展开)。首次加载、换会话、撤销都不算。
   */
  justCompactedId: string | null;
};

/**
 * 默认值是「还没有数据」,不是空用量 —— 消费组件据此显示占位而不是 `$0.00`。
 */
const AiChatUsageContext = createContext<AiChatUsageValue>({
  sessionId: "",
  usage: null,
  error: null,
  refresh: () => {},
  notifyCompactionChanged: () => {},
  justCompactedId: null,
});

export function useAiChatUsage(): AiChatUsageValue {
  return useContext(AiChatUsageContext);
}

/**
 * 会话用量的取数与分发。放在 `CopilotChat` **外层**:用量行、思考块标题、占用条、
 * 压缩分隔线都在插槽组件里消费它,而插槽组件的重渲染受 CopilotKit 的消息视图缓存
 * 比较影响,走 context 才能绕开。
 *
 * **刷新时机**:会话加载时;一轮结束或失败时(并通知页面刷新左栏累计);压缩/撤销
 * 之后(并通知页面重挂聊天区)。「一轮结束」用 agent 订阅而不是轮询 ——
 * `onRunFinalized` / `onRunFailed` 不受 `throttleMs` 节流(库文档明写「always fire
 * immediately」)。
 */
export function AiChatUsageProvider({
  sessionId,
  onRunSettled,
  onCompactionChanged,
  refreshKey,
  children,
}: {
  sessionId: string;
  /** 一轮结束或失败之后。页面用它刷新左栏 —— 左栏的累计来自会话列表接口。 */
  onRunSettled?: () => void;
  /** 压缩或撤销成功之后。页面用它重挂 CopilotChat。 */
  onCompactionChanged?: () => void;
  /**
   * 变化时重取一次。页面在模型目录真的重拉过之后递增它 —— 窗口大小挂在目录上,
   * 首次加载时用量往往比目录先回来,不重取的话占用条会停在「窗口未知」直到下一轮结束。
   */
  refreshKey?: number;
  children: ReactNode;
}) {
  const [usage, setUsage] = useState<AiChatSessionUsage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [justCompactedId, setJustCompactedId] = useState<string | null>(null);
  const acRef = useRef<AbortController | null>(null);
  // 上一份用量里的压缩栈,按会话记 —— 换会话后的第一份不能拿来和别的会话比。
  const prevStackRef = useRef<{ sessionId: string; ids: string[] } | null>(null);
  // `notifyCompactionChanged` 已经让页面重挂过了;数据侧随后发现栈顶变化时不要再挂第二次。
  const notifiedRef = useRef(false);
  // 回调放进 ref:页面每次渲染都会给新函数,放进依赖数组会让订阅反复拆装。
  const settledRef = useRef(onRunSettled);
  const changedRef = useRef(onCompactionChanged);
  useEffect(() => {
    settledRef.current = onRunSettled;
    changedRef.current = onCompactionChanged;
  });

  const refresh = useCallback(() => {
    // 上一次还没回来就取消它 —— 一轮结束与手动刷新可能挨着发生,
    // 两个响应乱序到达会让界面回退到旧数字。
    acRef.current?.abort();
    const ac = new AbortController();
    acRef.current = ac;
    getAiChatSessionUsage(sessionId, { signal: ac.signal })
      .then((next) => {
        if (ac.signal.aborted) return;
        const ids = (next.compactions?.stack ?? []).map((c) => c.id);
        const prev = prevStackRef.current;
        prevStackRef.current = { sessionId, ids };
        if (prev && prev.sessionId === sessionId) {
          const prevTop = prev.ids[prev.ids.length - 1] ?? null;
          const top = ids[ids.length - 1] ?? null;
          if (top !== prevTop) {
            // 新压缩 = 栈顶是上一份栈里**没有**的那条。撤销后栈顶退回更早那条
            // (上一份里有),不算「刚压缩」。
            if (top && !prev.ids.includes(top)) setJustCompactedId(top);
            // **自动压缩发生在一轮之中**,没有路由返回可挂钩,运行流里也不带分隔线 ——
            // 只能靠数据发现,再让页面重挂拿裁剪后的快照。不这样的话,被折叠的消息
            // 会一直留在聊天区、分隔线也不出现,直到用户刷新页面。
            if (!notifiedRef.current) changedRef.current?.();
          }
        }
        notifiedRef.current = false;
        setUsage(next);
        setError(null);
      })
      .catch((e: unknown) => {
        if (ac.signal.aborted) return;
        setError(e instanceof Error ? e.message : String(e));
      });
  }, [sessionId]);

  const notifyCompactionChanged = useCallback(() => {
    notifiedRef.current = true;
    refresh();
    changedRef.current?.();
  }, [refresh]);

  // 换会话:上一个会话「刚压缩」的标记不能带过来。
  useEffect(() => {
    setJustCompactedId(null);
  }, [sessionId]);

  useEffect(() => {
    refresh();
    return () => acRef.current?.abort();
  }, [refresh, refreshKey]);

  // **必须无条件调用**(hooks 规则)。测试里 `CopilotKit` 被 mock 成普通 div,
  // 没有真实 provider 上下文,所以返回值可能是 undefined —— 一路用可选链兜住。
  const agentResult = useAgent({ threadId: sessionId }) as { agent?: unknown } | undefined;
  const agent = agentResult?.agent as
    | { subscribe?: (s: Record<string, () => void>) => { unsubscribe?: () => void } }
    | undefined;

  useEffect(() => {
    if (typeof agent?.subscribe !== "function") return;
    const settle = () => {
      refresh();
      settledRef.current?.();
    };
    const sub = agent.subscribe({ onRunFinalized: settle, onRunFailed: settle });
    return () => sub?.unsubscribe?.();
  }, [agent, refresh]);

  return (
    <AiChatUsageContext.Provider
      value={{ sessionId, usage, error, refresh, notifyCompactionChanged, justCompactedId }}
    >
      {children}
    </AiChatUsageContext.Provider>
  );
}
