import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { Hono } from "hono";
import {
  BuiltInAgent,
  CopilotRuntime,
  AgentRunner,
  convertMessagesToVercelAISDKMessages,
  type AgentRunnerConnectRequest,
  type AgentRunnerIsRunningRequest,
  type AgentRunnerRunRequest,
  type AgentRunnerStopRequest,
} from "@copilotkit/runtime/v2";
import { createCopilotHonoHandler } from "@copilotkit/runtime/v2/hono";
import {
  EventType,
  type BaseEvent,
  type Message,
} from "@ag-ui/client";
import { Observable } from "rxjs";
import { streamText } from "ai";
import { readRagConfig } from "../rag/config.js";
import { countChunks, searchHybrid } from "../rag/retrieve.js";
import { llmChatStatus, readLlmChatConfig } from "./config.js";
import { createChatLanguageModel } from "./model.js";
import { llmChatLog } from "./log.js";
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
};

export function registerCopilotKitRoutes(
  app: Hono,
  deps: LlmChatCopilotRuntimeDeps
): void {
  const agent = new BuiltInAgent({
    type: "aisdk",
    factory: async ({ input, abortSignal }) => {
      const cfg = readLlmChatConfig();
      if (!cfg) {
        throw new Error(
          "LLM chat is not configured. Add ~/.ai2nao/llm-chat.json or set AI2NAO_LLM_CHAT_CONFIG."
        );
      }
      validateAi2NaoCopilotInput(input.messages, input.tools);
      const model = createChatLanguageModel(cfg);
      const modelMessages = convertMessagesToVercelAISDKMessages(input.messages);
      const system = await ragSystemPrompt(deps, input.messages, input.forwardedProps);
      return streamText({
        model,
        system,
        messages: modelMessages,
        abortSignal,
        onFinish: (ev) => {
          llmChatLog.info("CopilotKit streamText onFinish", {
            threadId: input.threadId,
            finishReason: ev.finishReason,
            usage: ev.totalUsage,
          });
        },
        onError: ({ error }) => {
          llmChatLog.error("CopilotKit streamText onError", error);
        },
      });
    },
    capabilities: {
      tools: { supported: false, clientProvided: false },
      transport: { streaming: true },
    },
  });

  const runtime = new CopilotRuntime({
    agents: { default: agent },
    runner: new SqliteLlmChatRunner(deps.db),
  });

  app.route(
    "/",
    createCopilotHonoHandler({
      runtime,
      basePath: "/api/copilotkit",
      mode: "single-route",
    })
  );
}

class SqliteLlmChatRunner extends AgentRunner {
  private readonly runningThreadIds = new Set<string>();

  constructor(private readonly db: Database.Database) {
    super();
  }

  run(request: AgentRunnerRunRequest): ReturnType<AgentRunner["run"]> {
    return new Observable<BaseEvent>((subscriber) => {
      this.runningThreadIds.add(request.threadId);
      ensureLlmChatSession(this.db, request.threadId);
      const detail = getLlmChatSession(this.db, request.threadId);
      const persistedMessages = detail ? agUiMessagesFromSession(detail) : [];
      const inputMessages = Array.isArray(request.input.messages) ? request.input.messages : [];
      const mergedMessages = mergeAgUiMessages(persistedMessages, inputMessages);
      const mergedInput = { ...request.input, messages: mergedMessages };

      request.agent
        .runAgent(mergedInput, {
          onEvent: ({ event }) => subscriber.next(event),
        })
        .then(() => {
          replaceLlmChatSessionMessages(this.db, request.threadId, {
            messages: request.agent.messages as Message[],
          });
          subscriber.complete();
        })
        .catch((error) => subscriber.error(error))
        .finally(() => {
          this.runningThreadIds.delete(request.threadId);
        });

      return () => {
        void request.agent.detachActiveRun().catch(() => {});
      };
    }) as unknown as ReturnType<AgentRunner["run"]>;
  }

  connect(request: AgentRunnerConnectRequest): ReturnType<AgentRunner["connect"]> {
    return new Observable<BaseEvent>((subscriber) => {
      const detail = getLlmChatSession(this.db, request.threadId);
      const messages = detail ? agUiMessagesFromSession(detail) : [];
      const runId = randomUUID();
      subscriber.next({
        type: EventType.RUN_STARTED,
        threadId: request.threadId,
        runId,
      });
      subscriber.next({
        type: EventType.MESSAGES_SNAPSHOT,
        messages,
      });
      subscriber.next({
        type: EventType.RUN_FINISHED,
        threadId: request.threadId,
        runId,
      });
      subscriber.complete();
    }) as unknown as ReturnType<AgentRunner["connect"]>;
  }

  async isRunning(request: AgentRunnerIsRunningRequest): Promise<boolean> {
    return this.runningThreadIds.has(request.threadId);
  }

  async stop(request: AgentRunnerStopRequest): Promise<boolean> {
    const wasRunning = this.runningThreadIds.delete(request.threadId);
    return wasRunning;
  }
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

function validateAi2NaoCopilotInput(messages: Message[], tools: unknown[]): void {
  if (tools.length > 0) {
    throw new Error("CopilotKit tools/actions are not enabled for this AI chat.");
  }
  for (const [index, message] of messages.entries()) {
    if (!["system", "user", "assistant"].includes(message.role)) {
      throw new Error(`Unsupported message role at index ${index}: ${message.role}`);
    }
    if (message.role === "assistant" && message.toolCalls?.length) {
      throw new Error("Tool-call messages are not enabled for this AI chat.");
    }
  }
}

async function ragSystemPrompt(
  deps: LlmChatCopilotRuntimeDeps,
  messages: Message[],
  forwardedProps: unknown
): Promise<string | undefined> {
  const props =
    forwardedProps && typeof forwardedProps === "object"
      ? (forwardedProps as Record<string, unknown>)
      : {};
  const useRag = props.useRag === true;
  if (!useRag) return undefined;

  if (!deps.ragDb) {
    throw new Error(
      "RAG is not available. Start the server with RAG DB support or run from a current ai2nao that opens ~/.ai2nao/rag.db."
    );
  }
  if (countChunks(deps.ragDb) === 0) {
    throw new Error(
      "RAG index is empty. Run: ai2nao rag ingest --root <path> (or configure ~/.ai2nao/rag.json)."
    );
  }

  const lastUser = lastUserText(messages);
  if (!lastUser) {
    throw new Error("useRag requires at least one user message with text to search the corpus");
  }

  const rawTopK = parseInt(String(props.ragTopK ?? 8), 10);
  const ragTopK = Math.min(20, Math.max(1, rawTopK || 8));
  const hits = await searchHybrid(deps.ragDb, lastUser, ragTopK, readRagConfig());
  if (hits.length === 0) {
    return [
      "The local RAG index returned no good keyword matches for the user's last message.",
      "Answer using general knowledge and briefly note that the indexed files did not match strongly.",
    ].join(" ");
  }
  const blocks = hits.map(
    (h, i) => `[#${i + 1}] ${h.filePath} (root: ${h.sourceRoot})\n${h.content}`
  );
  return [
    "You are given excerpts from the user's locally indexed text files.",
    "Ground answers in these excerpts when they are relevant, and mention which file path you used.",
    "If excerpts are insufficient, say so clearly.",
    "---",
    ...blocks,
  ].join("\n\n");
}

function lastUserText(messages: Message[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role !== "user") continue;
    const text = textFromAgUiMessage(message).trim();
    if (text) return text;
  }
  return null;
}

export function copilotKitStatusForTests() {
  return llmChatStatus();
}
