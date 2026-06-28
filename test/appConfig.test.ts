import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type Database from "better-sqlite3";
import { openDatabase } from "../src/store/open.js";
import {
  getScanRoots,
  setScanRoots,
  getScanMaxDepth,
  setScanMaxDepth,
  DEFAULT_SCAN_MAX_DEPTH,
} from "../src/appConfig/index.js";

let base: string;
let db: Database.Database;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "ai2nao-cfg-"));
  db = openDatabase(join(base, "idx.db"));
});
afterEach(() => {
  db.close();
  rmSync(base, { recursive: true, force: true });
});

function dir(name: string): string {
  const p = join(base, name);
  mkdirSync(p, { recursive: true });
  return p;
}

describe("getScanRoots / setScanRoots", () => {
  it("returns [] on a fresh db", () => {
    expect(getScanRoots(db)).toEqual([]);
  });

  it("stores valid existing directories (canonicalized) and reads them back", () => {
    const a = dir("a");
    const b = dir("b");
    const stored = setScanRoots(db, [a, b]);
    expect(stored).toHaveLength(2);
    expect(getScanRoots(db).sort()).toEqual(stored.sort());
  });

  it("dedupes the same directory", () => {
    const a = dir("a");
    expect(setScanRoots(db, [a, a])).toHaveLength(1);
  });

  it("rejects a relative path", () => {
    expect(() => setScanRoots(db, ["relative/dir"])).toThrow();
  });

  it("rejects a non-existent path", () => {
    expect(() => setScanRoots(db, [join(base, "nope")])).toThrow();
  });

  it("rejects a file (not a directory)", () => {
    const f = join(base, "file.txt");
    writeFileSync(f, "x");
    expect(() => setScanRoots(db, [f])).toThrow();
  });

  it("rejects an over-long path", () => {
    expect(() => setScanRoots(db, ["/" + "x".repeat(5000)])).toThrow();
  });

  it("rejects too many roots", () => {
    const many = Array.from({ length: 101 }, (_, i) => dir(`d${i}`));
    expect(() => setScanRoots(db, many)).toThrow();
  });

  it("empty array deletes the key (semantics: unconfigured)", () => {
    setScanRoots(db, [dir("a")]);
    expect(setScanRoots(db, [])).toEqual([]);
    expect(getScanRoots(db)).toEqual([]);
    const row = db.prepare("SELECT COUNT(*) n FROM app_config WHERE key='scan.roots'").get() as { n: number };
    expect(row.n).toBe(0);
  });

  it("returns [] when the stored value is the wrong shape (corruption-tolerant)", () => {
    // valid JSON but not a string[] — getScanRoots must not leak it into logic
    db.prepare("INSERT INTO app_config (key, value, updated_at) VALUES ('scan.roots', ?, 't')").run('"oops"');
    expect(getScanRoots(db)).toEqual([]);
  });
});

describe("getScanMaxDepth / setScanMaxDepth", () => {
  it("defaults to DEFAULT_SCAN_MAX_DEPTH when unset", () => {
    expect(getScanMaxDepth(db)).toBe(DEFAULT_SCAN_MAX_DEPTH);
  });

  it("stores and reads back a valid depth", () => {
    expect(setScanMaxDepth(db, 4)).toBe(4);
    expect(getScanMaxDepth(db)).toBe(4);
    expect(setScanMaxDepth(db, 0)).toBe(0); // 0 is valid (root only)
    expect(getScanMaxDepth(db)).toBe(0);
  });

  it("rejects non-integers and out-of-range values", () => {
    expect(() => setScanMaxDepth(db, 2.5)).toThrow();
    expect(() => setScanMaxDepth(db, -1)).toThrow();
    expect(() => setScanMaxDepth(db, 999)).toThrow();
  });

  it("falls back to default on a corrupt / out-of-range stored value", () => {
    db.prepare("INSERT INTO app_config (key, value, updated_at) VALUES ('scan.maxDepth', '999', 't')").run();
    expect(getScanMaxDepth(db)).toBe(DEFAULT_SCAN_MAX_DEPTH);
  });
});
