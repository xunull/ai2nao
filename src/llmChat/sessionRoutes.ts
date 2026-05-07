import type Database from "better-sqlite3";
import type { Hono } from "hono";
import { jsonErr, safeJson } from "./http.js";
import {
  createLlmChatSession,
  deleteLlmChatSession,
  getLlmChatSession,
  listLlmChatSessions,
  LlmChatSessionError,
} from "./sessions.js";

export type LlmChatSessionRouteDeps = {
  db?: Database.Database;
};

export function registerLlmChatSessionRoutes(
  app: Hono,
  deps?: LlmChatSessionRouteDeps
): void {
  app.get("/api/llm-chat/sessions", (c) => {
    if (!deps?.db) return jsonErr(503, "LLM chat session storage is unavailable");
    try {
      const limit = parseInt(c.req.query("limit") ?? "50", 10);
      return c.json({ sessions: listLlmChatSessions(deps.db, limit) });
    } catch (e) {
      return jsonErr(500, e instanceof Error ? e.message : String(e));
    }
  });

  app.post("/api/llm-chat/sessions", async (c) => {
    if (!deps?.db) return jsonErr(503, "LLM chat session storage is unavailable");
    try {
      const body = await safeJson(c);
      const title =
        body && typeof body === "object"
          ? (body as { title?: unknown }).title
          : undefined;
      return c.json({
        session: createLlmChatSession(
          deps.db,
          typeof title === "string" ? title : undefined
        ),
      });
    } catch (e) {
      return sessionErr(e);
    }
  });

  app.get("/api/llm-chat/sessions/:id", (c) => {
    if (!deps?.db) return jsonErr(503, "LLM chat session storage is unavailable");
    try {
      const session = getLlmChatSession(deps.db, c.req.param("id"));
      if (!session) return jsonErr(404, "session not found");
      return c.json({ session });
    } catch (e) {
      return jsonErr(500, e instanceof Error ? e.message : String(e));
    }
  });

  app.delete("/api/llm-chat/sessions/:id", (c) => {
    if (!deps?.db) return jsonErr(503, "LLM chat session storage is unavailable");
    try {
      const deleted = deleteLlmChatSession(deps.db, c.req.param("id"));
      if (!deleted) return jsonErr(404, "session not found");
      return c.json({ ok: true });
    } catch (e) {
      return jsonErr(500, e instanceof Error ? e.message : String(e));
    }
  });
}

function sessionErr(e: unknown) {
  if (e instanceof LlmChatSessionError) {
    return jsonErr(e.status, e.message);
  }
  return jsonErr(500, e instanceof Error ? e.message : String(e));
}
