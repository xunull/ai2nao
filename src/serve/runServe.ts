import { serve } from "@hono/node-server";
import type Database from "better-sqlite3";
import { createApp, resolveWebDist } from "./app.js";
import type { DailySummaryRuntimeOptions } from "../dailySummary/service.js";
import { SchedulerLoop } from "../scheduler/loop.js";
import { ScheduledTaskRegistry } from "../scheduler/registry.js";
import { SchedulerRuntime } from "../scheduler/runner.js";
import { createDefaultScheduledTaskDefinitions } from "../scheduler/taskDefinitions.js";

export type RunServeOptions = {
  db: Database.Database;
  /** Read-only index DB handle for the MCP server; owned + closed here. */
  mcpDb?: Database.Database;
  /** Optional Atuin history.db (read-only). */
  atuin?: { db: Database.Database; path: string };
  dailySummary?: {
    cacheDb: Database.Database | null;
    runtime: DailySummaryRuntimeOptions;
  };
  /** Local RAG index (optional). */
  rag?: { db: Database.Database; path: string };
  host: string;
  port: number;
  /** Serve built SPA from `web/dist` (production). */
  withStatic: boolean;
  cwd?: string;
};

export function runServe(opts: RunServeOptions): { url: string; close: () => void } {
  const cwd = opts.cwd ?? process.cwd();
  const staticRoot = opts.withStatic ? resolveWebDist(cwd) : undefined;
  const schedulerRuntime = new SchedulerRuntime({
    db: opts.db,
    atuin: opts.atuin,
    registry: new ScheduledTaskRegistry(createDefaultScheduledTaskDefinitions()),
  });
  const schedulerLoop = new SchedulerLoop({ runtime: schedulerRuntime });
  const app = createApp({
    db: opts.db,
    mcpDb: opts.mcpDb,
    atuin: opts.atuin,
    dailySummary: opts.dailySummary,
    rag: opts.rag,
    schedulerRuntime,
    staticRoot,
  });
  schedulerLoop.start();
  const server = serve(
    {
      fetch: app.fetch,
      hostname: opts.host,
      port: opts.port,
    },
    (info) => {
      void info;
    }
  );
  const url = `http://${opts.host}:${opts.port}`;
  return {
    url,
    close: () => {
      schedulerLoop.stop();
      server.close();
      opts.mcpDb?.close();
    },
  };
}
