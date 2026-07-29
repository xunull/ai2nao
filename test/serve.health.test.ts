import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { openDatabase } from "../src/store/open.js";
import { createApp } from "../src/serve/app.js";
import { API_VERSION, buildHealthSnapshot } from "../src/serve/health.js";
import { packageVersion } from "../src/path/packageRoot.js";
import { SCHEMA_VERSION } from "../src/store/migrations.js";

/**
 * `/api/health` exists for one reason: the desktop shell needs to answer "is the
 * daemon alive?" in milliseconds, at exactly the moments the database is busiest.
 *
 * That rules out reusing `/api/status` (app.ts) — it runs COUNT queries, and
 * `src/store/open.ts` sets `busy_timeout = 5_000`, so under a writer any
 * DB-touching request blocks for five seconds and then throws SQLITE_BUSY. A big
 * sync or a schema migration is precisely when the shell most needs an answer, so
 * a probe that stalls there is worse than useless — it reports "daemon down" for a
 * daemon that is working fine.
 *
 * The contract this suite pins down: everything /api/health returns is captured
 * ONCE at startup, and serving the route never touches the database again. The
 * "closed database" test is the teeth — if anyone reintroduces a query in the
 * request path, it fails immediately instead of years later under load.
 */

function freshDb(): Database.Database {
  const dir = mkdtempSync(join(tmpdir(), "ai2nao-health-"));
  return openDatabase(join(dir, "test.db"));
}

describe("/api/health — the liveness contract", () => {
  it("reports version, apiVersion, schemaVersion, pid, port and dbPath", async () => {
    const db = freshDb();
    const app = createApp({ db, health: buildHealthSnapshot({ db, port: 8787 }) });

    const res = await app.fetch(new Request("http://127.0.0.1/api/health"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;

    expect(body.version).toBe(packageVersion());
    expect(body.apiVersion).toBe(API_VERSION);
    expect(body.schemaVersion).toBe(SCHEMA_VERSION);
    expect(body.pid).toBe(process.pid);
    expect(body.port).toBe(8787);
    expect(body.dbPath).toBe(db.name);
    expect(typeof body.startedAt).toBe("string");
    expect(Number.isNaN(Date.parse(body.startedAt as string))).toBe(false);
  });

  it("keeps answering after the database handle is closed — it must not query", async () => {
    const db = freshDb();
    const app = createApp({ db, health: buildHealthSnapshot({ db, port: 8787 }) });

    // A closed handle throws on any prepare()/pragma(). If the route touches the
    // DB at request time this blows up; if it serves the startup snapshot it does
    // not care. This stands in for "the DB is locked by a writer", which is the
    // real-world case we cannot reproduce quickly (busy_timeout is 5s).
    db.close();

    const res = await app.fetch(new Request("http://127.0.0.1/api/health"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.schemaVersion).toBe(SCHEMA_VERSION);

    // Control: the index-status route DOES need the DB, so it must fail here.
    // If this ever starts passing, the two routes have blurred together.
    expect((await app.fetch(new Request("http://127.0.0.1/api/status"))).status).toBe(500);
  });

  it("is absent when no snapshot is supplied — that is how a shell detects an old daemon", async () => {
    // ~30 existing test callers build apps without health, and so does every
    // ai2nao released before this change. The shell reads a 404 here as
    // "apiVersion 0", not as "some foreign process owns the port".
    const app = createApp({ db: freshDb() });
    expect((await app.fetch(new Request("http://127.0.0.1/api/health"))).status).toBe(404);
  });

  it("snapshot is frozen at build time — schemaVersion is read once, not per request", async () => {
    const db = freshDb();
    const snapshot = buildHealthSnapshot({ db, port: 9000 });
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(snapshot.schemaVersion).toBe(SCHEMA_VERSION);
  });
});
