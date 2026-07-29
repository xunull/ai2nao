import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probeDaemon, MIN_SUPPORTED_API_VERSION } from "../src/serve/probeDaemon.js";
import { API_VERSION } from "../src/serve/health.js";
import { SCHEMA_VERSION } from "../src/store/migrations.js";
import { listDaemonMeta, writeDaemonMeta, type DaemonMeta } from "../src/serve/daemonMeta.js";

/**
 * What a client learns when it goes looking for a daemon.
 *
 * The design note this file enforces: the answer is NOT a boolean. "Cannot use the
 * daemon" has at least six causes and they need different words on screen:
 *
 *   not-running      nothing there            → "start it"
 *   port-taken       someone else's server    → "pid N owns 8787"
 *   incompatible     ai2nao, wrong contract   → "upgrade one of them"
 *   schema-mismatch  mid-migration / mixed    → "wait, or upgrade"
 *   timeout          alive but wedged         → "it is stuck, not gone"
 *   attached         all good                 → connect
 *
 * Collapsing these into `false` produces the failure the desktop-shell design was
 * explicitly trying to avoid: telling a user "daemon not running, run ai2nao
 * serve" when a daemon IS running and something else is wrong.
 *
 * On versions: `version` differing is NORMAL — the shell ships from a .dmg and the
 * daemon from npm, so they upgrade independently. Only `apiVersion` (bumped when
 * the contract actually breaks) may reject a connection. A daemon too old to have
 * `/api/health` reads as apiVersion 0, which is how "old ai2nao" stays
 * distinguishable from "not ai2nao".
 */

const REAL_RUN_DIR = process.env.AI2NAO_RUN_DIR;

// gitleaks: 假路径。
const DB = "/w/x/.ai2nao/index.db";

function meta(overrides: Partial<DaemonMeta> = {}): DaemonMeta {
  return {
    host: "127.0.0.1",
    port: 8787,
    pid: 4242,
    version: "0.4.0",
    apiVersion: API_VERSION,
    schemaVersion: SCHEMA_VERSION,
    dbPath: DB,
    startedAt: "2026-07-29T00:00:00.000Z",
    ...overrides,
  };
}

/**
 * A fetch stand-in that behaves the way a real socket does, because the
 * distinctions under test live exactly in the difference between them:
 *
 *   no routes at all   → connection refused   (nothing is listening)
 *   routes, path unmapped → 404               (a server IS listening)
 *
 * An earlier version of this helper threw ECONNREFUSED for any unmapped path,
 * which quietly turned every "listening but wrong server" case into
 * "not-running" and made two real behaviours untestable.
 */
function fakeFetch(routes: Record<string, { status: number; body?: unknown }>) {
  const listening = Object.keys(routes).length > 0;
  return async (input: string | URL): Promise<Response> => {
    if (!listening) {
      const err = new Error("connect ECONNREFUSED") as NodeJS.ErrnoException;
      err.code = "ECONNREFUSED";
      throw err;
    }
    const path = new URL(String(input)).pathname;
    const hit = routes[path];
    if (hit === undefined) return new Response("Not Found", { status: 404 });
    return new Response(hit.body === undefined ? "" : JSON.stringify(hit.body), {
      status: hit.status,
      headers: { "content-type": "application/json" },
    });
  };
}

/** A server that accepts the connection and then never answers. Honours abort, as fetch does. */
function hangingFetch(): typeof fetch {
  return ((_input: string | URL, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      const onAbort = (): void => {
        const err = new Error("The operation was aborted.");
        err.name = "AbortError";
        reject(err);
      };
      if (signal?.aborted) return onAbort();
      signal?.addEventListener("abort", onAbort, { once: true });
    })) as typeof fetch;
}

const healthBody = (over: Record<string, unknown> = {}) => ({
  version: "0.4.0",
  apiVersion: API_VERSION,
  schemaVersion: SCHEMA_VERSION,
  pid: 4242,
  startedAt: "2026-07-29T00:00:00.000Z",
  port: 8787,
  dbPath: DB,
  ...over,
});

beforeEach(() => {
  process.env.AI2NAO_RUN_DIR = mkdtempSync(join(tmpdir(), "ai2nao-run-"));
});

afterEach(() => {
  if (REAL_RUN_DIR === undefined) delete process.env.AI2NAO_RUN_DIR;
  else process.env.AI2NAO_RUN_DIR = REAL_RUN_DIR;
});

describe("probeDaemon — the six answers", () => {
  it("attached: a healthy daemon on the expected contract", async () => {
    const result = await probeDaemon({
      port: 8787,
      fetchImpl: fakeFetch({ "/api/health": { status: 200, body: healthBody() } }),
    });
    expect(result.kind).toBe("attached");
    if (result.kind === "attached") {
      expect(result.health.pid).toBe(4242);
      expect(result.url).toBe("http://127.0.0.1:8787");
    }
  });

  it("not-running: nothing is listening", async () => {
    const result = await probeDaemon({ port: 8787, fetchImpl: fakeFetch({}) });
    expect(result.kind).toBe("not-running");
  });

  it("port-taken: something is listening but it is not ai2nao at all", async () => {
    // No /api/health AND no /api/status — a stray dev server, say.
    const result = await probeDaemon({
      port: 8787,
      fetchImpl: fakeFetch({ "/": { status: 200, body: { hello: "world" } } }),
    });
    expect(result.kind).toBe("port-taken");
    if (result.kind === "port-taken") expect(result.port).toBe(8787);
  });

  it("incompatible: an ai2nao old enough to have no /api/health reads as apiVersion 0", async () => {
    // The tell is /api/status answering with the index-status shape. Without this
    // branch every pre-health ai2nao would be misreported as a foreign process.
    const result = await probeDaemon({
      port: 8787,
      fetchImpl: fakeFetch({
        "/api/status": { status: 200, body: { repos: 3, manifests: 9, lastJob: null } },
      }),
    });
    expect(result.kind).toBe("incompatible");
    if (result.kind === "incompatible") {
      expect(result.theirs).toBe(0);
      expect(result.ours).toBe(API_VERSION);
    }
  });

  it("incompatible: a daemon NEWER than us — apiVersion only moves on a real break", async () => {
    const result = await probeDaemon({
      port: 8787,
      fetchImpl: fakeFetch({
        "/api/health": { status: 200, body: healthBody({ apiVersion: API_VERSION + 1 }) },
      }),
    });
    expect(result.kind).toBe("incompatible");
  });

  it("attaches anyway when only the release version differs — that is the normal case", async () => {
    const result = await probeDaemon({
      port: 8787,
      fetchImpl: fakeFetch({
        "/api/health": { status: 200, body: healthBody({ version: "99.0.0" }) },
      }),
    });
    expect(result.kind).toBe("attached");
  });

  it("schema-mismatch: same contract, different database schema", async () => {
    const result = await probeDaemon({
      port: 8787,
      fetchImpl: fakeFetch({
        "/api/health": { status: 200, body: healthBody({ schemaVersion: SCHEMA_VERSION + 1 }) },
      }),
    });
    expect(result.kind).toBe("schema-mismatch");
    if (result.kind === "schema-mismatch") {
      expect(result.theirs).toBe(SCHEMA_VERSION + 1);
      expect(result.ours).toBe(SCHEMA_VERSION);
    }
  });

  it("timeout: listening but not answering — 'stuck', not 'gone'", async () => {
    const result = await probeDaemon({ port: 8787, timeoutMs: 20, fetchImpl: hangingFetch() });
    expect(result.kind).toBe("timeout");
  });

  it("garbage at /api/health is port-taken, not attached", async () => {
    const result = await probeDaemon({
      port: 8787,
      fetchImpl: fakeFetch({ "/api/health": { status: 200, body: { not: "a health payload" } } }),
    });
    expect(result.kind).toBe("port-taken");
  });

  it("MIN_SUPPORTED_API_VERSION is what rejects the old ones", () => {
    expect(MIN_SUPPORTED_API_VERSION).toBeLessThanOrEqual(API_VERSION);
    expect(MIN_SUPPORTED_API_VERSION).toBeGreaterThan(0);
  });
});

describe("probeDaemon — the daemon record is a hint, never the answer", () => {
  it("uses a recorded port as the candidate when none is given", async () => {
    writeDaemonMeta(meta({ port: 9911 }));
    const result = await probeDaemon({
      fetchImpl: fakeFetch({ "/api/health": { status: 200, body: healthBody({ port: 9911 }) } }),
    });
    expect(result.kind).toBe("attached");
    if (result.kind === "attached") expect(result.url).toContain("9911");
  });

  it("a record left behind by kill -9 does not fool it, and gets cleaned up", async () => {
    // The whole reason the record cannot be trusted: nothing removes it when the
    // process dies hard. If a client believed it, it would report a live daemon
    // that is not there.
    writeDaemonMeta(meta({ port: 9911 }));
    expect(listDaemonMeta()).toHaveLength(1);

    const result = await probeDaemon({ fetchImpl: fakeFetch({}) });

    expect(result.kind).toBe("not-running");
    expect(listDaemonMeta()).toEqual([]);
  });

  it("falls back to 8787 when there is no record at all", async () => {
    const result = await probeDaemon({
      fetchImpl: fakeFetch({ "/api/health": { status: 200, body: healthBody() } }),
    });
    expect(result.kind).toBe("attached");
    if (result.kind === "attached") expect(result.url).toContain("8787");
  });
});
