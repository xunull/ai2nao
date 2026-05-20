import type { Hono } from "hono";
import { getCodeRunnerStatus } from "./status.js";

export function registerCodeRunnerRoutes(app: Hono): void {
  app.get("/api/code-runner/status", async (c) => {
    return c.json(await getCodeRunnerStatus());
  });
}
