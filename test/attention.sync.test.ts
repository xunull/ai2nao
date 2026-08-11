import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import DatabaseCtor from "better-sqlite3";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { syncAttention } from "../src/attention/sync.js";
import { unixMsToAppleSeconds } from "../src/attention/time.js";
import { migrate } from "../src/store/migrations.js";

let dir: string;
let db: Database.Database;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ai2nao-attn-sync-"));
  db = new DatabaseCtor(":memory:");
  migrate(db);
});

afterEach(() => {
  db?.close();
  rmSync(dir, { recursive: true, force: true });
});

type Row = {
  pk?: number;
  bundle?: string;
  startMs: number;
  endMs: number;
  stream?: string;
};

/** Build a knowledgeC-shaped source database in a temp dir. */
function makeSource(name: string, rows: Row[]): string {
  const path = join(dir, name);
  const src = new DatabaseCtor(path);
  src.exec(`
    CREATE TABLE ZOBJECT (
      Z_PK            INTEGER PRIMARY KEY,
      ZSTREAMNAME     TEXT,
      ZVALUESTRING    TEXT,
      ZSTARTDATE      REAL,
      ZENDDATE        REAL,
      ZSECONDSFROMGMT INTEGER
    );
  `);
  const ins = src.prepare(
    `INSERT INTO ZOBJECT (Z_PK, ZSTREAMNAME, ZVALUESTRING, ZSTARTDATE, ZENDDATE, ZSECONDSFROMGMT)
     VALUES (?, ?, ?, ?, ?, 28800)`
  );
  rows.forEach((r, i) => {
    ins.run(
      r.pk ?? i + 1,
      r.stream ?? "/app/usage",
      r.bundle ?? `com.example.app-${i + 1}`,
      unixMsToAppleSeconds(r.startMs),
      unixMsToAppleSeconds(r.endMs)
    );
  });
  src.close();
  return path;
}

const at = (d: number, h: number, mi = 0): number =>
  new Date(2026, 7, d, h, mi, 0, 0).getTime();

const spanCount = (): number =>
  (db.prepare("SELECT COUNT(*) AS n FROM attention_focus_spans").get() as {
    n: number;
  }).n;

const state = () =>
  db.prepare("SELECT * FROM attention_sync_state WHERE source = 'knowledgec'").get() as
    | Record<string, unknown>
    | undefined;

describe("syncAttention", () => {
  it("ingests rows and advances the watermark", () => {
    const p = makeSource("a.db", [
      { startMs: at(1, 9), endMs: at(1, 10) },
      { startMs: at(1, 10), endMs: at(1, 11) },
    ]);
    const r = syncAttention(db, { sourcePath: p });
    expect(r.status).toBe("ok");
    expect(r.spansInserted).toBe(2);
    expect(r.watermarkBefore).toBe(0);
    expect(r.watermarkAfter).toBe(2);
    expect(r.focusStream).toBe("/app/usage");
    expect(spanCount()).toBe(2);
  });

  it("is idempotent: a second run inserts nothing new", () => {
    const p = makeSource("b.db", [{ startMs: at(1, 9), endMs: at(1, 10) }]);
    syncAttention(db, { sourcePath: p });
    const second = syncAttention(db, { sourcePath: p });
    expect(second.spansInserted).toBe(0);
    expect(second.rowsRead).toBe(0); // watermark already past it
    expect(spanCount()).toBe(1);
  });

  it("picks up only rows above the watermark on the next run", () => {
    const p = makeSource("c.db", [{ pk: 1, startMs: at(1, 9), endMs: at(1, 10) }]);
    syncAttention(db, { sourcePath: p });

    const src = new DatabaseCtor(p);
    src
      .prepare(
        `INSERT INTO ZOBJECT (Z_PK, ZSTREAMNAME, ZVALUESTRING, ZSTARTDATE, ZENDDATE, ZSECONDSFROMGMT)
         VALUES (2, '/app/usage', 'com.example.new', ?, ?, 28800)`
      )
      .run(unixMsToAppleSeconds(at(1, 11)), unixMsToAppleSeconds(at(1, 12)));
    src.close();

    const r = syncAttention(db, { sourcePath: p });
    expect(r.rowsRead).toBe(1);
    expect(r.spansInserted).toBe(1);
    expect(r.watermarkAfter).toBe(2);
  });

  it("records a baseline when the source has no usable rows at all", () => {
    // The bug this guards: leaving the watermark null on an empty first poll
    // means the *next* run is still treated as a first run, and the first real
    // batch gets swallowed as history. Prior incident: desktopShell notify
    // rules, 2026-07-29. Unauthorized is the default state here, so an empty
    // first look is the normal path, not an edge case.
    const p = makeSource("empty.db", []);
    const r = syncAttention(db, { sourcePath: p });
    expect(r.status).toBe("ok");
    expect(r.ok).toBe(true);
    const s = state();
    expect(s).toBeDefined();
    expect(s!.watermark_row_id).toBe(0);
    expect(s!.focus_stream).toBeNull();
    expect(s!.last_success_at).toBeTruthy();
  });

  it("does not swallow the first real batch after an empty poll", () => {
    const p = makeSource("late.db", []);
    syncAttention(db, { sourcePath: p });

    const src = new DatabaseCtor(p);
    src
      .prepare(
        `INSERT INTO ZOBJECT (Z_PK, ZSTREAMNAME, ZVALUESTRING, ZSTARTDATE, ZENDDATE, ZSECONDSFROMGMT)
         VALUES (1, '/app/usage', 'com.example.first', ?, ?, 28800)`
      )
      .run(unixMsToAppleSeconds(at(1, 9)), unixMsToAppleSeconds(at(1, 10)));
    src.close();

    const r = syncAttention(db, { sourcePath: p });
    expect(r.spansInserted).toBe(1);
    expect(spanCount()).toBe(1);
  });

  it("detects a source reset and reingests from zero", () => {
    const p = makeSource("d.db", [
      { pk: 10, startMs: at(1, 9), endMs: at(1, 10) },
      { pk: 11, startMs: at(1, 10), endMs: at(1, 11) },
    ]);
    const first = syncAttention(db, { sourcePath: p });
    expect(first.watermarkAfter).toBe(11);
    expect(first.reset).toBe(false);

    // Rebuild the source with row ids restarting from 1: this is what a
    // Screen Time reset or an OS upgrade looks like. Without instance
    // detection the watermark sits at 11 forever and nothing is ever read again
    // — silently, with no error.
    rmSync(p, { force: true });
    makeSource("d.db", [{ pk: 1, startMs: at(2, 9), endMs: at(2, 10) }]);

    const second = syncAttention(db, { sourcePath: p });
    expect(second.reset).toBe(true);
    expect(second.rowsRead).toBe(1);
    expect(second.spansInserted).toBe(1);
  });

  it("rejects rows whose timestamps decode outside a plausible window", () => {
    // knowledgeC carries rows that decode to the year 0000.
    const p = makeSource("dirty.db", [
      { pk: 1, startMs: at(1, 9), endMs: at(1, 10) },
      { pk: 2, startMs: -62_000_000_000_000, endMs: -62_000_000_000_000 + 1000 },
    ]);
    const r = syncAttention(db, { sourcePath: p });
    expect(r.rowsRejected).toBe(1);
    expect(r.spansInserted).toBe(1);
    // Watermark still advances past the reject, or it is re-read forever.
    expect(r.watermarkAfter).toBe(2);
  });

  it("stores both halves of a midnight-crossing row", () => {
    const p = makeSource("mid.db", [
      { pk: 7, startMs: at(1, 23, 40), endMs: at(2, 1, 20) },
    ]);
    const r = syncAttention(db, { sourcePath: p });
    expect(r.spansInserted).toBe(2);
    const rows = db
      .prepare(
        "SELECT part_index, local_day, duration_ms FROM attention_focus_spans ORDER BY part_index"
      )
      .all() as { part_index: number; local_day: string; duration_ms: number }[];
    expect(rows.map((x) => x.part_index)).toEqual([0, 1]);
    expect(rows[0]!.local_day).not.toBe(rows[1]!.local_day);
    expect(rows[0]!.duration_ms + rows[1]!.duration_ms).toBe(100 * 60_000);
  });

  it("skips cleanly when the source is missing", () => {
    const r = syncAttention(db, { sourcePath: join(dir, "nope.db") });
    expect(r.status).toBe("skipped");
    expect(r.reason).toBe("source_missing");
    expect(r.ok).toBe(false);
    // A skipped run must not write a success baseline.
    expect(state()).toBeUndefined();
  });

  it("skips when the database carries no known focus stream", () => {
    const p = makeSource("other.db", [
      { startMs: at(1, 9), endMs: at(1, 10), stream: "/app/intents" },
    ]);
    const r = syncAttention(db, { sourcePath: p });
    expect(r.status).toBe("skipped");
    expect(r.reason).toBe("schema_mismatch");
  });

  it("honours the bundle allowlist", () => {
    const p = makeSource("allow.db", [
      { pk: 1, bundle: "com.example.keep", startMs: at(1, 9), endMs: at(1, 10) },
      { pk: 2, bundle: "com.example.drop", startMs: at(1, 10), endMs: at(1, 11) },
    ]);
    const r = syncAttention(db, {
      sourcePath: p,
      allowBundles: new Set(["com.example.keep"]),
    });
    expect(r.spansInserted).toBe(1);
    // Watermark covers both, so the filtered row is not reconsidered later.
    expect(r.watermarkAfter).toBe(2);
  });

  it("reports coverage from what actually landed", () => {
    const p = makeSource("cov.db", [
      { startMs: at(1, 9), endMs: at(1, 10) },
      { startMs: at(3, 14), endMs: at(3, 15) },
    ]);
    const r = syncAttention(db, { sourcePath: p });
    expect(r.coverageFromMs).toBe(at(1, 9));
    expect(r.coverageToMs).toBe(at(3, 15));
  });
});
