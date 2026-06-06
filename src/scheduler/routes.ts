import type { Hono } from "hono";
import {
  listScheduledTaskRuns,
  listScheduledTasks,
  updateScheduledTask,
} from "./store.js";
import type { SchedulerRuntime } from "./runner.js";

function jsonErr(status: number, message: string) {
  return Response.json({ error: { message } }, { status });
}

export function registerSchedulerRoutes(
  app: Hono,
  runtime: SchedulerRuntime
): void {
  app.get("/api/scheduler/tasks", (c) => {
    return c.json({
      tasks: listScheduledTasks(runtime.db, runtime.registry.list()),
    });
  });

  app.patch("/api/scheduler/tasks/:taskKey", async (c) => {
    const taskKey = c.req.param("taskKey");
    if (!runtime.registry.has(taskKey)) return jsonErr(404, "unknown task");
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const patch = parseTaskPatch(body);
    if ("error" in patch) return jsonErr(400, patch.error);
    const row = updateScheduledTask(runtime.db, taskKey, patch);
    if (!row) return jsonErr(404, "unknown task");
    return c.json({
      task: listScheduledTasks(runtime.db, runtime.registry.list()).find((t) => t.key === taskKey),
    });
  });

  app.post("/api/scheduler/tasks/:taskKey/run", async (c) => {
    const taskKey = c.req.param("taskKey");
    const result = await runtime.runNow(taskKey, "manual");
    if (!result.ok) {
      return jsonErr(result.status === "unknown_task" ? 404 : 409, result.message);
    }
    return c.json(result);
  });

  app.get("/api/scheduler/runs", (c) => {
    const taskKey = cleanOptionalString(c.req.query("taskKey"));
    if (taskKey && !runtime.registry.has(taskKey)) return jsonErr(404, "unknown task");
    const limitRaw = parseInt(c.req.query("limit") ?? "50", 10);
    const limit = Number.isFinite(limitRaw) ? limitRaw : 50;
    return c.json({ runs: listScheduledTaskRuns(runtime.db, { taskKey, limit }) });
  });
}

function parseTaskPatch(
  body: Record<string, unknown>
):
  | {
      enabled?: boolean;
      intervalSeconds?: number | null;
      nextRunAt?: string | null;
      config?: Record<string, unknown>;
    }
  | { error: string } {
  const patch: {
    enabled?: boolean;
    intervalSeconds?: number | null;
    nextRunAt?: string | null;
    config?: Record<string, unknown>;
  } = {};
  if ("enabled" in body) {
    if (typeof body.enabled !== "boolean") return { error: "enabled must be boolean" };
    patch.enabled = body.enabled;
  }
  if ("intervalSeconds" in body) {
    if (body.intervalSeconds == null) {
      patch.intervalSeconds = null;
    } else if (
      typeof body.intervalSeconds === "number" &&
      Number.isInteger(body.intervalSeconds) &&
      body.intervalSeconds >= 30
    ) {
      patch.intervalSeconds = body.intervalSeconds;
    } else {
      return { error: "intervalSeconds must be an integer >= 30 or null" };
    }
  }
  if ("nextRunAt" in body) {
    if (body.nextRunAt == null) {
      patch.nextRunAt = null;
    } else if (typeof body.nextRunAt === "string" && !Number.isNaN(Date.parse(body.nextRunAt))) {
      patch.nextRunAt = new Date(body.nextRunAt).toISOString();
    } else {
      return { error: "nextRunAt must be an ISO date string or null" };
    }
  }
  if ("config" in body) {
    if (body.config && typeof body.config === "object" && !Array.isArray(body.config)) {
      patch.config = body.config as Record<string, unknown>;
    } else {
      return { error: "config must be an object" };
    }
  }
  return patch;
}

function cleanOptionalString(raw: string | undefined): string | undefined {
  const t = (raw ?? "").trim();
  return t.length > 0 ? t : undefined;
}
