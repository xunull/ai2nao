import type { Hono } from "hono";
import { llmChatStatus } from "./config.js";
import { llmChatLog } from "./log.js";

export function registerLlmChatChatRoutes(app: Hono): void {
  app.get("/api/llm-chat/status", (c) => {
    const s = llmChatStatus();
    llmChatLog.debug("GET /api/llm-chat/status", s);
    return c.json(s);
  });
}
