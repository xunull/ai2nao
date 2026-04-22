import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { Hono } from "hono";
import { convertToModelMessages, streamText, type UIMessage } from "ai";
import { readRagConfig } from "../rag/config.js";
import { countChunks, searchHybrid } from "../rag/retrieve.js";
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

function textFromLastUserMessage(messages: UIMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role !== "user") continue;
    const parts = m?.parts;
    if (!Array.isArray(parts)) continue;
    const texts = parts.filter((p): p is { type: "text"; text: string } => p.type === "text");
    if (texts.length === 0) continue;
    return texts.map((p) => p.text).join("");
  }
  return null;
}

export type LlmChatRouteDeps = {
  ragDb?: Database.Database;
};

export function registerLlmChatRoutes(app: Hono, deps?: LlmChatRouteDeps): void {
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
    const rawBody = body as {
      messages: unknown;
      useRag?: unknown;
      ragTopK?: unknown;
    };
    const { messages } = rawBody;
    if (!Array.isArray(messages)) {
      llmChatLog.warn(reqId, "messages is not an array");
      return jsonErr(400, "messages must be an array");
    }

    const useRag = rawBody.useRag === true;
    const ragTopK = Math.min(
      20,
      Math.max(1, parseInt(String(rawBody.ragTopK ?? 8), 10) || 8)
    );

    try {
      const uiMessages = messages as UIMessage[];
      llmChatLog.info(reqId, "POST /api/llm-chat start", {
        model: cfg.model,
        useRag,
        ...summarizeUiMessages(uiMessages),
      });

      const model = createChatLanguageModel(cfg);
      const modelMessages = await convertToModelMessages(uiMessages);
      llmChatLog.debug(reqId, "convertToModelMessages ok", {
        modelMessages: modelMessages.length,
      });

      let system: string | undefined;
      if (useRag) {
        if (!deps?.ragDb) {
          return jsonErr(
            503,
            "RAG is not available. Start the server with RAG DB support or run from a current ai2nao that opens ~/.ai2nao/rag.db."
          );
        }
        if (countChunks(deps.ragDb) === 0) {
          return jsonErr(
            503,
            "RAG index is empty. Run: ai2nao rag ingest --root <path> (or configure ~/.ai2nao/rag.json)."
          );
        }
        const lastUser = textFromLastUserMessage(uiMessages);
        if (!lastUser?.trim()) {
          return jsonErr(
            400,
            "useRag requires at least one user message with text to search the corpus"
          );
        }
        const ragCfg = readRagConfig();
        const hits = await searchHybrid(deps.ragDb, lastUser.trim(), ragTopK, ragCfg);
        if (hits.length === 0) {
          system = [
            "The local RAG index returned no good keyword matches for the user's last message.",
            "Answer using general knowledge and briefly note that the indexed files did not match strongly.",
          ].join(" ");
        } else {
          const blocks = hits.map(
            (h, i) => `[#${i + 1}] ${h.filePath} (root: ${h.sourceRoot})\n${h.content}`
          );
          system = [
            "You are given excerpts from the user's locally indexed text files.",
            "Ground answers in these excerpts when they are relevant, and mention which file path you used.",
            "If excerpts are insufficient, say so clearly.",
            "---",
            ...blocks,
          ].join("\n\n");
        }
        llmChatLog.info(reqId, "RAG context", { hits: hits.length, ragTopK });
      }

      const result = streamText({
        model,
        system,
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
