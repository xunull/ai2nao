import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearDaemonMeta,
  daemonMetaPath,
  daemonRunDir,
  listDaemonMeta,
  readDaemonMeta,
  writeDaemonMeta,
  type DaemonMeta,
} from "../src/serve/daemonMeta.js";

/**
 * How a client finds a running daemon without hardcoding 8787.
 *
 * The trap this suite exists to prevent: `serve` accepts `--db` and `--port`
 * (src/cli.ts), so two daemons over two different databases is a supported,
 * ordinary thing to do. A single fixed `~/.ai2nao/daemon.json` would make them
 * fight — the second to start silently overwrites the first's record, and then
 * whichever exits first deletes the survivor's. A client would be told to connect
 * to a port nobody is listening on.
 *
 * So: one file per (dbPath, port), atomic writes, and a process only ever removes
 * a record that names its own pid.
 *
 * These files are runtime state, not configuration. They live in a `run/`
 * subdirectory precisely so nobody confuses them with config.json / notify.json /
 * rag.json, which are hand-edited and worth backing up.
 */

const REAL_ENV = process.env.AI2NAO_RUN_DIR;

// gitleaks: 全部假路径。
const DB_A = "/w/x/.ai2nao/index.db";
const DB_B = "/w/x/other/index.db";

function meta(overrides: Partial<DaemonMeta> = {}): DaemonMeta {
  return {
    host: "127.0.0.1",
    port: 8787,
    pid: process.pid,
    version: "0.4.0",
    apiVersion: 1,
    schemaVersion: 50,
    dbPath: DB_A,
    startedAt: "2026-07-29T00:00:00.000Z",
    ...overrides,
  };
}

beforeEach(() => {
  process.env.AI2NAO_RUN_DIR = mkdtempSync(join(tmpdir(), "ai2nao-run-"));
});

afterEach(() => {
  if (REAL_ENV === undefined) delete process.env.AI2NAO_RUN_DIR;
  else process.env.AI2NAO_RUN_DIR = REAL_ENV;
});

describe("daemonMetaPath — one record per (dbPath, port)", () => {
  it("same db + same port → same path", () => {
    expect(daemonMetaPath(DB_A, 8787)).toBe(daemonMetaPath(DB_A, 8787));
  });

  it("different port → different path", () => {
    expect(daemonMetaPath(DB_A, 8787)).not.toBe(daemonMetaPath(DB_A, 8788));
  });

  it("different database on the same port → different path", () => {
    // The case a single fixed daemon.json gets wrong.
    expect(daemonMetaPath(DB_A, 8787)).not.toBe(daemonMetaPath(DB_B, 8787));
  });

  it("lands inside the run/ directory, keeping runtime state out of the config dir", () => {
    expect(daemonMetaPath(DB_A, 8787).startsWith(daemonRunDir())).toBe(true);
  });

  it("the port is visible in the filename — these get read by humans debugging", () => {
    expect(daemonMetaPath(DB_A, 8787)).toContain("8787");
  });
});

describe("writeDaemonMeta / readDaemonMeta", () => {
  it("round-trips every field", () => {
    const m = meta();
    const path = writeDaemonMeta(m);
    expect(readDaemonMeta(path)).toEqual(m);
  });

  it("creates run/ on demand and writes 0600 — pid and db path are not public", () => {
    const path = writeDaemonMeta(meta());
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("overwrites its own record on restart without leaving a second file", () => {
    writeDaemonMeta(meta({ pid: 111 }));
    writeDaemonMeta(meta({ pid: 222 }));
    expect(listDaemonMeta()).toHaveLength(1);
    expect(listDaemonMeta()[0]?.pid).toBe(222);
  });

  it("two instances over different databases coexist", () => {
    writeDaemonMeta(meta({ dbPath: DB_A, port: 8787, pid: 111 }));
    writeDaemonMeta(meta({ dbPath: DB_B, port: 8788, pid: 222 }));
    const all = listDaemonMeta();
    expect(all).toHaveLength(2);
    expect(all.map((m) => m.pid).sort()).toEqual([111, 222]);
  });

  it("returns null for a malformed record rather than throwing", () => {
    const path = daemonMetaPath(DB_A, 8787);
    writeDaemonMeta(meta()); // creates run/
    writeFileSync(path, "{ not json at all");
    expect(readDaemonMeta(path)).toBeNull();
  });

  it("returns null when the shape is wrong, even if the JSON parses", () => {
    const path = daemonMetaPath(DB_A, 8787);
    writeDaemonMeta(meta());
    writeFileSync(path, JSON.stringify({ port: "8787", pid: "nope" }));
    expect(readDaemonMeta(path)).toBeNull();
  });

  it("listDaemonMeta skips unreadable records instead of failing the whole scan", () => {
    writeDaemonMeta(meta({ dbPath: DB_A, port: 8787, pid: 111 }));
    writeFileSync(join(daemonRunDir(), "daemon-9999-garbage.json"), "}{");
    const all = listDaemonMeta();
    expect(all).toHaveLength(1);
    expect(all[0]?.pid).toBe(111);
  });

  it("listDaemonMeta on a machine that never ran a daemon returns []", () => {
    expect(listDaemonMeta()).toEqual([]);
  });
});

describe("clearDaemonMeta — only ever removes your own record", () => {
  it("removes the record when the pid matches", () => {
    const m = meta({ pid: process.pid });
    writeDaemonMeta(m);
    expect(clearDaemonMeta(m)).toBe(true);
    expect(listDaemonMeta()).toEqual([]);
  });

  it("refuses to remove a record owned by another pid", () => {
    // The exact bug a shared daemon.json produces: instance A exits and takes
    // instance B's record with it.
    writeDaemonMeta(meta({ pid: 4242 }));
    expect(clearDaemonMeta(meta({ pid: 9999 }))).toBe(false);
    expect(listDaemonMeta()).toHaveLength(1);
    expect(listDaemonMeta()[0]?.pid).toBe(4242);
  });

  it("is a no-op when there is nothing to clear", () => {
    expect(clearDaemonMeta(meta())).toBe(false);
  });

  it("clears a corrupt record it would otherwise be stuck on", () => {
    const m = meta();
    writeDaemonMeta(m);
    writeFileSync(daemonMetaPath(m.dbPath, m.port), "{{{");
    // Unreadable means we cannot prove someone else owns it, and a corrupt file
    // helps nobody — it must not become a permanently unclearable record.
    expect(clearDaemonMeta(m)).toBe(true);
    expect(listDaemonMeta()).toEqual([]);
  });
});

describe("atomicity", () => {
  it("never leaves a partially written record behind", () => {
    // Write a large-ish record and confirm what lands on disk is complete JSON.
    // The implementation writes to a temp file in the same directory and renames,
    // so a reader can only ever observe the old file or the new one.
    const m = meta({ dbPath: `${DB_A}${"x".repeat(2000)}` });
    const path = writeDaemonMeta(m);
    const raw = readFileSync(path, "utf8");
    expect(() => JSON.parse(raw) as unknown).not.toThrow();
    expect(readDaemonMeta(path)?.dbPath).toBe(m.dbPath);
  });
});
