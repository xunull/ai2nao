import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type Database from "better-sqlite3";
import { openDatabase } from "../src/store/open.js";
import { setScanRoots } from "../src/appConfig/index.js";
import { resolveScanRoots } from "../src/scan/roots.js";

let base: string;
let db: Database.Database;

function storeRaw(roots: string[]) {
  // Bypass setScanRoots' validation to store roots that are invalid at read time.
  db.prepare(
    "INSERT INTO app_config (key, value, updated_at) VALUES ('scan.roots', ?, 't') ON CONFLICT(key) DO UPDATE SET value=excluded.value"
  ).run(JSON.stringify(roots));
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "ai2nao-rr-"));
  db = openDatabase(join(base, "idx.db"));
});
afterEach(() => {
  db.close();
  rmSync(base, { recursive: true, force: true });
});

describe("resolveScanRoots", () => {
  it("reports unconfigured when nothing is stored", () => {
    const r = resolveScanRoots(db);
    expect(r.state).toBe("unconfigured");
    expect(r.configured).toEqual([]);
    expect(r.valid).toEqual([]);
    expect(r.skipped).toEqual([]);
  });

  it("returns all existing directories as valid", () => {
    const a = join(base, "a");
    const b = join(base, "b");
    mkdirSync(a);
    mkdirSync(b);
    const stored = setScanRoots(db, [a, b]); // canonical
    const r = resolveScanRoots(db);
    expect(r.state).toBe("resolved");
    expect(r.valid.sort()).toEqual(stored.sort());
    expect(r.skipped).toEqual([]);
  });

  it("skips a stored root that was deleted (reason: missing)", () => {
    const d = join(base, "gone");
    mkdirSync(d);
    setScanRoots(db, [d]);
    rmSync(d, { recursive: true, force: true }); // deleted after being stored

    const r = resolveScanRoots(db);
    expect(r.state).toBe("resolved");
    expect(r.valid).toEqual([]);
    expect(r.skipped).toHaveLength(1);
    expect(r.skipped[0].reason).toBe("missing");
  });

  it("skips a path that is a file, not a directory (reason: not-a-directory)", () => {
    const f = join(base, "file.txt");
    writeFileSync(f, "x");
    storeRaw([f]); // can't go through setScanRoots (it rejects non-dirs)

    const r = resolveScanRoots(db);
    expect(r.valid).toEqual([]);
    expect(r.skipped).toHaveLength(1);
    expect(r.skipped[0].reason).toBe("not-a-directory");
  });

  it("partitions a mix of valid and missing roots", () => {
    const good = join(base, "good");
    const bad = join(base, "bad");
    mkdirSync(good);
    storeRaw([good, bad]);

    const r = resolveScanRoots(db);
    expect(r.valid).toEqual([good]);
    expect(r.skipped.map((s) => s.path)).toEqual([bad]);
  });
});
