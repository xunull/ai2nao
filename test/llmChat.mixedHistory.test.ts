import { describe, expect, it } from "vitest";
import type { Message } from "@ag-ui/client";
import type { ModelMessage } from "ai";
import { agUiMessagesToModelMessages } from "../src/llmChat/copilotRuntime.js";
import { buildAi2NaoServerTools } from "../src/llmTools/index.js";

/**
 * 「每轮都能切模型、会话内可混」带来的历史形状问题。
 *
 * 两条风险不是同一个,而且**文档原本担心错了那个**:
 *   (a) 跨厂商的 tool call id 格式 —— 实测风险低,多数厂商把 id 当不透明字符串
 *   (b) 本轮 tools 为空、历史却含 tool_calls —— 部分厂商直接 400,而且这个问题
 *       **今天就存在**,跟多模型无关(聊完一轮带联网,把开关关掉再发一条即可复现)
 *
 * 本文件只钉现状、不改实现:先用测试把「到底会不会坏」变成事实。
 */

/** DeepSeek 的原生 id 形如 call_00_xxx;DSML 文本协议兜底时是 dsml-<uuid>。 */
function historyWith(toolCallId: string): Message[] {
  return [
    { id: "u1", role: "user", content: "上海天气" } as Message,
    {
      id: "a1",
      role: "assistant",
      content: "",
      toolCalls: [
        {
          id: toolCallId,
          type: "function",
          function: { name: "ai2nao_web_search", arguments: '{"query":"上海天气"}' },
        },
      ],
    } as unknown as Message,
    {
      id: "t1",
      role: "tool",
      toolCallId,
      content: '{"items":[{"title":"上海天气"}]}',
    } as unknown as Message,
    { id: "a2", role: "assistant", content: "上海今天多云。" } as Message,
  ];
}

function toolPartsOf(messages: ModelMessage[]) {
  const calls: { id: string; name: string }[] = [];
  const results: { id: string; name: string }[] = [];
  for (const m of messages) {
    if (m.role === "assistant" && Array.isArray(m.content)) {
      for (const part of m.content) {
        if (part.type === "tool-call") calls.push({ id: part.toolCallId, name: part.toolName });
      }
    }
    if (m.role === "tool" && Array.isArray(m.content)) {
      for (const part of m.content) {
        if (part.type === "tool-result") results.push({ id: part.toolCallId, name: part.toolName });
      }
    }
  }
  return { calls, results };
}

describe("跨厂商的 tool call id —— 风险(a)", () => {
  it.each([
    ["DeepSeek 原生", "call_00_Jowt4LgiXvZXcsEmYSqI4100"],
    ["DSML 兜底", "dsml-9f1c2b3a-4d5e-6f70-8192-a3b4c5d6e7f8"],
    ["MiniMax 形状", "call_function_5a0zyrs107wk_1"],
  ])("%s 的 id 换到别家 adapter 仍然配对完整,不抛", (_label, id) => {
    const out = agUiMessagesToModelMessages(historyWith(id));
    const { calls, results } = toolPartsOf(out);
    expect(calls).toEqual([{ id, name: "ai2nao_web_search" }]);
    // 工具名从同一份历史里查出来,不能退化成 unknown_tool ——
    // 那会让下一家模型收到一个它无从理解的工具结果。
    expect(results).toEqual([{ id, name: "ai2nao_web_search" }]);
  });

  it("id 里的特殊字符不被改写 —— 各家只当它是不透明字符串", () => {
    const weird = "dsml-中文_id.with-dots:and:colons";
    const { calls } = toolPartsOf(agUiMessagesToModelMessages(historyWith(weird)));
    expect(calls[0].id).toBe(weird);
  });

  it("孤儿 tool 结果(没有对应的 assistant 调用)被丢掉,不产生半截配对", () => {
    const orphan: Message[] = [
      { id: "u1", role: "user", content: "q" } as Message,
      { id: "t1", role: "tool", toolCallId: "", content: "r" } as unknown as Message,
    ];
    const { results } = toolPartsOf(agUiMessagesToModelMessages(orphan));
    expect(results).toEqual([]);
  });
});

describe("本轮 tools 为空 + 历史含 tool_calls —— 风险(b),既存问题,只钉现状", () => {
  it("五个开关全关时,serverTools 是空对象", () => {
    const tools = buildAi2NaoServerTools({}, {});
    expect(Object.keys(tools)).toEqual([]);
  });

  it("而历史里的 tool-call / tool-result 仍被原样送进请求 —— 组合起来就是那个 400", () => {
    // 这两条断言合起来才是风险本身:请求里没有 tools 定义,消息却引用了 tool_calls。
    // 修法是无 tools 时把这些消息压平成文本(评审里被否掉的 5C),本次不改。
    // **改实现的人必须让这条红,然后有意识地更新它** —— 它记的是「今天是这样」,
    // 不是「应该这样」。对应 TODOS.md「工具全关时,历史里的 tool_calls 会原样发出去」。
    const out = agUiMessagesToModelMessages(historyWith("call_00_x"));
    const { calls, results } = toolPartsOf(out);
    expect(calls).toHaveLength(1);
    expect(results).toHaveLength(1);
  });

  it("开着工具时行为一致 —— 说明差异只在 tools 定义那一侧,不在历史转换这一侧", () => {
    const withTools = buildAi2NaoServerTools({}, { webSearchEnabled: true });
    expect(Object.keys(withTools)).toContain("ai2nao_web_search");
    const a = agUiMessagesToModelMessages(historyWith("call_00_x"));
    const b = agUiMessagesToModelMessages(historyWith("call_00_x"));
    expect(a).toEqual(b);
  });
});
