import { useEffect, useRef } from "react";
import { useAgent, useCopilotKit } from "@copilotkit/react-core/v2";

/**
 * 「重新生成」之后真的跑一轮。
 *
 * 为什么需要它:CopilotKit 的 run 由**发送消息**触发,而重新生成没有新消息要发 ——
 * 服务端已经把激活叶子退回到那条提问,这一轮要做的只是「拿当前这条路径再问一次」。
 * `runAgent` 不加消息直接跑,正是这个语义。
 *
 * 必须放在 `<CopilotKit>` 内部才拿得到 agent。它不渲染任何东西。
 *
 * `trigger` 每次 +1 触发一次。首次挂载不跑 —— 否则每次换会话/重挂都会凭空多问一轮。
 */
export function RegenerateRunner({ trigger }: { trigger: number }) {
  const { agent } = useAgent({ agentId: "default" });
  const { copilotkit } = useCopilotKit();
  const seen = useRef(trigger);

  useEffect(() => {
    if (trigger === seen.current) return;
    seen.current = trigger;
    if (!agent) return;
    void copilotkit.runAgent({ agent }).catch(() => {
      // 跑不起来不该把整页带崩:用户仍然可以手动再问一次。
    });
  }, [trigger, agent, copilotkit]);

  return null;
}
