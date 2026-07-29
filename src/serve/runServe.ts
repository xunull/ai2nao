import { execFileSync } from "node:child_process";
import { serve } from "@hono/node-server";
import type Database from "better-sqlite3";
import { createApp, resolveWebDist } from "./app.js";
import { clearDaemonMeta, writeDaemonMeta, type DaemonMeta } from "./daemonMeta.js";
import { buildHealthSnapshot } from "./health.js";
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
};

/**
 * The server could not bind. Carries what a caller needs to say something useful
 * instead of dumping a stack trace: which port, and who is sitting on it.
 */
export class ServeListenError extends Error {
  readonly code: string;
  readonly host: string;
  readonly port: number;
  /** pid of the process holding the port, when we can find it. Best effort. */
  readonly ownerPid: number | null;

  constructor(args: { code: string; host: string; port: number; ownerPid: number | null; cause?: unknown }) {
    const owner = args.ownerPid === null ? "" : ` (held by pid ${args.ownerPid})`;
    super(
      args.code === "EADDRINUSE"
        ? `Port ${args.port} on ${args.host} is already in use${owner}.`
        : `Cannot listen on ${args.host}:${args.port} (${args.code}).`
    );
    this.name = "ServeListenError";
    this.code = args.code;
    this.host = args.host;
    this.port = args.port;
    this.ownerPid = args.ownerPid;
    if (args.cause !== undefined) this.cause = args.cause;
  }
}

/**
 * Who is listening on this port? Best effort, and deliberately so.
 *
 * `lsof` is present on macOS (which P6 makes the primary target) and on most
 * Linux installs, absent on some. There is no portable answer, and a missing pid
 * only costs us a slightly less specific error message — so every failure here
 * degrades to null rather than turning a port conflict into a crash.
 */
function findPortOwnerPid(port: number): number | null {
  try {
    const out = execFileSync("lsof", ["-ti", `tcp:${port}`, "-sTCP:LISTEN"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2_000,
    });
    const first = out.split("\n").map((s) => s.trim()).find((s) => s.length > 0);
    if (first === undefined) return null;
    const pid = Number.parseInt(first, 10);
    return Number.isFinite(pid) ? pid : null;
  } catch {
    return null;
  }
}

export type ServeHandle = {
  url: string;
  /** Stop the scheduler, withdraw the daemon record, close the socket. */
  close: () => Promise<void>;
};

/**
 * Start the HTTP server.
 *
 * ## Ordering is the whole point
 *
 *   1. bind the port      ← may fail; nothing has happened yet if it does
 *   2. publish the record ← now the port is genuinely ours to advertise
 *   3. start the scheduler← only now do we begin doing work
 *
 * This used to run 3 → 1, which meant a port conflict still fired a full round of
 * scheduled tasks (`SchedulerLoop.start()` calls `tick()` immediately) before the
 * process died on an uncaught EADDRINUSE. With a daemon record in the mix it would
 * also have left a note claiming a port it never held.
 *
 * Resolves once the socket is listening, so a caller that awaits it knows the
 * daemon is genuinely reachable. Rejects with `ServeListenError` otherwise.
 */
export async function runServe(opts: RunServeOptions): Promise<ServeHandle> {
  const staticRoot = opts.withStatic ? resolveWebDist() : undefined;
  const schedulerRuntime = new SchedulerRuntime({
    db: opts.db,
    atuin: opts.atuin,
    registry: new ScheduledTaskRegistry(createDefaultScheduledTaskDefinitions()),
  });
  const schedulerLoop = new SchedulerLoop({ runtime: schedulerRuntime });
  const health = buildHealthSnapshot({ db: opts.db, port: opts.port });
  const app = createApp({
    db: opts.db,
    mcpDb: opts.mcpDb,
    atuin: opts.atuin,
    dailySummary: opts.dailySummary,
    rag: opts.rag,
    schedulerRuntime,
    staticRoot,
    health,
  });

  // 1. Bind. Nothing observable has happened yet, so a failure here needs no
  //    cleanup beyond the handle we own.
  const server = await new Promise<ReturnType<typeof serve>>((resolveServer, reject) => {
    let settled = false;
    const s = serve({ fetch: app.fetch, hostname: opts.host, port: opts.port }, () => {
      if (settled) return;
      settled = true;
      resolveServer(s);
    });
    s.on("error", (e: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      const code = e.code ?? "EUNKNOWN";
      reject(
        new ServeListenError({
          code,
          host: opts.host,
          port: opts.port,
          ownerPid: code === "EADDRINUSE" ? findPortOwnerPid(opts.port) : null,
          cause: e,
        })
      );
    });
  }).catch((e: unknown) => {
    opts.mcpDb?.close();
    throw e;
  });

  // 2. Publish. Only now is the claim true.
  const meta: DaemonMeta = { ...health, host: opts.host };
  try {
    writeDaemonMeta(meta);
  } catch (e) {
    // A daemon that cannot advertise itself is still a usable daemon for anyone
    // who knows the port, so this is a warning rather than a failure — but the
    // shell will not find it, and the user deserves to know why.
    console.error(`warning: could not write daemon record: ${String(e)}`);
  }

  // 3. Work.
  schedulerLoop.start();

  let closed = false;
  return {
    url: `http://${opts.host}:${opts.port}`,
    close: async () => {
      if (closed) return;
      closed = true;
      schedulerLoop.stop();
      clearDaemonMeta(meta);
      opts.mcpDb?.close();
      await new Promise<void>((done) => server.close(() => done()));
    },
  };
}
