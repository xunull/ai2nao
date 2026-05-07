import type Database from "better-sqlite3";
import type { Hono } from "hono";
import { llmChatLogDebugBannerIfEnabled } from "./log.js";
import { registerLlmChatChatRoutes } from "./chatRoutes.js";
import { registerCopilotKitRoutes } from "./copilotRuntime.js";
import { registerLlmChatSessionRoutes } from "./sessionRoutes.js";

export type LlmChatRouteDeps = {
  db?: Database.Database;
  ragDb?: Database.Database;
};

export function registerLlmChatRoutes(app: Hono, deps?: LlmChatRouteDeps): void {
  llmChatLogDebugBannerIfEnabled();
  registerLlmChatChatRoutes(app);
  if (deps?.db) {
    registerCopilotKitRoutes(app, { db: deps.db, ragDb: deps.ragDb });
  }
  registerLlmChatSessionRoutes(app, { db: deps?.db });
}
