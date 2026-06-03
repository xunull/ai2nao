import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { Hono } from "hono";
import {
  AbstractAgent,
  EventType,
  type AgentCapabilities,
  type BaseEvent,
  type Context,
  type Message,
} from "@ag-ui/client";
import { stepCountIs, streamText, type ModelMessage, type ToolSet } from "ai";
import { Observable } from "rxjs";
import type {
  AgentRunner,
  AgentRunnerConnectRequest,
  AgentRunnerIsRunningRequest,
  AgentRunnerRunRequest,
  AgentRunnerStopRequest,
  CopilotRuntimeFetchHandler,
} from "@copilotkit/runtime/v2";
import { llmChatStatus, readLlmChatConfig } from "./config.js";
import { createChatLanguageModel } from "./model.js";
import { llmChatLog } from "./log.js";
import {
  defaultBashApprovalStore,
  type BashApprovalStore,
  type BashPermissionRuleStore,
  type BashToolService,
} from "../bashTool/index.js";
import type { CodeRunnerService } from "../codeRunner/index.js";
import type { SessionMemoryService } from "../sessionMemory/index.js";
import type { WebSearchService } from "../webSearch/service.js";
import { buildAi2NaoServerTools, parseForwardedToolProps } from "../llmTools/index.js";
import {
  agUiMessagesFromSession,
  ensureLlmChatSession,
  getLlmChatSession,
  replaceLlmChatSessionMessages,
  textFromAgUiMessage,
} from "./sessions.js";

export type LlmChatCopilotRuntimeDeps = {
  db: Database.Database;
  ragDb?: Database.Database;
  webSearch?: WebSearchService;
  sessionMemory?: SessionMemoryService;
  codeRunner?: CodeRunnerService;
  bashTool?: BashToolService;
  bashApprovalStore?: BashApprovalStore;
  bashPermissionRules?: BashPermissionRuleStore;
};

type AgentInput = {
  threadId: string;
  runId?: string;
  messages: Message[];
  tools: unknown[];
  context: Context[];
  state: unknown;
  forwardedProps: unknown;
};

type ToolCallState = {
  id: string;
  name: string;
  args: string;
  started: boolean;
  hasArgsDelta: boolean;
  ended: boolean;
};

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

type ToolResultOutputForPrompt =
  | { type: "text"; value: string }
  | { type: "json"; value: JsonValue };

type DsmlTextToolCall = {
  id: string;
  name: string;
  input: Record<string, unknown>;
};

type AiSdkStreamToAgUiOptions = {
  executeTextToolCall?: (call: DsmlTextToolCall) => Promise<unknown>;
};

const runningThreadIds = new Set<string>();
const runningThreadStops = new Map<string, () => void>();
const MAX_TOOL_LOOP_STEPS = 6;
const sseTextEncoder = new TextEncoder();

type CopilotRuntimeHandlers = {
  single: CopilotRuntimeFetchHandler;
  multi: CopilotRuntimeFetchHandler;
};

export function registerCopilotKitRoutes(
  app: Hono,
  deps: LlmChatCopilotRuntimeDeps
): void {
  let handlers: Promise<CopilotRuntimeHandlers> | undefined;
  const getHandlers = () => {
    handlers ??= createCopilotRuntimeTransportHandlers(deps);
    return handlers;
  };

  app.get("/api/copilotkit/info", async (c) => runCopilotHandler((await getHandlers()).multi, c.req.raw));

  app.post("/api/copilotkit", async (c) => runCopilotHandler((await getHandlers()).single, c.req.raw));

  app.post("/api/copilotkit/agent/default/connect", async (c) => {
    return runCopilotHandler((await getHandlers()).multi, c.req.raw);
  });

  app.post("/api/copilotkit/agent/default/run", async (c) => {
    return runCopilotHandler((await getHandlers()).multi, c.req.raw);
  });

  app.post("/api/copilotkit/agent/default/stop/:threadId", async (c) => {
    return runCopilotHandler((await getHandlers()).multi, c.req.raw);
  });
}

async function runCopilotHandler(
  handler: CopilotRuntimeFetchHandler,
  request: Request
): Promise<Response> {
  return normalizeCopilotRuntimeResponse(await handler(request));
}

function normalizeCopilotRuntimeResponse(response: Response): Response {
  if (!response.body || !response.headers.get("content-type")?.includes("text/event-stream")) {
    return response;
  }
  const body = response.body.pipeThrough(
    new TransformStream<unknown, Uint8Array>({
      transform(chunk, controller) {
        if (typeof chunk === "string") {
          controller.enqueue(sseTextEncoder.encode(chunk));
        } else if (chunk instanceof Uint8Array) {
          controller.enqueue(chunk);
        } else {
          controller.enqueue(sseTextEncoder.encode(String(chunk)));
        }
      },
    })
  );
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

async function createCopilotRuntimeTransportHandlers(
  deps: LlmChatCopilotRuntimeDeps
): Promise<CopilotRuntimeHandlers> {
  process.env.COPILOTKIT_TELEMETRY_DISABLED ??= "1";
  const { CopilotRuntime, createCopilotRuntimeHandler } = await import("@copilotkit/runtime/v2");
  const runtime = new CopilotRuntime({
    agents: { default: new Ai2NaoTransportAgent() },
    runner: createAi2NaoAgentRunner(deps),
  });

  return {
    single: createCopilotRuntimeHandler({
      runtime,
      basePath: "/api/copilotkit",
      mode: "single-route",
    }),
    multi: createCopilotRuntimeHandler({
      runtime,
      basePath: "/api/copilotkit",
      mode: "multi-route",
    }),
  };
}

class Ai2NaoTransportAgent extends AbstractAgent {
  constructor() {
    super({ agentId: "default", description: "ai2nao transport-only CopilotKit adapter" });
  }

  async getCapabilities(): Promise<AgentCapabilities> {
    return {
      tools: { supported: false, clientProvided: false },
      transport: { streaming: true },
    };
  }

  setState(): void {
    super.setState({});
  }

  run(): Observable<BaseEvent> {
    return new Observable((subscriber) => {
      subscriber.error(new Error("ai2nao owns agent execution; CopilotKit is transport only."));
    });
  }
}

function createAi2NaoAgentRunner(deps: LlmChatCopilotRuntimeDeps): AgentRunner {
  return {
    run(request: AgentRunnerRunRequest): Observable<BaseEvent> {
      return observableFromAi2NaoTurn(deps, parseAgentInput(request.input));
    },
    connect(request: AgentRunnerConnectRequest): Observable<BaseEvent> {
      return observableFromEvents(connectToThreadEvents(deps, request.threadId));
    },
    isRunning(request: AgentRunnerIsRunningRequest): Promise<boolean> {
      return Promise.resolve(runningThreadIds.has(request.threadId));
    },
    stop(request: AgentRunnerStopRequest): Promise<boolean | undefined> {
      const stop = runningThreadStops.get(request.threadId);
      stop?.();
      const wasRunning = runningThreadIds.delete(request.threadId) || Boolean(stop);
      runningThreadStops.delete(request.threadId);
      return Promise.resolve(wasRunning);
    },
  };
}

function observableFromAi2NaoTurn(
  deps: LlmChatCopilotRuntimeDeps,
  input: AgentInput
): Observable<BaseEvent> {
  return new Observable<BaseEvent>((subscriber) => {
    const abortController = new AbortController();
    runningThreadStops.set(input.threadId, () => abortController.abort());
    (async () => {
      try {
        for await (const event of runAi2NaoTurnEvents(deps, input, abortController.signal)) {
          if (subscriber.closed) break;
          subscriber.next(event);
        }
        subscriber.complete();
      } catch (error) {
        subscriber.error(error);
      }
    })();

    return () => {
      abortController.abort();
    };
  });
}

function observableFromEvents(events: Iterable<BaseEvent>): Observable<BaseEvent> {
  return new Observable<BaseEvent>((subscriber) => {
    for (const event of events) {
      if (subscriber.closed) break;
      subscriber.next(event);
    }
    subscriber.complete();
  });
}

function* connectToThreadEvents(deps: LlmChatCopilotRuntimeDeps, threadId: string): Generator<BaseEvent> {
  const detail = getLlmChatSession(deps.db, threadId);
  const messages = detail ? agUiMessagesFromSession(detail) : [];
  const runId = randomUUID();
  yield { type: EventType.RUN_STARTED, threadId, runId } as BaseEvent;
  yield { type: EventType.MESSAGES_SNAPSHOT, messages } as BaseEvent;
  yield { type: EventType.RUN_FINISHED, threadId, runId } as BaseEvent;
}

async function* runAi2NaoTurnEvents(
  deps: LlmChatCopilotRuntimeDeps,
  input: AgentInput,
  abortSignal: AbortSignal
): AsyncGenerator<BaseEvent> {
  const runId = input.runId || randomUUID();
  const generated = new GeneratedMessages();
  runningThreadIds.add(input.threadId);
  yield { type: EventType.RUN_STARTED, threadId: input.threadId, runId } as BaseEvent;
  try {
    validateAi2NaoCopilotInput(input.messages, input.tools, input.context, input.state);
    const cfg = readLlmChatConfig();
    if (!cfg) {
      throw new Error(
        "LLM chat is not configured. Add ~/.ai2nao/llm-chat.json or set AI2NAO_LLM_CHAT_CONFIG."
      );
    }
    ensureLlmChatSession(deps.db, input.threadId);
    const detail = getLlmChatSession(deps.db, input.threadId);
    const persistedMessages = detail ? agUiMessagesFromSession(detail) : [];
    const mergedMessages = mergeAgUiMessages(persistedMessages, input.messages);
    const serverTools = buildAi2NaoServerTools(
      { ...deps, bashApprovalStore: deps.bashApprovalStore ?? defaultBashApprovalStore },
      input.forwardedProps,
      { sessionId: input.threadId }
    );
    const modelMessages = agUiMessagesToModelMessages(mergedMessages);
    const systemPrompt = ai2NaoSystemPrompt(input.forwardedProps);
    const result = streamText({
      model: createChatLanguageModel(cfg),
      system: systemPrompt,
      messages: modelMessages,
      tools: serverTools,
      stopWhen: stepCountIs(MAX_TOOL_LOOP_STEPS),
      abortSignal,
      onFinish: (ev) => {
        llmChatLog.info("ai2nao streamText onFinish", {
          threadId: input.threadId,
          finishReason: ev.finishReason,
          usage: ev.totalUsage,
        });
      },
      onError: ({ error }) => {
        llmChatLog.error("ai2nao streamText onError", error);
      },
    });

    for await (const event of aiSdkStreamToAgUiEvents(result.fullStream, {
      executeTextToolCall: createTextToolCallExecutor(serverTools, modelMessages, abortSignal),
    })) {
      generated.apply(event);
      yield event;
    }

    if (generated.needsFinalAnswer()) {
      const finalMessages = finalAnswerModelMessages(
        mergeAgUiMessages(mergedMessages, generated.messages())
      );
      const finalResult = streamText({
        model: createChatLanguageModel(cfg),
        system: finalAnswerSystemPrompt(systemPrompt),
        messages: finalMessages,
        abortSignal,
        stopWhen: stepCountIs(1),
      });
      for await (const event of aiSdkStreamToAgUiEvents(finalResult.fullStream)) {
        generated.apply(event);
        yield event;
      }
    }

    if (generated.needsFinalAnswer()) {
      const fallback = deterministicEvidenceAnswer(
        mergeAgUiMessages(mergedMessages, generated.messages())
      );
      const fallbackEvent = textChunkEvent(randomUUID(), fallback);
      generated.apply(fallbackEvent);
      yield fallbackEvent;
    }

    replaceLlmChatSessionMessages(deps.db, input.threadId, {
      messages: mergeAgUiMessages(mergedMessages, generated.messages()),
    });
    yield { type: EventType.RUN_FINISHED, threadId: input.threadId, runId } as BaseEvent;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    llmChatLog.error("ai2nao run failed", message);
    yield {
      type: EventType.RUN_ERROR,
      threadId: input.threadId,
      runId,
      message,
      code: "ai2nao_run_failed",
    } as BaseEvent;
  } finally {
    runningThreadIds.delete(input.threadId);
    runningThreadStops.delete(input.threadId);
  }
}

export async function* aiSdkStreamToAgUiEvents(
  fullStream: AsyncIterable<unknown>,
  options: AiSdkStreamToAgUiOptions = {}
): AsyncGenerator<BaseEvent> {
  const toolCalls = new Map<string, ToolCallState>();
  const dsml = new DsmlToolCallBuffer();
  let messageId = randomUUID();
  for await (const raw of fullStream) {
    const part = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : null;
    if (!part) continue;
    switch (part.type) {
      case "text-start": {
        messageId = randomUUID();
        break;
      }
      case "text-delta": {
        const delta = stringValue(part.text) || stringValue(part.delta);
        if (!delta) break;
        yield* dsml.consume(delta, messageId, options.executeTextToolCall);
        break;
      }
      case "text-end": {
        break;
      }
      case "tool-input-start": {
        const toolCallId = stringValue(part.id) || stringValue(part.toolCallId) || randomUUID();
        const toolName = stringValue(part.toolName) || "unknown_tool";
        const state = ensureToolState(toolCalls, toolCallId, toolName);
        state.name = toolName;
        if (!state.started) {
          state.started = true;
          yield toolCallStartEvent(toolCallId, state.name, messageId);
        }
        break;
      }
      case "tool-input-delta": {
        const toolCallId = stringValue(part.id) || stringValue(part.toolCallId);
        const delta = stringValue(part.delta) || stringValue(part.inputTextDelta);
        if (!toolCallId || !delta) break;
        const state = ensureToolState(toolCalls, toolCallId, stringValue(part.toolName));
        if (!state.started) {
          state.started = true;
          yield toolCallStartEvent(toolCallId, state.name, messageId);
        }
        state.args += delta;
        state.hasArgsDelta = true;
        yield { type: EventType.TOOL_CALL_ARGS, toolCallId, delta } as BaseEvent;
        break;
      }
      case "tool-input-available":
      case "tool-call": {
        const toolCallId = stringValue(part.toolCallId) || stringValue(part.id) || randomUUID();
        const toolName = stringValue(part.toolName) || "unknown_tool";
        const state = ensureToolState(toolCalls, toolCallId, toolName);
        state.name = toolName || state.name;
        if (!state.started) {
          state.started = true;
          yield toolCallStartEvent(toolCallId, state.name, messageId);
        }
        if (!state.hasArgsDelta && (part.type === "tool-input-available" || !state.args)) {
          const input = "input" in part ? stringifyJson(part.input) : "";
          if (input) {
            state.args = input;
            state.hasArgsDelta = true;
            yield { type: EventType.TOOL_CALL_ARGS, toolCallId, delta: input } as BaseEvent;
          }
        }
        if (!state.ended) {
          state.ended = true;
          yield { type: EventType.TOOL_CALL_END, toolCallId } as BaseEvent;
        }
        break;
      }
      case "tool-input-end": {
        break;
      }
      case "tool-result":
      case "tool-output-available": {
        const toolCallId = stringValue(part.toolCallId) || stringValue(part.id) || randomUUID();
        const state = ensureToolState(toolCalls, toolCallId, stringValue(part.toolName));
        if (!state.started) {
          state.started = true;
          yield toolCallStartEvent(toolCallId, state.name, messageId);
        }
        if (!state.ended) {
          state.ended = true;
          yield { type: EventType.TOOL_CALL_END, toolCallId } as BaseEvent;
        }
        yield {
          type: EventType.TOOL_CALL_RESULT,
          role: "tool",
          messageId: randomUUID(),
          toolCallId,
          content: stringifyJson(part.output ?? part.result),
        } as BaseEvent;
        break;
      }
      case "tool-error":
      case "tool-output-error": {
        const toolCallId = stringValue(part.toolCallId) || stringValue(part.id) || randomUUID();
        const state = ensureToolState(toolCalls, toolCallId, stringValue(part.toolName));
        if (!state.started) {
          state.started = true;
          yield toolCallStartEvent(toolCallId, state.name, messageId);
        }
        if (!state.ended) {
          state.ended = true;
          yield { type: EventType.TOOL_CALL_END, toolCallId } as BaseEvent;
        }
        yield {
          type: EventType.TOOL_CALL_RESULT,
          role: "tool",
          messageId: randomUUID(),
          toolCallId,
          content: stringifyJson({ ok: false, error: stringValue(part.errorText) || stringifyJson(part.error) }),
        } as BaseEvent;
        break;
      }
      case "error": {
        const error = part.error ?? part.errorText ?? part.message;
        throw new Error(error instanceof Error ? error.message : String(error));
      }
      case "finish":
        yield* closeActiveToolCalls(toolCalls);
        break;
      case "finish-step":
        break;
      case "start-step":
      case "reasoning-start":
      case "reasoning-delta":
      case "reasoning-end":
      case "source":
      case "raw":
        break;
      default:
        break;
    }
  }
  yield* dsml.finish();
  yield* closeActiveToolCalls(toolCalls);
}

class DsmlToolCallBuffer {
  private pending = "";
  private active = false;

  async *consume(
    delta: string,
    messageId: string,
    executeTextToolCall: AiSdkStreamToAgUiOptions["executeTextToolCall"]
  ): AsyncGenerator<BaseEvent> {
    this.pending += delta;

    while (this.pending) {
      if (!this.active) {
        const start = findDsmlToolCallsStart(this.pending);
        if (start < 0) {
          const holdLength = trailingDsmlStartPrefixLength(this.pending);
          const visible = this.pending.slice(0, this.pending.length - holdLength);
          if (visible) yield textChunkEvent(messageId, visible);
          this.pending = this.pending.slice(this.pending.length - holdLength);
          return;
        }

        const visible = this.pending.slice(0, start);
        if (visible) yield textChunkEvent(messageId, visible);
        this.pending = this.pending.slice(start);
        this.active = true;
      }

      const end = findDsmlToolCallsEnd(this.pending);
      if (end < 0) return;

      const block = this.pending.slice(0, end);
      this.pending = this.pending.slice(end);
      this.active = false;

      for (const call of parseDsmlToolCalls(block)) {
        yield* runDsmlTextToolCall(call, messageId, executeTextToolCall);
      }
    }
  }

  *finish(): Generator<BaseEvent> {
    if (!this.active && this.pending) {
      yield textChunkEvent(randomUUID(), this.pending);
    }
    this.pending = "";
    this.active = false;
  }
}

async function* runDsmlTextToolCall(
  call: DsmlTextToolCall,
  messageId: string,
  executeTextToolCall: AiSdkStreamToAgUiOptions["executeTextToolCall"]
): AsyncGenerator<BaseEvent> {
  if (!executeTextToolCall) return;
  yield toolCallStartEvent(call.id, call.name, messageId);
  yield { type: EventType.TOOL_CALL_ARGS, toolCallId: call.id, delta: stringifyJson(call.input) } as BaseEvent;
  yield { type: EventType.TOOL_CALL_END, toolCallId: call.id } as BaseEvent;

  try {
    const output = await executeTextToolCall(call);
    yield {
      type: EventType.TOOL_CALL_RESULT,
      role: "tool",
      messageId: randomUUID(),
      toolCallId: call.id,
      content: stringifyJson(output),
    } as BaseEvent;
  } catch (error) {
    yield {
      type: EventType.TOOL_CALL_RESULT,
      role: "tool",
      messageId: randomUUID(),
      toolCallId: call.id,
      content: stringifyJson({ ok: false, error: error instanceof Error ? error.message : String(error) }),
    } as BaseEvent;
  }
}

function createTextToolCallExecutor(
  tools: ToolSet,
  messages: ModelMessage[],
  abortSignal: AbortSignal
): (call: DsmlTextToolCall) => Promise<unknown> {
  return async (call) => {
    const tool = tools[call.name] as { execute?: (input: unknown, options: unknown) => unknown } | undefined;
    if (!tool?.execute) {
      throw new Error(`Unsupported server tool emitted as text: ${call.name}`);
    }
    const output = await tool.execute(call.input, {
      toolCallId: call.id,
      messages,
      abortSignal,
    });
    return collectToolExecutionOutput(output);
  };
}

async function collectToolExecutionOutput(output: unknown): Promise<unknown> {
  const awaited = await output;
  if (!isAsyncIterable(awaited)) return awaited;
  let latest: unknown = null;
  for await (const item of awaited) latest = item;
  return latest;
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return Boolean(value) && typeof (value as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] === "function";
}

function parseDsmlToolCalls(block: string): DsmlTextToolCall[] {
  const normalized = normalizeDsml(block);
  const calls: DsmlTextToolCall[] = [];
  const invokeRe = /<\|\|DSML\|\|invoke\s+name="([^"]+)"\s*>([\s\S]*?)<\/\|\|DSML\|\|invoke>/g;
  let invokeMatch: RegExpExecArray | null;

  while ((invokeMatch = invokeRe.exec(normalized))) {
    const [, rawName, body] = invokeMatch;
    const name = decodeDsmlText(rawName).trim();
    if (!name) continue;
    const input: Record<string, unknown> = {};
    const paramRe = /<\|\|DSML\|\|parameter\s+name="([^"]+)"(?:\s+string="([^"]+)")?\s*>([\s\S]*?)<\/\|\|DSML\|\|parameter>/g;
    let paramMatch: RegExpExecArray | null;

    while ((paramMatch = paramRe.exec(body))) {
      const [, rawParamName, stringFlag, rawValue] = paramMatch;
      const paramName = decodeDsmlText(rawParamName).trim();
      if (!paramName) continue;
      input[paramName] = parseDsmlParameterValue(rawValue, stringFlag);
    }

    calls.push({ id: `dsml-${randomUUID()}`, name, input });
  }

  return calls;
}

function parseDsmlParameterValue(rawValue: string, stringFlag: string | undefined): unknown {
  const value = decodeDsmlText(rawValue).trim();
  if (stringFlag !== "false") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    if (/^-?\d+(?:\.\d+)?$/.test(value)) return Number(value);
    if (value === "true") return true;
    if (value === "false") return false;
    if (value === "null") return null;
    return value;
  }
}

function findDsmlToolCallsStart(value: string): number {
  return normalizeDsml(value).indexOf("<||DSML||tool_calls>");
}

function findDsmlToolCallsEnd(value: string): number {
  const token = "</||DSML||tool_calls>";
  const index = normalizeDsml(value).indexOf(token);
  return index < 0 ? -1 : index + token.length;
}

function trailingDsmlStartPrefixLength(value: string): number {
  const normalized = normalizeDsml(value);
  const token = "<||DSML||tool_calls>";
  const max = Math.min(token.length - 1, normalized.length);
  for (let length = max; length > 0; length--) {
    if (token.startsWith(normalized.slice(-length))) return length;
  }
  return 0;
}

function normalizeDsml(value: string): string {
  return value.replaceAll("｜", "|");
}

function decodeDsmlText(value: string): string {
  return value
    .replaceAll("&quot;", "\"")
    .replaceAll("&apos;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

function textChunkEvent(messageId: string, delta: string): BaseEvent {
  return {
    type: EventType.TEXT_MESSAGE_CHUNK,
    messageId,
    role: "assistant",
    delta,
  } as BaseEvent;
}

export function agUiMessagesToModelMessages(messages: Message[]): ModelMessage[] {
  const toolNames = new Map<string, string>();
  const modelMessages: ModelMessage[] = [];

  for (const message of messages) {
    const text = textFromAgUiMessage(message).trim();
    if (message.role === "system" && text) {
      modelMessages.push({ role: "system", content: text });
      continue;
    }
    if (message.role === "developer" && text) {
      modelMessages.push({ role: "system", content: text });
      continue;
    }
    if (message.role === "user" && text) {
      modelMessages.push({ role: "user", content: text });
      continue;
    }
    if (message.role === "assistant") {
      const toolCalls = agUiToolCalls(message);
      for (const call of toolCalls) toolNames.set(call.id, call.function.name);
      if (toolCalls.length > 0) {
        const content = [
          ...(text ? [{ type: "text" as const, text }] : []),
          ...toolCalls.map((call) => ({
            type: "tool-call" as const,
            toolCallId: call.id,
            toolName: call.function.name,
            input: parseToolArguments(call.function.arguments),
          })),
        ];
        modelMessages.push({ role: "assistant", content });
      } else if (text) {
        modelMessages.push({ role: "assistant", content: text });
      }
      continue;
    }
    if (message.role === "tool") {
      const toolCallId = agUiToolCallId(message);
      if (!toolCallId) continue;
      modelMessages.push({
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId,
            toolName: toolNames.get(toolCallId) ?? "unknown_tool",
            output: parseToolOutput("content" in message ? message.content : ""),
          },
        ],
      } as ModelMessage);
    }
  }

  return modelMessages;
}

function finalAnswerModelMessages(messages: Message[]): ModelMessage[] {
  const question = latestUserText(messages) ?? "用户刚才的问题";
  const evidence = evidencePromptFromToolMessages(messages);
  return [
    {
      role: "user",
      content: [
        `用户问题：${question}`,
        "下面是已经执行完成的工具证据。请只基于这些证据回答，不要再调用任何工具。",
        "如果证据不足以确认精确答案，请明确说明不确定性，并列出最相关的标题和 URL 或本地路径。",
        evidence || "没有可用的工具证据。",
      ].join("\n\n"),
    },
  ];
}

function deterministicEvidenceAnswer(messages: Message[]): string {
  const question = latestUserText(messages);
  const results = collectToolEvidenceResults(messages).filter((result) => result.ok);
  const latest = results.at(-1);
  if (!latest || latest.evidence.length === 0) {
    return [
      "我已经尝试搜索，但没有拿到可用于回答的搜索结果。",
      question ? `问题：${question}` : "",
      "请换一个更具体的关键词，或检查 Web Search 配置后再试。",
    ].filter(Boolean).join("\n");
  }

  const items = latest.evidence.slice(0, 5);
  const sourceLabel = latest.source === "web"
    ? "Web Search"
    : latest.source === "session"
      ? "Session Memory"
      : "工具搜索";
  return [
    `我已经完成搜索，但模型没有成功生成最终总结。基于当前 ${sourceLabel} 结果，我先把可用证据直接给你：`,
    "",
    latest.query ? `搜索词：${latest.query}` : "",
    latest.reason ? `搜索原因：${latest.reason}` : "",
    "",
    "当前搜索摘要不足以让我可靠确认精确答案；最相关结果如下：",
    ...items.map((item, index) => {
      const target = item.url || item.path || "";
      const snippet = item.snippet ? `\n   摘要：${item.snippet}` : "";
      return `${index + 1}. ${item.title || "未命名结果"}${target ? `\n   ${target}` : ""}${snippet}`;
    }),
  ].filter((line) => line !== "").join("\n");
}

function evidencePromptFromToolMessages(messages: Message[]): string {
  const results = collectToolEvidenceResults(messages).slice(-4);
  if (results.length === 0) return "";
  return results.map((result, resultIndex) => {
    const header = [
      `工具结果 ${resultIndex + 1}: ${result.source || "unknown"}`,
      result.ok ? "ok=true" : "ok=false",
      result.query ? `query=${result.query}` : "",
      result.message ? `message=${result.message}` : "",
    ].filter(Boolean).join(" | ");
    const evidenceLines = result.evidence.slice(0, 5).map((item, itemIndex) => {
      const target = item.url || item.path || "";
      const snippet = item.snippet ? `\n  snippet: ${item.snippet}` : "";
      return `- #${itemIndex + 1} ${item.title || "未命名结果"}${target ? `\n  url/path: ${target}` : ""}${snippet}`;
    });
    return [header, ...evidenceLines].join("\n");
  }).join("\n\n");
}

function collectToolEvidenceResults(messages: Message[]): EvidenceResultForPrompt[] {
  const latestUser = latestUserIndex(messages);
  const scoped = latestUser >= 0 ? messages.slice(latestUser + 1) : messages;
  const results: EvidenceResultForPrompt[] = [];

  for (const message of scoped) {
    if (message.role !== "tool") continue;
    const content = "content" in message ? message.content : "";
    const parsed = parseToolOutputValue(content);
    if (!isRecord(parsed)) continue;
    const evidence = Array.isArray(parsed.evidence)
      ? parsed.evidence.filter(isRecord).map((item) => ({
          title: stringField(item.title),
          url: stringField(item.url),
          path: stringField(item.path),
          snippet: stringField(item.snippet),
        }))
      : [];
    results.push({
      ok: parsed.ok === true,
      source: stringField(parsed.source),
      query: stringField(parsed.query),
      reason: stringField(parsed.reason),
      message: stringField(parsed.message),
      evidence,
    });
  }

  return results;
}

function latestUserText(messages: Message[]): string | null {
  const index = latestUserIndex(messages);
  if (index < 0) return null;
  const text = textFromAgUiMessage(messages[index]).trim();
  return text || null;
}

function latestUserIndex(messages: Message[]): number {
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index].role === "user") return index;
  }
  return -1;
}

type EvidenceResultForPrompt = {
  ok: boolean;
  source: string;
  query: string;
  reason: string;
  message: string;
  evidence: Array<{
    title: string;
    url: string;
    path: string;
    snippet: string;
  }>;
};

function ai2NaoSystemPrompt(forwardedProps: unknown): string {
  const props = parseForwardedToolProps(forwardedProps);
  const parts = [
    "You are ai2nao's local-first AI workbench assistant.",
    "Reply in Simplified Chinese unless the user explicitly asks for another language.",
    "Use server-side tools when evidence is needed; do not claim you searched unless a tool result is present.",
    "After evidence tool calls, synthesize the evidence into a direct answer and cite the evidence paths or URLs when available.",
    "For web search evidence, include the most relevant result titles and URLs in the final answer. Do not merely say that you searched.",
    "For session memory evidence, cite the most relevant session titles and local paths when available, but do not expose whole transcripts.",
    "If web snippets are insufficient for an exact answer, state the uncertainty and still summarize the closest results with URLs.",
    "Do not stop after a tool result. Always continue with a concise final answer for the user.",
  ];
  if (props.useRag) {
    parts.push(
      "When the user asks to find, cite, inspect, or use local indexed materials, call ai2nao_search_rag_evidence before answering."
    );
  }
  if (props.webSearchEnabled) {
    parts.push(
      "When the user asks for current, external, or internet-only information, call ai2nao_web_search before answering."
    );
    parts.push(
      "Keep web search queries short and public-safe; never include private paths, emails, API keys, or tokens in web search queries."
    );
  }
  if (props.sessionMemoryEnabled) {
    parts.push(
      "When the user asks about previous ai2nao, Codex, Claude Code, Cursor, or Cherry Studio conversations or decisions, call ai2nao_search_session_memory before answering."
    );
    parts.push(
      "Session memory is local-only and read-only. Use narrow queries, summarize snippets, and avoid quoting or reconstructing whole conversations."
    );
  }
  if (props.codeExecutionEnabled) {
    parts.push(
      "When the user needs deterministic calculation, small data transformation, or Python verification, call ai2nao_run_code before answering."
    );
    parts.push(
      `ai2nao_run_code is Python-only. The enabled runtime for this turn is ${props.codeExecutionRuntime}. Do not use it for shell commands, package installation, network access, host filesystem access, or long-running services.`
    );
  }
  if (props.shellExecutionEnabled) {
    parts.push(
      "When the user asks to inspect the local project, run tests, run type checks, or verify a change with terminal output, call ai2nao_run_shell before answering."
    );
    parts.push(
      "ai2nao_run_shell is a controlled Bash tool, not a general terminal. Use concise commands only. Do not request package installation, network commands, destructive filesystem operations, sudo, nested shells, heredocs, file redirection, command substitution, or long-running services. If a command is denied, explain the denial and suggest a safer command."
    );
  }
  if (!props.useRag && !props.webSearchEnabled && !props.sessionMemoryEnabled && !props.codeExecutionEnabled && !props.shellExecutionEnabled) {
    parts.push("No evidence tools are enabled for this turn; answer from conversation context and say when evidence is unavailable.");
  }

  return parts.join("\n\n");
}

function finalAnswerSystemPrompt(basePrompt: string): string {
  return [
    basePrompt,
    "## Final Answer Enforcement",
    "The previous step ended after tool results without a user-facing answer.",
    "Do not call tools again. Use the tool evidence already present in the conversation.",
    "Answer the user's latest question directly in Simplified Chinese.",
    "When evidence is present, include concrete result titles and URLs or local paths. If the evidence does not fully answer the question, say so clearly.",
  ].join("\n\n");
}

function validateAi2NaoCopilotInput(
  messages: Message[],
  tools: unknown[],
  context: Context[],
  state: unknown
): void {
  if (tools.length > 0) {
    throw new Error("Client-provided CopilotKit tools are not supported for ai2nao.");
  }
  if (context.length > 0) {
    throw new Error("CopilotKit page context is not supported for ai2nao.");
  }
  if (hasCopilotKitState(state)) {
    throw new Error("CopilotKit shared state is not supported for ai2nao.");
  }
  for (const [index, message] of messages.entries()) {
    if (!["developer", "system", "user", "assistant", "tool", "activity", "reasoning"].includes(message.role)) {
      throw new Error(`Unsupported message role at index ${index}: ${message.role}`);
    }
  }
}

function parseAgentInput(raw: unknown): AgentInput {
  const rec = objectOrEmpty(raw);
  return {
    threadId: typeof rec.threadId === "string" && rec.threadId.trim() ? rec.threadId.trim() : "default",
    runId: typeof rec.runId === "string" ? rec.runId : undefined,
    messages: Array.isArray(rec.messages) ? (rec.messages as Message[]) : [],
    tools: Array.isArray(rec.tools) ? rec.tools : [],
    context: Array.isArray(rec.context) ? (rec.context as Context[]) : [],
    state: rec.state,
    forwardedProps: rec.forwardedProps,
  };
}

function hasCopilotKitState(state: unknown): boolean {
  if (state === undefined || state === null) return false;
  if (Array.isArray(state)) return state.length > 0;
  if (typeof state === "object") return Object.keys(state).length > 0;
  return true;
}

function mergeAgUiMessages(persistedMessages: Message[], inputMessages: Message[]): Message[] {
  const merged: Message[] = [];
  const seen = new Set<string>();
  for (const message of [...persistedMessages, ...inputMessages]) {
    if (seen.has(message.id)) continue;
    seen.add(message.id);
    merged.push(message);
  }
  return merged;
}

function ensureToolState(
  toolCalls: Map<string, ToolCallState>,
  toolCallId: string,
  toolName = "unknown_tool"
): ToolCallState {
  let state = toolCalls.get(toolCallId);
  if (!state) {
    state = {
      id: toolCallId,
      name: toolName,
      args: "",
      started: false,
      hasArgsDelta: false,
      ended: false,
    };
    toolCalls.set(toolCallId, state);
  }
  return state;
}

function* closeActiveToolCalls(toolCalls: Map<string, ToolCallState>): Generator<BaseEvent> {
  for (const state of toolCalls.values()) {
    if (state.ended) continue;
    state.ended = true;
    yield { type: EventType.TOOL_CALL_END, toolCallId: state.id } as BaseEvent;
  }
}

function toolCallStartEvent(toolCallId: string, toolCallName: string, parentMessageId?: string): BaseEvent {
  return {
    type: EventType.TOOL_CALL_START,
    toolCallId,
    toolCallName,
    ...(parentMessageId ? { parentMessageId } : {}),
  } as BaseEvent;
}

function agUiToolCalls(message: Message): AgUiToolCall[] {
  if (!("toolCalls" in message) || !Array.isArray(message.toolCalls)) return [];
  return message.toolCalls.filter((call): call is AgUiToolCall => {
    const fn = call && typeof call === "object" ? (call as { function?: unknown }).function : null;
    return (
      Boolean(call) &&
      typeof call === "object" &&
      typeof (call as { id?: unknown }).id === "string" &&
      Boolean(fn) &&
      typeof fn === "object" &&
      typeof (fn as { name?: unknown }).name === "string"
    );
  });
}

function agUiToolCallId(message: Message): string | null {
  if (!("toolCallId" in message)) return null;
  return typeof message.toolCallId === "string" && message.toolCallId.trim()
    ? message.toolCallId
    : null;
}

function parseToolArguments(value: unknown): unknown {
  if (typeof value !== "string") return {};
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return {};
  }
}

function parseToolOutput(value: unknown): ToolResultOutputForPrompt {
  const parsed = parseToolOutputValue(value);
  return typeof parsed === "string"
    ? { type: "text", value: parsed }
    : { type: "json", value: toJsonValue(parsed) };
}

function parseToolOutputValue(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function toJsonValue(value: unknown): JsonValue {
  if (value === undefined) return null;
  try {
    const encoded = JSON.stringify(value);
    return encoded === undefined ? null : (JSON.parse(encoded) as JsonValue);
  } catch {
    return String(value);
  }
}

class GeneratedMessages {
  private textMessages = new Map<string, Message & { content: string }>();
  private toolCallMessages = new Map<string, Message & { toolCalls: AgUiToolCall[] }>();
  private ordered: Message[] = [];

  apply(event: BaseEvent) {
    if (event.type === EventType.TEXT_MESSAGE_START) {
      const messageId = String(event.messageId);
      const message = { id: messageId, role: "assistant", content: "" } as Message & { content: string };
      this.textMessages.set(messageId, message);
      this.ordered.push(message);
    } else if (event.type === EventType.TEXT_MESSAGE_CONTENT) {
      const message = this.textMessages.get(String(event.messageId));
      if (message) message.content += event.delta;
    } else if (event.type === EventType.TEXT_MESSAGE_CHUNK) {
      const messageId = String(event.messageId);
      let message = this.textMessages.get(messageId);
      if (!message) {
        message = { id: messageId, role: "assistant", content: "" } as Message & { content: string };
        this.textMessages.set(messageId, message);
        this.ordered.push(message);
      }
      message.content += event.delta ?? "";
    } else if (event.type === EventType.TOOL_CALL_START) {
      const parentId = "parentMessageId" in event && typeof event.parentMessageId === "string" ? event.parentMessageId : "";
      const toolCallId = String(event.toolCallId);
      const toolCallName = String(event.toolCallName);
      const messageId = parentId || toolCallId;
      let message = this.toolCallMessages.get(messageId);
      if (!message) {
        const textMessage = this.textMessages.get(messageId) as (Message & { content: string; toolCalls?: AgUiToolCall[] }) | undefined;
        if (textMessage) {
          textMessage.toolCalls ??= [];
          message = textMessage as Message & { toolCalls: AgUiToolCall[] };
        } else {
          message = { id: messageId, role: "assistant", toolCalls: [] } as Message & { toolCalls: AgUiToolCall[] };
          this.ordered.push(message);
        }
        this.toolCallMessages.set(messageId, message);
      }
      message.toolCalls.push({
        id: toolCallId,
        type: "function",
        function: { name: toolCallName, arguments: "" },
      });
    } else if (event.type === EventType.TOOL_CALL_ARGS) {
      const toolCall = this.findToolCall(String(event.toolCallId));
      if (toolCall) toolCall.function.arguments += event.delta;
    } else if (event.type === EventType.TOOL_CALL_RESULT) {
      this.ordered.push({
        id: event.messageId,
        role: "tool",
        toolCallId: event.toolCallId,
        content: event.content,
      } as Message);
    }
  }

  messages(): Message[] {
    return this.ordered.filter(
      (message) =>
        message.role !== "assistant" ||
        textFromAgUiMessage(message).trim() ||
        ("toolCalls" in message && Boolean(message.toolCalls?.length))
    );
  }

  needsFinalAnswer(): boolean {
    let latestToolResultIndex = -1;
    let latestAssistantTextIndex = -1;
    this.ordered.forEach((message, index) => {
      if (message.role === "tool") latestToolResultIndex = index;
      if (message.role === "assistant" && textFromAgUiMessage(message).trim()) {
        latestAssistantTextIndex = index;
      }
    });
    return latestToolResultIndex >= 0 && latestAssistantTextIndex < latestToolResultIndex;
  }

  private findToolCall(toolCallId: string): AgUiToolCall | undefined {
    for (const message of this.toolCallMessages.values()) {
      const toolCall = message.toolCalls.find((call) => call.id === toolCallId);
      if (toolCall) return toolCall;
    }
    return undefined;
  }
}

type AgUiToolCall = {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
};

function objectOrEmpty(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringField(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function stringifyJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function copilotKitStatusForTests() {
  return llmChatStatus();
}
