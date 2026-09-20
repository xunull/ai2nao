import { describe, expect, it } from "vitest";
import { EventType, transformChunks, verifyEvents, type BaseEvent } from "@ag-ui/client";
import { from, lastValueFrom, toArray } from "rxjs";
import {
  GeneratedMessages,
  agUiMessagesToModelMessages,
  aiSdkStreamToAgUiEvents,
} from "../src/llmChat/copilotRuntime.js";

describe("aiSdkStreamToAgUiEvents", () => {
  it("keeps web-search tool streams valid and gives repeated provider text ids unique message ids", async () => {
    const events = await collectEvents([
      { type: "text-start", id: "text-1" },
      { type: "text-delta", id: "text-1", text: "我先查一下。" },
      { type: "tool-input-start", id: "tool-1", toolName: "ai2nao_web_search", parentMessageId: "" },
      { type: "tool-input-delta", id: "tool-1", delta: '{"query":"ai2nao' },
      {
        type: "tool-input-available",
        toolCallId: "tool-1",
        toolName: "ai2nao_web_search",
        input: { query: "ai2nao" },
      },
      { type: "tool-output-available", toolCallId: "tool-1", output: { items: [{ title: "Result" }] } },
      { type: "text-start", id: "text-1" },
      { type: "text-delta", id: "text-1", text: "这是整理后的回答。" },
      { type: "text-end", id: "text-1" },
      { type: "finish" },
    ]);

    await expectAgUiSequenceValid(events);

    expect(events.map((event) => event.type)).toEqual([
      EventType.TEXT_MESSAGE_CHUNK,
      EventType.TOOL_CALL_START,
      EventType.TOOL_CALL_ARGS,
      EventType.TOOL_CALL_END,
      EventType.TOOL_CALL_RESULT,
      EventType.TEXT_MESSAGE_CHUNK,
    ]);

    const textChunks = eventRecords(events, EventType.TEXT_MESSAGE_CHUNK);
    const messageIds = textChunks.map((event) => event.messageId);
    expect(messageIds).toHaveLength(2);
    expect(new Set(messageIds).size).toBe(2);
    expect(messageIds).not.toContain("text-1");

    const toolStart = eventRecords(events, EventType.TOOL_CALL_START)[0];
    expect(toolStart.parentMessageId).toBe(messageIds[0]);
  });

  it("synthesizes missing start/end events so RUN_FINISHED will not close an active message", async () => {
    const events = await collectEvents([
      { type: "text-delta", id: "orphan-text", text: "没有 start 的文本" },
      { type: "tool-input-delta", id: "late-tool", delta: "{}" },
    ]);

    await expectAgUiSequenceValid(events);

    expect(events.map((event) => event.type)).toEqual([
      EventType.TEXT_MESSAGE_CHUNK,
      EventType.TOOL_CALL_START,
      EventType.TOOL_CALL_ARGS,
      EventType.TOOL_CALL_END,
    ]);
  });

  it("ignores empty provider text blocks between a tool call and the final answer", async () => {
    const events = await collectEvents([
      { type: "tool-input-start", id: "tool-1", toolName: "ai2nao_web_search" },
      { type: "tool-input-delta", id: "tool-1", delta: "{" },
      { type: "tool-input-delta", id: "tool-1", delta: '"query":"ai2nao"}' },
      { type: "tool-input-end", id: "tool-1" },
      { type: "tool-call", toolCallId: "tool-1", toolName: "ai2nao_web_search", input: { query: "ai2nao" } },
      { type: "text-start", id: "0" },
      { type: "text-end", id: "0" },
      { type: "tool-result", toolCallId: "tool-1", toolName: "ai2nao_web_search", output: { ok: true } },
      { type: "finish-step" },
      { type: "start-step" },
      { type: "text-start", id: "0" },
      { type: "text-delta", id: "0", text: "最终回答" },
      { type: "text-end", id: "0" },
      { type: "finish" },
    ]);

    await expectAgUiSequenceValid(events);

    expect(events.map((event) => event.type)).toEqual([
      EventType.TOOL_CALL_START,
      EventType.TOOL_CALL_ARGS,
      EventType.TOOL_CALL_ARGS,
      EventType.TOOL_CALL_END,
      EventType.TOOL_CALL_RESULT,
      EventType.TEXT_MESSAGE_CHUNK,
    ]);
    expect(eventRecords(events, EventType.TEXT_MESSAGE_CHUNK)[0].delta).toBe("最终回答");
  });

  it("converts DeepSeek DSML text tool calls into server tool events instead of rendering them", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const events = await collectEvents(
      [
        { type: "text-start", id: "dsml-text" },
        { type: "text-delta", id: "dsml-text", text: "<｜｜DSML｜｜tool_calls> <｜｜DSML｜｜invoke name=\"ai2nao_web_search\">" },
        {
          type: "text-delta",
          id: "dsml-text",
          text: [
            "<｜｜DSML｜｜parameter name=\"count\" string=\"false\">5</｜｜DSML｜｜parameter>",
            "<｜｜DSML｜｜parameter name=\"query\" string=\"true\">美团 3690 5月15日 2026 收盘价</｜｜DSML｜｜parameter>",
            "<｜｜DSML｜｜parameter name=\"reason\" string=\"true\">最近一个交易日</｜｜DSML｜｜parameter>",
            "</｜｜DSML｜｜invoke> </｜｜DSML｜｜tool_calls>",
          ].join(" "),
        },
        { type: "finish" },
      ],
      {
        executeTextToolCall: async (call) => {
          calls.push(call);
          return { ok: true, evidence: [{ title: "Meituan", url: "https://example.com/meituan" }] };
        },
      }
    );

    await expectAgUiSequenceValid(events);

    expect(JSON.stringify(events)).not.toContain("DSML");
    expect(events.map((event) => event.type)).toEqual([
      EventType.TOOL_CALL_START,
      EventType.TOOL_CALL_ARGS,
      EventType.TOOL_CALL_END,
      EventType.TOOL_CALL_RESULT,
    ]);
    expect(calls[0]).toMatchObject({
      name: "ai2nao_web_search",
      input: {
        count: 5,
        query: "美团 3690 5月15日 2026 收盘价",
        reason: "最近一个交易日",
      },
    });
    const args = JSON.parse(String(eventRecords(events, EventType.TOOL_CALL_ARGS)[0].delta)) as Record<string, unknown>;
    expect(args.query).toBe("美团 3690 5月15日 2026 收盘价");
  });

  it("keeps assistant tool calls and tool results when rebuilding model messages", () => {
    const messages = agUiMessagesToModelMessages([
      { id: "u1", role: "user", content: "昨天阿里巴巴的股票是多少" },
      {
        id: "a1",
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "tc1",
            type: "function",
            function: { name: "ai2nao_web_search", arguments: '{"query":"BABA close"}' },
          },
        ],
      },
      {
        id: "tr1",
        role: "tool",
        toolCallId: "tc1",
        content: '{"ok":true,"evidence":[{"title":"Alibaba","url":"https://example.com"}]}',
      },
    ] as any);

    expect(messages).toHaveLength(3);
    expect(messages[1]).toMatchObject({
      role: "assistant",
      content: [
        {
          type: "tool-call",
          toolCallId: "tc1",
          toolName: "ai2nao_web_search",
          input: { query: "BABA close" },
        },
      ],
    });
    expect(messages[2]).toMatchObject({
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "tc1",
          toolName: "ai2nao_web_search",
          output: {
            type: "json",
            value: { ok: true, evidence: [{ title: "Alibaba", url: "https://example.com" }] },
          },
        },
      ],
    });
  });

  it("wraps plain string tool outputs in the AI SDK v6 ToolResultOutput schema", () => {
    const messages = agUiMessagesToModelMessages([
      {
        id: "a1",
        role: "assistant",
        toolCalls: [
          {
            id: "tc1",
            type: "function",
            function: { name: "ai2nao_web_search", arguments: "{}" },
          },
        ],
      },
      {
        id: "tr1",
        role: "tool",
        toolCallId: "tc1",
        content: JSON.stringify("plain output"),
      },
    ] as any);

    expect(messages[1]).toMatchObject({
      role: "tool",
      content: [
        {
          type: "tool-result",
          output: { type: "text", value: "plain output" },
        },
      ],
    });
  });

  it("skips malformed assistant tool call records when rebuilding model messages", () => {
    const messages = agUiMessagesToModelMessages([
      {
        id: "a1",
        role: "assistant",
        content: "先给一个普通回答",
        toolCalls: [{ id: "bad-call" }],
      },
    ] as any);

    expect(messages).toEqual([{ role: "assistant", content: "先给一个普通回答" }]);
  });
});

/**
 * 中止时该落库的消息:剔掉**没有结果**的工具调用。
 *
 * 历史里一旦出现「有调用、没有结果」的一对,下一轮发给厂商会直接报错 ——
 * 所以取消在工具执行途中时,那条半截调用不能落库。
 *
 * 直接打这个方法而不是跑完整回合:要从 HTTP 路由那一侧确定性地触发中止,
 * 得把 AbortSignal 穿过路由、还要在流跑到「有调用、无结果」的那一刻精确打断,
 * 写出来是个竞态测试,比没有测试更糟。
 */
describe("GeneratedMessages.messagesForAbort", () => {
  const ev = (e: Record<string, unknown>): BaseEvent => e as BaseEvent;
  const callIdsOf = (messages: unknown[]): string[] =>
    messages.flatMap((m) =>
      ((m as { toolCalls?: Array<{ id: string }> }).toolCalls ?? []).map((c) => c.id)
    );

  it("有结果的工具调用保留,没有结果的被剔掉", () => {
    const generated = new GeneratedMessages();
    generated.apply(
      ev({ type: EventType.TOOL_CALL_START, toolCallId: "done", toolCallName: "ai2nao_web_search" })
    );
    generated.apply(
      ev({ type: EventType.TOOL_CALL_RESULT, messageId: "r1", toolCallId: "done", content: "{}" })
    );
    generated.apply(
      ev({ type: EventType.TOOL_CALL_START, toolCallId: "dangling", toolCallName: "ai2nao_web_search" })
    );

    expect(callIdsOf(generated.messagesForAbort())).toEqual(["done"]);
  });

  it("只摘掉那几项,不整条丢 —— 正文还在的 assistant 不能被半截调用连累", () => {
    const generated = new GeneratedMessages();
    generated.apply(ev({ type: EventType.TEXT_MESSAGE_START, messageId: "m1" }));
    generated.apply(
      ev({ type: EventType.TEXT_MESSAGE_CONTENT, messageId: "m1", delta: "我先查一下。" })
    );
    // parentMessageId 让这次调用挂到 m1 上 —— m1 已经在 ordered 里,不会被重新 push。
    // 整条丢的话,用户已经看到的这句正文会跟着消失。
    generated.apply(
      ev({
        type: EventType.TOOL_CALL_START,
        toolCallId: "c1",
        toolCallName: "ai2nao_web_search",
        parentMessageId: "m1",
      })
    );

    const kept = generated.messagesForAbort();
    expect(kept).toHaveLength(1);
    expect((kept[0] as { content?: string }).content).toBe("我先查一下。");
    expect(callIdsOf(kept)).toEqual([]);
  });

  it("非空转:同一组事件下 messages() 会把半截调用原样带出去", () => {
    const generated = new GeneratedMessages();
    generated.apply(
      ev({ type: EventType.TOOL_CALL_START, toolCallId: "dangling", toolCallName: "ai2nao_web_search" })
    );

    // 正常收尾那一路不做剔除 —— 半截调用只有中止时才需要处理。
    // 这两行一旦相等,说明 messagesForAbort 退化成了 messages 的同义词。
    expect(callIdsOf(generated.messages())).toEqual(["dangling"]);
    expect(generated.messagesForAbort()).toHaveLength(0);
  });
});

describe("aiSdkStreamToAgUiEvents —— 思考分流", () => {
  const THINK_PARTS = [
    { type: "text-start", id: "t-1" },
    { type: "text-delta", id: "t-1", text: "<think>想</think>答" },
    { type: "text-end", id: "t-1" },
    { type: "finish" },
  ];

  it("provider 的 reasoning-delta 变成思考事件，正文不受影响", async () => {
    const events = await collectEvents([
      { type: "reasoning-start", id: "r-1" },
      { type: "reasoning-delta", id: "r-1", delta: "先想一下。" },
      { type: "reasoning-end", id: "r-1" },
      { type: "text-start", id: "t-1" },
      { type: "text-delta", id: "t-1", text: "答案。" },
      { type: "text-end", id: "t-1" },
      { type: "finish" },
    ]);

    // 过 AG-UI 官方校验器 —— 序列非法(比如 CONTENT 没配 START)在这里就炸。
    await expectAgUiSequenceValid(events);

    expect(events.map((event) => event.type)).toEqual([
      EventType.REASONING_MESSAGE_CHUNK,
      EventType.TEXT_MESSAGE_CHUNK,
    ]);
    // 读的是 `delta` 而不是 `text` —— provider 层这两个字段名不对称。
    expect(eventRecords(events, EventType.REASONING_MESSAGE_CHUNK)[0].delta).toBe("先想一下。");
    expect(eventRecords(events, EventType.TEXT_MESSAGE_CHUNK)[0].delta).toBe("答案。");
  });

  it("MiniMax 的 <think> 走思考通道，气泡里一个字都不漏", async () => {
    const events = await collectEvents([
      { type: "text-start", id: "t-1" },
      { type: "text-delta", id: "t-1", text: "<think>\n用户问" },
      { type: "text-delta", id: "t-1", text: "的是什么\n</think>\n\n答案在这" },
      { type: "text-end", id: "t-1" },
      { type: "finish" },
    ]);

    await expectAgUiSequenceValid(events);

    const thinking = eventRecords(events, EventType.REASONING_MESSAGE_CHUNK)
      .map((event) => event.delta)
      .join("");
    expect(thinking).toBe("\n用户问的是什么\n");

    const visible = eventRecords(events, EventType.TEXT_MESSAGE_CHUNK)
      .map((event) => event.delta)
      .join("");
    expect(visible).toBe("答案在这");
    expect(JSON.stringify(events)).not.toContain("<think");
  });

  it("没有思考时一个思考事件都不发", async () => {
    // **非空转守卫。** 每步都配一对空事件的话,上面四条完整序列断言会全红 ——
    // 这条把「只在真有思考时才发」钉死,免得将来有人图省事改成无条件发。
    const events = await collectEvents([
      { type: "text-start", id: "t-1" },
      { type: "text-delta", id: "t-1", text: "直接回答" },
      { type: "text-end", id: "t-1" },
      { type: "finish" },
    ]);

    expect(eventRecords(events, EventType.REASONING_MESSAGE_CHUNK)).toHaveLength(0);
    expect(events.map((event) => event.type)).toEqual([EventType.TEXT_MESSAGE_CHUNK]);
  });

  it("有 stepKey 时消息 id 按步派生，没有时回落随机 id", async () => {
    const withKey = await collectEvents(THINK_PARTS, { stepKey: () => "run-1:answer:0" });
    expect(eventRecords(withKey, EventType.REASONING_MESSAGE_CHUNK)[0].messageId).toBe(
      "r:run-1:answer:0"
    );
    expect(eventRecords(withKey, EventType.TEXT_MESSAGE_CHUNK)[0].messageId).toBe(
      "a:run-1:answer:0"
    );

    // 补答那条路不传 options,必须仍然能跑 —— 这条是它的回归网。
    const withoutKey = await collectEvents(THINK_PARTS);
    const reasoningId = eventRecords(withoutKey, EventType.REASONING_MESSAGE_CHUNK)[0]
      .messageId as string;
    expect(reasoningId).toBeTruthy();
    expect(reasoningId.startsWith("r:")).toBe(false);
  });

  it("流结束时 think 未闭合：思考留得住，气泡仍然干净", async () => {
    const events = await collectEvents([
      { type: "text-start", id: "t-1" },
      { type: "text-delta", id: "t-1", text: "正文<think>没说完" },
      { type: "text-end", id: "t-1" },
      { type: "finish" },
    ]);

    await expectAgUiSequenceValid(events);

    const visible = eventRecords(events, EventType.TEXT_MESSAGE_CHUNK)
      .map((event) => event.delta)
      .join("");
    expect(visible).toBe("正文");

    const thinking = eventRecords(events, EventType.REASONING_MESSAGE_CHUNK)
      .map((event) => event.delta)
      .join("");
    expect(thinking).toBe("没说完");
  });
});

async function collectEvents(
  parts: unknown[],
  options?: Parameters<typeof aiSdkStreamToAgUiEvents>[1]
): Promise<BaseEvent[]> {
  const events: BaseEvent[] = [];
  for await (const event of aiSdkStreamToAgUiEvents(asyncParts(parts), options)) {
    events.push(event);
  }
  return events;
}

async function* asyncParts(parts: unknown[]): AsyncGenerator<unknown> {
  for (const part of parts) yield part;
}

async function expectAgUiSequenceValid(events: BaseEvent[]): Promise<void> {
  const runEvents = [
    { type: EventType.RUN_STARTED, threadId: "thread-1", runId: "run-1" },
    ...events,
    { type: EventType.RUN_FINISHED, threadId: "thread-1", runId: "run-1" },
  ] as BaseEvent[];
  await expect(lastValueFrom(from(runEvents).pipe(transformChunks(), verifyEvents(), toArray()))).resolves.toBeTruthy();
}

function eventRecords(events: BaseEvent[], type: EventType): Array<Record<string, unknown>> {
  return events.filter((event) => event.type === type) as Array<Record<string, unknown>>;
}
