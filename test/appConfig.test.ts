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
  getScanMaxDocs,
  setScanMaxDocs,
  DEFAULT_SCAN_MAX_DOCS,
  getScanConcurrency,
  setScanConcurrency,
  DEFAULT_SCAN_CONCURRENCY,
  getReplayGapMinutes,
  setReplayGapMinutes,
  DEFAULT_REPLAY_GAP_MINUTES,
} from "../src/appConfig/index.js";
import { DEFAULT_GAP_THRESHOLD_MS } from "../src/replay/sessionize.js";

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

describe("getScanMaxDocs / setScanMaxDocs", () => {
  it("defaults to DEFAULT_SCAN_MAX_DOCS (100) when unset", () => {
    expect(getScanMaxDocs(db)).toBe(DEFAULT_SCAN_MAX_DOCS);
    expect(DEFAULT_SCAN_MAX_DOCS).toBe(100);
  });

  it("stores and reads back a valid cap", () => {
    expect(setScanMaxDocs(db, 250)).toBe(250);
    expect(getScanMaxDocs(db)).toBe(250);
  });

  it("rejects non-integers and out-of-range values (min 1)", () => {
    expect(() => setScanMaxDocs(db, 0)).toThrow();
    expect(() => setScanMaxDocs(db, 2.5)).toThrow();
    expect(() => setScanMaxDocs(db, 99999)).toThrow();
  });

  it("falls back to default on a corrupt / out-of-range stored value", () => {
    db.prepare("INSERT INTO app_config (key, value, updated_at) VALUES ('scan.maxDocsPerRepo', '0', 't')").run();
    expect(getScanMaxDocs(db)).toBe(DEFAULT_SCAN_MAX_DOCS);
  });
});

describe("getScanConcurrency / setScanConcurrency", () => {
  it("defaults to DEFAULT_SCAN_CONCURRENCY (16) when unset", () => {
    expect(getScanConcurrency(db)).toBe(DEFAULT_SCAN_CONCURRENCY);
    expect(DEFAULT_SCAN_CONCURRENCY).toBe(16);
  });

  it("stores and reads back a valid concurrency", () => {
    expect(setScanConcurrency(db, 8)).toBe(8);
    expect(getScanConcurrency(db)).toBe(8);
  });

  it("rejects non-integers and out-of-range values (min 1, max 64)", () => {
    expect(() => setScanConcurrency(db, 0)).toThrow();
    expect(() => setScanConcurrency(db, 2.5)).toThrow();
    expect(() => setScanConcurrency(db, 100)).toThrow();
  });

  it("falls back to default on a corrupt / out-of-range stored value", () => {
    db.prepare("INSERT INTO app_config (key, value, updated_at) VALUES ('scan.concurrency', '0', 't')").run();
    expect(getScanConcurrency(db)).toBe(DEFAULT_SCAN_CONCURRENCY);
  });
});

describe("getReplayGapMinutes / setReplayGapMinutes", () => {
  it("defaults to 120 minutes — the same 2h sessionize() has always used", () => {
    expect(getReplayGapMinutes(db)).toBe(DEFAULT_REPLAY_GAP_MINUTES);
    expect(DEFAULT_REPLAY_GAP_MINUTES).toBe(120);
  });

  it("默认值来自 sessionize 本身,不是另抄一份", () => {
    // 两处各写一个 120 迟早会漂:一处改了另一处不改,而症状是「设置页显示 120、
    // 实际按别的值切段」—— 没有任何东西会报错。所以这里断言它们同源。
    expect(DEFAULT_REPLAY_GAP_MINUTES * 60_000).toBe(DEFAULT_GAP_THRESHOLD_MS);
  });

  it("stores and reads back a valid gap", () => {
    expect(setReplayGapMinutes(db, 30)).toBe(30);
    expect(getReplayGapMinutes(db)).toBe(30);
  });

  it("rejects non-integers and out-of-range values (min 1, max 1440)", () => {
    expect(() => setReplayGapMinutes(db, 0)).toThrow();
    expect(() => setReplayGapMinutes(db, 2.5)).toThrow();
    expect(() => setReplayGapMinutes(db, 1441)).toThrow();
  });

  it("falls back to default on a corrupt / out-of-range stored value", () => {
    db.prepare("INSERT INTO app_config (key, value, updated_at) VALUES ('replay.gapMinutes', '0', 't')").run();
    expect(getReplayGapMinutes(db)).toBe(DEFAULT_REPLAY_GAP_MINUTES);
  });
});
