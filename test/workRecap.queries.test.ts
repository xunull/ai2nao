import { describe, expect, it, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/store/open.js";
import type Database from "better-sqlite3";
import {
  cleanupRetention,
  countRecapRunsByWindow,
  getLatestRecapRunByWindow,
  insertRecapRun,
  listIndexedRepoPaths,
  listRecapRunsByWindow,
} from "../src/workRecap/queries.js";
import { computeFacts } from "../src/workRecap/facts.js";
import type { WorkRecapInference } from "../src/workRecap/types.js";

function freshDb(): Database.Database {
  const dir = mkdtempSync(join(tmpdir(), "ai2nao-recap-q-"));
  return openDatabase(join(dir, "test.db"));
}

const FACTS = computeFacts({
  commits: [],
  windowKey: "7d",
  windowStart: new Date("2026-06-01T00:00:00Z"),
  windowEnd: new Date("2026-06-08T00:00:00Z"),
  authorEmail: "me@example.com",
  reposScanned: 0,
  reposTotal: 0,
  scanTruncated: false,
  scanTruncatedReason: null,
  scanDiagnostics: [],
});

const INFERENCE_OK: WorkRecapInference = {
  summary: "summary",
  workMode: "build",
  workModeReason: "feat-heavy",
  nextUp: ["next"],
  fragmentation: "low",
  degraded: false,
  degradeReason: null,
};

describe("workRecap queries", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = freshDb();
  });

  it("inserts then reads back a recap run", () => {
    const run = insertRecapRun(db, {
      windowKey: "7d",
      generatedAt: new Date("2026-06-09T10:00:00Z"),
      model: "test-model",
      promptVersion: "work-recap@v1",
      facts: FACTS,
      inference: INFERENCE_OK,
    });
    expect(run.id).toBeGreaterThan(0);
    const latest = getLatestRecapRunByWindow(db, "7d");
    expect(latest?.id).toBe(run.id);
    expect(latest?.inference.workMode).toBe("build");
    expect(latest?.facts.windowKey).toBe("7d");
  });

  it("getLatestRecapRunByWindow returns the newest by generated_at", () => {
    const older = insertRecapRun(db, {
      windowKey: "7d",
      generatedAt: new Date("2026-06-01T10:00:00Z"),
      model: "m",
      promptVersion: "v1",
      facts: FACTS,
      inference: INFERENCE_OK,
    });
    const newer = insertRecapRun(db, {
      windowKey: "7d",
      generatedAt: new Date("2026-06-05T10:00:00Z"),
      model: "m",
      promptVersion: "v1",
      facts: FACTS,
      inference: INFERENCE_OK,
    });
    const latest = getLatestRecapRunByWindow(db, "7d");
    expect(latest?.id).toBe(newer.id);
    expect(latest?.id).not.toBe(older.id);
  });

  it("scopes latest by window", () => {
    insertRecapRun(db, {
      windowKey: "1d",
      generatedAt: new Date("2026-06-09T10:00:00Z"),
      model: "m",
      promptVersion: "v1",
      facts: FACTS,
      inference: INFERENCE_OK,
    });
    expect(getLatestRecapRunByWindow(db, "7d")).toBeNull();
    expect(getLatestRecapRunByWindow(db, "1d")).not.toBeNull();
  });

  it("listRecapRunsByWindow orders DESC and honors limit", () => {
    for (let i = 0; i < 5; i++) {
      insertRecapRun(db, {
        windowKey: "7d",
        generatedAt: new Date(`2026-06-${String(10 + i).padStart(2, "0")}T10:00:00Z`),
        model: "m",
        promptVersion: "v1",
        facts: FACTS,
        inference: INFERENCE_OK,
      });
    }
    const all = listRecapRunsByWindow(db, "7d");
    expect(all).toHaveLength(5);
    for (let i = 1; i < all.length; i++) {
      expect(all[i - 1].generatedAt.getTime()).toBeGreaterThanOrEqual(
        all[i].generatedAt.getTime()
      );
    }
    const trimmed = listRecapRunsByWindow(db, "7d", { limit: 2 });
    expect(trimmed).toHaveLength(2);
  });

  it("F6 T-B3: cleanupRetention deletes oldest above keep, leaves newest keep", () => {
    for (let i = 0; i < 8; i++) {
      insertRecapRun(db, {
        windowKey: "7d",
        generatedAt: new Date(`2026-06-${String(1 + i).padStart(2, "0")}T10:00:00Z`),
        model: "m",
        promptVersion: "v1",
        facts: FACTS,
        inference: INFERENCE_OK,
      });
    }
    expect(countRecapRunsByWindow(db, "7d")).toBe(8);
    const deleted = cleanupRetention(db, "7d", 3);
    expect(deleted).toBe(5);
    expect(countRecapRunsByWindow(db, "7d")).toBe(3);
    const remaining = listRecapRunsByWindow(db, "7d");
    // Remaining are the 3 newest: 2026-06-08 / 07 / 06
    const remainingDates = remaining.map((r) => r.generatedAt.toISOString());
    expect(remainingDates).toEqual([
      "2026-06-08T10:00:00.000Z",
      "2026-06-07T10:00:00.000Z",
      "2026-06-06T10:00:00.000Z",
    ]);
  });

  it("cleanupRetention does not touch other windows", () => {
    insertRecapRun(db, {
      windowKey: "1d",
      generatedAt: new Date("2026-06-01T10:00:00Z"),
      model: "m",
      promptVersion: "v1",
      facts: FACTS,
      inference: INFERENCE_OK,
    });
    insertRecapRun(db, {
      windowKey: "7d",
      generatedAt: new Date("2026-06-02T10:00:00Z"),
      model: "m",
      promptVersion: "v1",
      facts: FACTS,
      inference: INFERENCE_OK,
    });
    insertRecapRun(db, {
      windowKey: "7d",
      generatedAt: new Date("2026-06-03T10:00:00Z"),
      model: "m",
      promptVersion: "v1",
      facts: FACTS,
      inference: INFERENCE_OK,
    });
    cleanupRetention(db, "7d", 1);
    expect(countRecapRunsByWindow(db, "1d")).toBe(1);
    expect(countRecapRunsByWindow(db, "7d")).toBe(1);
  });

  it("listIndexedRepoPaths reads from repos table", () => {
    db.prepare(
      `INSERT INTO repos (path_canonical, origin_url, first_seen_at, last_scanned_at)
       VALUES (?, ?, ?, ?)`
    ).run("/path/a", null, "2026-06-01T00:00:00Z", null);
    db.prepare(
      `INSERT INTO repos (path_canonical, origin_url, first_seen_at, last_scanned_at)
       VALUES (?, ?, ?, ?)`
    ).run("/path/b", null, "2026-06-02T00:00:00Z", null);
    const paths = listIndexedRepoPaths(db);
    expect(paths).toEqual(["/path/a", "/path/b"]);
  });
});
