/**
 * Hono routes for /api/work-cosmos/*.
 *
 * 三个端点：
 *   GET  /api/work-cosmos/points          —— 散点图数据，永不含 summary
 *   POST /api/work-cosmos/refresh         —— 触发后端 refresh（lease 防并发，D4）
 *   GET  /api/work-cosmos/refresh-status  —— 1s 轮询进度，D5
 *
 * POST refresh 复用 scheduler.runNow 自带的 lease 机制；如果 SchedulerRuntime
 * 没注入（极少数嵌入式场景），返 503 而不是粗暴的 500。
 */
import type { Hono } from "hono";
import type Database from "better-sqlite3";
import type { SchedulerRuntime } from "../scheduler/runner.js";
import {
  buildCosmosPointsResponse,
  buildCosmosRefreshStatus,
} from "./service.js";

const COSMOS_REFRESH_TASK_KEY = "work.cosmos.refresh";

function jsonErr(status: number, message: string) {
  return Response.json({ error: { message } }, { status });
}

export function registerWorkCosmosRoutes(
  app: Hono,
  db: Database.Database,
  scheduler: SchedulerRuntime | undefined
): void {
  app.get("/api/work-cosmos/points", (c) => {
    try {
      return c.json(buildCosmosPointsResponse(db));
    } catch (e) {
      return jsonErr(500, e instanceof Error ? e.message : String(e));
    }
  });

  app.get("/api/work-cosmos/refresh-status", (c) => {
    return c.json(buildCosmosRefreshStatus());
  });

  app.post("/api/work-cosmos/refresh", async (c) => {
    if (!scheduler) {
      return jsonErr(
        503,
        "cosmos refresh requires the scheduler runtime; embedded mode is read-only"
      );
    }
    if (!scheduler.registry.has(COSMOS_REFRESH_TASK_KEY)) {
      return jsonErr(
        500,
        `task ${COSMOS_REFRESH_TASK_KEY} not registered with scheduler`
      );
    }
    const result = await scheduler.runNow(COSMOS_REFRESH_TASK_KEY, "manual");
    if (!result.ok) {
      // 'locked' = lease held (D4 concurrent guard) → 409 not 500
      const status =
        result.status === "unknown_task"
          ? 404
          : result.status === "locked"
            ? 409
            : 500;
      return jsonErr(status, result.message);
    }
    return c.json(result);
  });
}
