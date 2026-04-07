import { serve } from "@hono/node-server";
import type Database from "better-sqlite3";
import { createApp, resolveWebDist } from "./app.js";

export type RunServeOptions = {
  db: Database.Database;
  /** Optional Atuin history.db (read-only). */
  atuin?: { db: Database.Database; path: string };
  host: string;
  port: number;
  /** Serve built SPA from `web/dist` (production). */
  withStatic: boolean;
  cwd?: string;
};

export function runServe(opts: RunServeOptions): { url: string; close: () => void } {
  const cwd = opts.cwd ?? process.cwd();
  const staticRoot = opts.withStatic ? resolveWebDist(cwd) : undefined;
  const app = createApp({ db: opts.db, atuin: opts.atuin, staticRoot });
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
    close: () => server.close(),
  };
}
