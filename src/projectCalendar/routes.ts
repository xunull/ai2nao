/**
 * Hono routes for /api/project-calendar/*.
 *
 *   GET  /api/project-calendar/month?year=&month=  月聚合(日历色阶 + 小点 + serverToday)
 *   GET  /api/project-calendar/day?date=           当日明细(主列表 + 仅提交折叠区)
 *   GET  /api/project-calendar/sync-status         提交摄取的覆盖率与进度(轮询)
 *   POST /api/project-calendar/sync-commits        触发提交摄取
 *
 * 入参非法一律 400(InvalidParam)。脏输入安静返回空 = 伪装成「那天没活动」,不接受。
 *
 * POST 复用 scheduler.runNow 自带的 lease + runningTaskKeys 双重防重入(照 workCosmos)。
 * 它会 **await 到任务结束**(几十秒到几分钟),前端不等这个响应,直接轮询 sync-status;
 * 重复点击会拿到 409 locked,不会起第二个摄取。
 *
 * 必须在 src/serve/app.ts 的 createApp 里注册,否则不可达。
 */
import type { Hono } from "hono";
import type Database from "better-sqlite3";
import type { SchedulerRuntime } from "../scheduler/runner.js";
import {
  GIT_COMMITS_TASK_KEY,
  InvalidParam,
  dayDetail,
  monthActivity,
  syncCoverage,
  syncProgress,
} from "./queries.js";

function jsonErr(status: number, message: string) {
  return Response.json({ error: { message } }, { status });
}

/** InvalidParam → 400,其余 → 500。 */
function handle(e: unknown) {
  const message = e instanceof Error ? e.message : String(e);
  return jsonErr(e instanceof InvalidParam ? 400 : 500, message);
}

export function registerProjectCalendarRoutes(
  app: Hono,
  db: Database.Database,
  scheduler: SchedulerRuntime | undefined
): void {
  app.get("/api/project-calendar/month", (c) => {
    try {
      const year = c.req.query("year");
      const month = c.req.query("month");
      return c.json({ ok: true, ...monthActivity(db, year, month) });
    } catch (e) {
      return handle(e);
    }
  });

  app.get("/api/project-calendar/day", (c) => {
    try {
      return c.json({ ok: true, ...dayDetail(db, c.req.query("date")) });
    } catch (e) {
      return handle(e);
    }
  });

  app.get("/api/project-calendar/sync-status", (c) => {
    try {
      return c.json({
        ok: true,
        coverage: syncCoverage(db),
        progress: syncProgress(db),
      });
    } catch (e) {
      return handle(e);
    }
  });

  app.post("/api/project-calendar/sync-commits", async (c) => {
    if (!scheduler) {
      return jsonErr(
        503,
        "commit sync requires the scheduler runtime; embedded mode is read-only"
      );
    }
    if (!scheduler.registry.has(GIT_COMMITS_TASK_KEY)) {
      return jsonErr(
        500,
        `task ${GIT_COMMITS_TASK_KEY} not registered with scheduler`
      );
    }
    const result = await scheduler.runNow(GIT_COMMITS_TASK_KEY, "manual");
    if (!result.ok) {
      // 'locked' = 已在跑(lease 或 runningTaskKeys 挡住)→ 409,不是 500。
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
