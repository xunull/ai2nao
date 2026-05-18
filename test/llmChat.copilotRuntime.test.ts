import { describe, expect, it } from "vitest";
import { EventType, transformChunks, verifyEvents, type BaseEvent } from "@ag-ui/client";
import { from, lastValueFrom, toArray } from "rxjs";
import { agUiMessagesToModelMessages, aiSdkStreamToAgUiEvents } from "../src/llmChat/copilotRuntime.js";

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
