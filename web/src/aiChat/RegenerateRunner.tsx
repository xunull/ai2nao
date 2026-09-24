import { useEffect, useRef } from "react";
import { useAgent, useCopilotKit } from "@copilotkit/react-core/v2";

/**
 * 「重新生成」之后真的跑一轮。
 *
 * 为什么需要它:CopilotKit 的 run 由**发送消息**触发,而重新生成没有新消息要发 ——
 * 服务端已经把激活叶子退回到那条提问,这一轮要做的只是「拿当前这条路径再问一次」。
 * `runAgent` 不加消息直接跑,正是这个语义。
 *
 * **`threadId` 必须显式传。** 这个组件是 `<CopilotChat>` 的兄弟,不在它内部那个
 * `CopilotChatConfigurationProvider` 里,所以 `useAgent` 的 threadId 回退拿不到
 * 当前会话。不传的话它返回的是共享的 registry agent —— threadId 是构造时的随机
 * UUID,`runAgent` 带着它出去,后端 `ensureLlmChatSession` 顺手建一个新会话:
 * 界面上凭空多出一场对话,而这一轮的回答落在那里,当前会话什么都没发生。
 * 传了 threadId 拿到的是**和聊天区同一个** per-thread clone(useAgent 用 WeakMap
 * 保证同一个 (agent, threadId) 只有一个实例)。
 *
 * 必须放在 `<CopilotKit>` 内部才拿得到 agent。它不渲染任何东西。
 *
 * `trigger` 每次 +1 触发一次。首次挂载不跑 —— 否则每次换会话/重挂都会凭空多问一轮。
 */
export function RegenerateRunner({
  sessionId,
  trigger,
}: {
  sessionId: string;
  trigger: number;
}) {
  const { agent } = useAgent({ agentId: "default", threadId: sessionId });
  const { copilotkit } = useCopilotKit();
  const seen = useRef(trigger);

  useEffect(() => {
    if (trigger === seen.current) return;
    seen.current = trigger;
    if (!agent) return;
    // **先 connect 再 run,顺序是必须的。** 客户端手上那份消息里还有刚被退掉的
    // 那个回答;直接 run 的话新回答会追加在它下面,界面上一个问题两个答案。
    // connect 拿的是服务端的激活路径(那个回答已经不在上面了),替换掉客户端的列表
    // 之后再跑,新回答才落在正确的位置 —— 也就不用再靠重挂聊天区来刷新。
    void (async () => {
      try {
        await copilotkit.connectAgent({ agent });
        await copilotkit.runAgent({ agent });
      } catch {
        // 跑不起来不该把整页带崩:用户仍然可以手动再问一次。
      }
    })();
  }, [trigger, agent, copilotkit]);

  return null;
}
