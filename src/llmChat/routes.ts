import { randomUUID } from "node:crypto";
import type { Hono } from "hono";
import { convertToModelMessages, streamText, type UIMessage } from "ai";
import { llmChatStatus, readLlmChatConfig } from "./config.js";
import { llmChatLog, llmChatLogDebugBannerIfEnabled } from "./log.js";
import { createChatLanguageModel } from "./model.js";

function jsonErr(status: number, message: string) {
  return Response.json({ error: { message } }, { status });
}

function summarizeUiMessages(messages: UIMessage[]): { count: number; roles: string } {
  const roles = messages.map((m) => m.role).join(",");
  return { count: messages.length, roles };
}

export function registerLlmChatRoutes(app: Hono): void {
  llmChatLogDebugBannerIfEnabled();

  app.get("/api/llm-chat/status", (c) => {
    const s = llmChatStatus();
    llmChatLog.debug("GET /api/llm-chat/status", s);
    return c.json(s);
  });

  app.post("/api/llm-chat", async (c) => {
    const reqId = randomUUID().slice(0, 8);
    const cfg = readLlmChatConfig();
    if (!cfg) {
      llmChatLog.warn(reqId, "reject POST: no config");
      return jsonErr(
        503,
        "LLM chat is not configured. Add ~/.ai2nao/llm-chat.json (see llm-chat.config.example.json) or set AI2NAO_LLM_CHAT_CONFIG."
      );
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch (e) {
      llmChatLog.warn(reqId, "invalid JSON body", e instanceof Error ? e.message : String(e));
      return jsonErr(400, "Invalid JSON body");
    }

    if (!body || typeof body !== "object" || !("messages" in body)) {
      llmChatLog.warn(reqId, "missing messages in body");
      return jsonErr(400, "Missing messages");
    }
    const { messages } = body as { messages: unknown };
    if (!Array.isArray(messages)) {
      llmChatLog.warn(reqId, "messages is not an array");
      return jsonErr(400, "messages must be an array");
    }

    try {
      const uiMessages = messages as UIMessage[];
      llmChatLog.info(reqId, "POST /api/llm-chat start", {
        model: cfg.model,
        ...summarizeUiMessages(uiMessages),
      });

      const model = createChatLanguageModel(cfg);
      const modelMessages = await convertToModelMessages(uiMessages);
      llmChatLog.debug(reqId, "convertToModelMessages ok", { modelMessages: modelMessages.length });

      const result = streamText({
        model,
        messages: modelMessages,
        onError: ({ error }) => {
          llmChatLog.error(reqId, "streamText onError", error);
        },
        onFinish: (ev) => {
          llmChatLog.info(reqId, "streamText onFinish", {
            finishReason: ev.finishReason,
            usage: ev.totalUsage,
          });
        },
      });

      return result.toUIMessageStreamResponse({
        onError: (error) => {
          llmChatLog.error(reqId, "toUIMessageStreamResponse onError", error);
          return error instanceof Error ? error.message : String(error);
        },
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      llmChatLog.error(reqId, "POST /api/llm-chat failed before stream", e);
      return jsonErr(500, msg);
    }
  });
}
