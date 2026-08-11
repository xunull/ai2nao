import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import DatabaseCtor from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { probeAttentionSource, REQUIRED_HISTORY_DAYS } from "../src/attention/probe.js";
import { FOCUS_STREAM, probeSource } from "../src/attention/read.js";
import {
  appleSecondsToUnixMs,
  spanDays,
  unixMsToAppleSeconds,
} from "../src/attention/time.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ai2nao-attention-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/**
 * Build a knowledgeC-shaped fixture. Mirrors the hand-built-fixture technique in
 * `test/chromeHistory.sync.test.ts` — no Full Disk Access, no real database.
 */
function makeSource(
  path: string,
  rows: { stream: string; bundle: string; startMs: number; endMs?: number | null }[]
): void {
  const db = new DatabaseCtor(path);
  db.exec(`
    CREATE TABLE ZOBJECT (
      Z_PK            INTEGER PRIMARY KEY,
      ZSTREAMNAME     TEXT,
      ZVALUESTRING    TEXT,
      ZSTARTDATE      REAL,
      ZENDDATE        REAL,
      ZSECONDSFROMGMT INTEGER
    );
  `);
  const ins = db.prepare(
    `INSERT INTO ZOBJECT (ZSTREAMNAME, ZVALUESTRING, ZSTARTDATE, ZENDDATE, ZSECONDSFROMGMT)
     VALUES (?, ?, ?, ?, NULL)`
  );
  for (const r of rows) {
    ins.run(
      r.stream,
      r.bundle,
      unixMsToAppleSeconds(r.startMs),
      r.endMs === undefined || r.endMs === null
        ? null
        : unixMsToAppleSeconds(r.endMs)
    );
  }
  db.close();
}

const DAY = 86_400_000;

describe("attention time conversion", () => {
  it("round-trips the Apple 2001 epoch", () => {
    const ms = Date.UTC(2026, 7, 10, 9, 35, 0);
    expect(appleSecondsToUnixMs(unixMsToAppleSeconds(ms))).toBe(ms);
  });

  it("maps Apple second zero to 2001-01-01 UTC", () => {
    expect(appleSecondsToUnixMs(0)).toBe(Date.UTC(2001, 0, 1));
  });

  it("floors span days and never goes negative", () => {
    expect(spanDays(0, DAY * 3 + 1000)).toBe(3);
    expect(spanDays(DAY, 0)).toBe(0);
  });
});

describe("probeSource — the four causes SQLite reports identically", () => {
  it("reports source_missing when the file is not there", () => {
    const r = probeSource(join(dir, "nope.db"));
    expect(r.status).toBe("source_missing");
    expect(r.detail).toContain("will not create it");
  });

  it("reports open_failed when the header is not SQLite", () => {
    const p = join(dir, "garbage.db");
    writeFileSync(p, "this is definitely not a database, not even close");
    const r = probeSource(p);
    expect(r.status).toBe("open_failed");
    expect(r.detail).toContain("not a SQLite header");
  });

  it("reports not_authorized when not a single byte is readable", () => {
    const p = join(dir, "locked.db");
    makeSource(p, [
      { stream: FOCUS_STREAM, bundle: "com.example.a", startMs: Date.now() },
    ]);
    chmodSync(p, 0o000);
    let readable = true;
    try {
      probeSource(p);
    } catch {
      readable = false;
    }
    const r = probeSource(p);
    chmodSync(p, 0o644);
    // Running as root defeats chmod; skip rather than assert a false negative.
    if (r.status === "ok" || readable === false) return;
    expect(r.status).toBe("not_authorized");
    expect(r.detail).toContain("Full Disk Access");
  });

  it("reports schema_mismatch when ZOBJECT carries no candidate focus stream", () => {
    const p = join(dir, "wrong-shape.db");
    // Real streams observed on this machine, none of which is a focus stream.
    makeSource(p, [
      { stream: "/app/intents", bundle: "com.example.a", startMs: Date.now() },
      { stream: "/bluetooth/isConnected", bundle: "com.example.b", startMs: Date.now() },
    ]);
    const r = probeSource(p);
    expect(r.status).toBe("schema_mismatch");
    expect(r.detail).toContain("--json");
  });

  it("falls back to /app/inFocus on machines that carry it instead", () => {
    const p = join(dir, "infocus-only.db");
    makeSource(p, [
      { stream: "/app/inFocus", bundle: "com.example.a", startMs: Date.now() },
    ]);
    const r = probeSource(p);
    expect(r.status).toBe("ok");
    expect(r.focusStream).toBe("/app/inFocus");
  });

  it("prefers /app/usage when a machine carries both", () => {
    const p = join(dir, "both.db");
    const now = Date.now();
    makeSource(p, [
      { stream: "/app/inFocus", bundle: "com.example.a", startMs: now },
      { stream: FOCUS_STREAM, bundle: "com.example.b", startMs: now },
    ]);
    expect(probeSource(p).focusStream).toBe("/app/usage");
  });

  it("reports schema_mismatch when ZOBJECT does not exist at all", () => {
    const p = join(dir, "empty.db");
    const db = new DatabaseCtor(p);
    db.exec("CREATE TABLE unrelated (id INTEGER);");
    db.close();
    const r = probeSource(p);
    expect(r.status).toBe("schema_mismatch");
  });

  it("reports ok when the focus stream is present", () => {
    const p = join(dir, "good.db");
    makeSource(p, [
      { stream: FOCUS_STREAM, bundle: "com.example.a", startMs: Date.now() },
    ]);
    expect(probeSource(p).status).toBe("ok");
  });
});

describe("probeAttentionSource — the Phase 0 gate", () => {
  it("fails the gate when history is shorter than the floor", () => {
    const p = join(dir, "shallow.db");
    const now = Date.now();
    makeSource(p, [
      { stream: FOCUS_STREAM, bundle: "com.example.a", startMs: now - DAY * 3 },
      { stream: FOCUS_STREAM, bundle: "com.example.b", startMs: now },
    ]);
    const r = probeAttentionSource(p);
    expect(r.gate.actualDays).toBe(3);
    expect(r.gate.passed).toBe(false);
    expect(r.gate.reason).toContain("revisit the approach");
  });

  it("passes the gate at or above the floor", () => {
    const p = join(dir, "deep.db");
    const now = Date.now();
    makeSource(p, [
      {
        stream: FOCUS_STREAM,
        bundle: "com.example.a",
        startMs: now - DAY * (REQUIRED_HISTORY_DAYS + 6),
      },
      { stream: FOCUS_STREAM, bundle: "com.example.b", startMs: now },
    ]);
    const r = probeAttentionSource(p);
    expect(r.gate.passed).toBe(true);
    expect(r.gate.actualDays).toBeGreaterThanOrEqual(REQUIRED_HISTORY_DAYS);
  });

  it("carries the source failure into the gate reason when unreadable", () => {
    const r = probeAttentionSource(join(dir, "absent.db"));
    expect(r.gate.passed).toBe(false);
    expect(r.gate.actualDays).toBeNull();
    expect(r.streams).toEqual([]);
    expect(r.focusStreamPresent).toBe(false);
  });

  it("still lists every stream when no focus stream is present", () => {
    // schema_mismatch is exactly when the inventory matters: it is the only
    // way to find out what the machine renamed the stream to.
    const p = join(dir, "inventory.db");
    const now = Date.now();
    makeSource(p, [
      { stream: "/app/intents", bundle: "com.example.a", startMs: now - DAY },
      { stream: "/display/isBacklit", bundle: "com.example.b", startMs: now },
    ]);
    const r = probeAttentionSource(p);
    expect(r.source.status).toBe("schema_mismatch");
    expect(r.focusStream).toBeNull();
    expect(r.streams.map((s) => s.stream).sort()).toEqual([
      "/app/intents",
      "/display/isBacklit",
    ]);
    expect(r.gate.passed).toBe(false);
  });

  it("judges ZENDDATE unusable when rows carry no end time", () => {
    const p = join(dir, "no-end.db");
    const now = Date.now();
    makeSource(p, [
      { stream: FOCUS_STREAM, bundle: "com.example.a", startMs: now - DAY, endMs: null },
      { stream: FOCUS_STREAM, bundle: "com.example.b", startMs: now, endMs: null },
    ]);
    const r = probeAttentionSource(p);
    expect(r.endDate?.verdict).toBe("unusable");
    expect(r.endDate?.usable).toBe(0);
  });

  it("judges ZENDDATE reliable when every row closes itself", () => {
    const p = join(dir, "with-end.db");
    const now = Date.now();
    makeSource(p, [
      {
        stream: FOCUS_STREAM,
        bundle: "com.example.a",
        startMs: now - DAY,
        endMs: now - DAY + 60_000,
      },
      { stream: FOCUS_STREAM, bundle: "com.example.b", startMs: now, endMs: now + 30_000 },
    ]);
    const r = probeAttentionSource(p);
    expect(r.endDate?.verdict).toBe("reliable");
    expect(r.endDate?.maxDurationMs).toBe(60_000);
  });

  it("counts a zero-length row separately from a missing end time", () => {
    const p = join(dir, "bad-end.db");
    const now = Date.now();
    makeSource(p, [
      { stream: FOCUS_STREAM, bundle: "com.example.a", startMs: now, endMs: now },
    ]);
    const r = probeAttentionSource(p);
    expect(r.endDate?.usable).toBe(0);
    expect(r.endDate?.zeroDuration).toBe(1);
    expect(r.endDate?.nullEnd).toBe(0);
  });

  it("stays reliable when rows are short but never missing an end", () => {
    // Measured on the real machine: 153 of 10343 rows are zero-length flickers
    // and 0 are null. Treating those as unreliable would send the design
    // chasing closing logic it does not need.
    const p = join(dir, "flickers.db");
    const now = Date.now();
    makeSource(p, [
      { stream: FOCUS_STREAM, bundle: "com.example.a", startMs: now - DAY, endMs: now - DAY },
      { stream: FOCUS_STREAM, bundle: "com.example.b", startMs: now - 1000, endMs: now },
    ]);
    const r = probeAttentionSource(p);
    expect(r.endDate?.nullEnd).toBe(0);
    expect(r.endDate?.zeroDuration).toBe(1);
    expect(r.endDate?.verdict).toBe("reliable");
  });
});
