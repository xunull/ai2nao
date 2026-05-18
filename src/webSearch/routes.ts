import type { Hono } from "hono";
import { getDefaultWebSearchService, type WebSearchService } from "./service.js";

function jsonErr(status: number, message: string) {
  return Response.json({ error: { message } }, { status });
}

export function registerWebSearchRoutes(app: Hono, service: WebSearchService = getDefaultWebSearchService()): void {
  app.get("/api/web-search/status", (c) => c.json(service.status()));

  app.post("/api/web-search", async (c) => {
    const body = (await c.req.json().catch(() => null)) as {
      query?: unknown;
      count?: unknown;
      reason?: unknown;
    } | null;
    if (!body || typeof body !== "object") return jsonErr(400, "JSON body is required");
    const result = await service.search({
      query: typeof body.query === "string" ? body.query : "",
      count: typeof body.count === "number" ? body.count : undefined,
      reason: typeof body.reason === "string" ? body.reason : undefined,
    });
    return c.json(result, result.ok ? 200 : 400);
  });
}
