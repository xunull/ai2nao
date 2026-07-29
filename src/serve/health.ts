import type Database from "better-sqlite3";
import type { Hono } from "hono";
import { packageVersion } from "../path/packageRoot.js";
import { SCHEMA_VERSION } from "../store/migrations.js";

/**
 * Liveness contract between a running ai2nao daemon and anything that wants to
 * attach to it (today: the desktop shell; tomorrow: whatever else).
 *
 * Why this is not `/api/status`: that route runs COUNT queries, and
 * `src/store/open.ts` sets `busy_timeout = 5_000`. Under a writer — a big sync, a
 * schema migration — any DB-touching request stalls five seconds and then throws
 * SQLITE_BUSY. Those are exactly the moments a probe must answer instantly, so
 * everything here is captured ONCE at startup and the request path never touches
 * the database.
 *
 *   /api/status   index state   queries the DB   "what is in there?"
 *   /api/health   process state never queries    "are you alive, and can I talk to you?"
 */

/**
 * Version of the HTTP contract a client depends on. Bump ONLY when an interface a
 * client relies on actually breaks — not on every release.
 *
 * This exists because the release version cannot answer the question. The shell
 * (installed from a .dmg) and the daemon (installed from npm) upgrade
 * independently, so their versions differing is the NORMAL case, not an error.
 * Rejecting a connection on `version !== version` would be a self-inflicted
 * outage. `apiVersion` changes on the order of months and means something.
 *
 * A daemon with no `/api/health` at all (anything released before this) is read
 * as apiVersion 0 by `probeDaemon`, which falls out of the supported range and is
 * reported as `incompatible` rather than mistaken for a foreign process.
 */
export const API_VERSION = 1;

export type HealthSnapshot = {
  /** Release version from package.json. Display and diagnostics only. */
  version: string;
  /** See API_VERSION. This is what compatibility decisions are made on. */
  apiVersion: number;
  /** `meta_schema.version` at startup, i.e. right after migrate() finished. */
  schemaVersion: number;
  pid: number;
  /** ISO 8601, captured when the snapshot was built. */
  startedAt: string;
  port: number;
  /** Path string only — never opened by this module. */
  dbPath: string;
};

/**
 * Read everything the health route will ever need, once.
 *
 * Call this at startup, after `openDatabase()` (which runs the migrations) and
 * before the server starts listening. The returned object is frozen so a later
 * "just refresh it from the DB" edit has to be deliberate rather than accidental.
 */
export function buildHealthSnapshot(args: {
  db: Database.Database;
  port: number;
  /** Override for tests; defaults to now. */
  startedAt?: string;
}): HealthSnapshot {
  const row = args.db
    .prepare("SELECT version FROM meta_schema WHERE id = 1")
    .get() as { version: number } | undefined;
  if (row === undefined) {
    // openDatabase() always migrates, so a missing row means the handle is not an
    // ai2nao database. Failing loudly at startup beats serving a health payload
    // that claims schemaVersion 0.
    throw new Error(
      `Cannot build health snapshot: ${args.db.name} has no meta_schema row. Is this an ai2nao database?`
    );
  }
  return Object.freeze({
    version: packageVersion(),
    apiVersion: API_VERSION,
    schemaVersion: row.version,
    pid: process.pid,
    startedAt: args.startedAt ?? new Date().toISOString(),
    port: args.port,
    dbPath: args.db.name,
  });
}

/** What this build of ai2nao expects the schema to be. */
export function expectedSchemaVersion(): number {
  return SCHEMA_VERSION;
}

/** Mount `GET /api/health`. Serves the frozen snapshot; touches nothing. */
export function registerHealthRoute(app: Hono, snapshot: HealthSnapshot): void {
  app.get("/api/health", (c) => c.json(snapshot));
}
