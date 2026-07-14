import { chmodSync, existsSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../src/store/open.js";
import { isGroupOrOtherAccessible, secureFile } from "../src/util/filePerms.js";

function mode(path: string): string {
  return (statSync(path).mode & 0o777).toString(8);
}

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), "ai2nao-perms-"));
}

describe("P0: database files are owner-only", () => {
  it("a NEW database is 0600, and so are its -wal / -shm sidecars", () => {
    const dbPath = join(freshDir(), "index.db");
    const db = openDatabase(dbPath);
    try {
      // Force a write so the WAL sidecars definitely exist.
      db.prepare("CREATE TABLE IF NOT EXISTS _t (x INTEGER)").run();
      db.prepare("INSERT INTO _t (x) VALUES (1)").run();

      expect(mode(dbPath)).toBe("600");
      // Sidecars hold recently-written pages — a just-saved API key lives there
      // until checkpoint, so they matter as much as the main file.
      for (const side of [`${dbPath}-wal`, `${dbPath}-shm`]) {
        if (existsSync(side)) expect(mode(side)).toBe("600");
      }
    } finally {
      db.close();
    }
  });

  it("self-heals an EXISTING 0644 database (and its sidecars) on open", () => {
    const dbPath = join(freshDir(), "index.db");
    // First open creates it; then deliberately loosen everything, as a DB
    // created before this fix would be.
    const first = openDatabase(dbPath);
    first.prepare("CREATE TABLE IF NOT EXISTS _t (x INTEGER)").run();
    first.prepare("INSERT INTO _t (x) VALUES (1)").run();
    first.close();

    chmodSync(dbPath, 0o644);
    for (const side of [`${dbPath}-wal`, `${dbPath}-shm`]) {
      if (existsSync(side)) chmodSync(side, 0o644);
    }
    expect(isGroupOrOtherAccessible(dbPath)).toBe(true);

    const second = openDatabase(dbPath);
    try {
      expect(mode(dbPath)).toBe("600");
      for (const side of [`${dbPath}-wal`, `${dbPath}-shm`]) {
        if (existsSync(side)) expect(mode(side)).toBe("600");
      }
    } finally {
      second.close();
    }
  });

  it("sets busy_timeout so a competing writer waits instead of throwing SQLITE_BUSY", () => {
    const dbPath = join(freshDir(), "index.db");
    const db = openDatabase(dbPath);
    try {
      const [{ timeout }] = db.pragma("busy_timeout") as { timeout: number }[];
      expect(timeout).toBeGreaterThan(0);
    } finally {
      db.close();
    }
  });
});

describe("secureFile", () => {
  it("tightens a loose file and is idempotent; never throws on a missing path", () => {
    const dir = freshDir();
    const f = join(dir, "secret.json");
    writeFileSync(f, "{}");
    chmodSync(f, 0o644);

    expect(secureFile(f)).toBe(true);
    expect(mode(f)).toBe("600");
    expect(secureFile(f)).toBe(false); // already tight → no-op
    expect(secureFile(join(dir, "nope.json"))).toBe(false); // missing → no throw
  });
});
