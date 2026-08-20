import DatabaseCtor from "better-sqlite3";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PROBES, type Probe, type ProbeContext } from "../src/home/leads.js";
import { emptyUsage } from "../src/workTokensTrend/types.js";
import { migrate } from "../src/store/migrations.js";

let db: Database.Database;

beforeEach(() => {
  db = new DatabaseCtor(":memory:");
  migrate(db);
});
afterEach(() => db?.close());

const NOW = new Date(2026, 7, 10, 20, 0, 0, 0);

const probe = (id: string): Probe => {
  const p = PROBES.find((x) => x.id === id);
  if (!p) throw new Error(`probe ${id} not registered`);
  return p;
};

/** A trend context whose today-bucket carries the given token total. */
function ctxWithTokens(tokens: number, now = NOW): ProbeContext {
  const bucket = {
    bucketStart: new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString(),
    bucketEnd: new Date(now.getTime() + 86_400_000).toISOString(),
    sources: {
      claude: { ...emptyUsage("ok" as const), freshInput: tokens },
      codex: emptyUsage("ok" as const),
      minimax: emptyUsage("ok" as const),
      kimi: emptyUsage("absent" as const),
    },
    codexTokens: 0,
    minimaxTokens: 0,
  } as never;
  return {
    now,
    trend: () => ({ buckets: [bucket] }) as never,
  };
}

const dayOf = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

let rowSeq = 1;
function addSpan(day: string, startMs: number, durationMs: number, bundle = "com.example.a"): void {
  db.prepare(
    `INSERT INTO attention_focus_spans
       (source, source_instance_id, source_row_id, part_index, bundle_id,
        start_ms, end_ms, duration_ms, local_day, inserted_at)
     VALUES ('knowledgec','i',?,0,?,?,?,?,?,'x')`
  ).run(rowSeq++, bundle, startMs, startMs + durationMs, durationMs, day);
}

const today = dayOf(NOW);
const at = (h: number, mi = 0, dayOffset = 0): number =>
  new Date(2026, 7, 10 + dayOffset, h, mi, 0, 0).getTime();

describe("attention.absent", () => {
  const p = () => probe("attention.absent");

  it("stays silent when there is no attention data at all", () => {
    // No records is not the same as "you were away" — it usually means the
    // task is off or Full Disk Access was never granted. That is data.stale's
    // job and the status panel's job, not a lead's job to guess at.
    expect(p().run(db, ctxWithTokens(5_000_000))).toBeNull();
  });

  it("stays silent when screen time is normal", () => {
    addSpan(today, at(9), 3 * 3_600_000);
    expect(p().run(db, ctxWithTokens(5_000_000))).toBeNull();
  });

  it("stays silent when token use is trivial", () => {
    addSpan(today, at(9), 10 * 60_000);
    expect(p().run(db, ctxWithTokens(1000))).toBeNull();
  });

  it("speaks when the agent burned tokens while you were barely at the screen", () => {
    addSpan(today, at(9), 12 * 60_000);
    const lead = p().run(db, ctxWithTokens(3_000_000));
    expect(lead).not.toBeNull();
    expect(lead!.title).toMatch(/12 分钟/);
    expect(lead!.severity).toBe("notable");
  });
});

describe("attention.late_start", () => {
  const p = () => probe("attention.late_start");

  const seedBaseline = (startHour: number, days: number) => {
    for (let i = 1; i <= days; i++) {
      const d = new Date(2026, 7, 10 - i);
      addSpan(dayOf(d), new Date(2026, 7, 10 - i, startHour, 0).getTime(), 3_600_000);
    }
  };

  it("stays silent without enough baseline days", () => {
    seedBaseline(9, 3);
    addSpan(today, at(15), 3_600_000);
    expect(p().run(db, ctxWithTokens(0))).toBeNull();
  });

  it("stays silent when today started around the usual time", () => {
    seedBaseline(9, 8);
    addSpan(today, at(9, 20), 3_600_000);
    expect(p().run(db, ctxWithTokens(0))).toBeNull();
  });

  it("speaks when today started much later than the median", () => {
    seedBaseline(9, 8);
    addSpan(today, at(14), 3_600_000);
    const lead = p().run(db, ctxWithTokens(0));
    expect(lead).not.toBeNull();
    expect(lead!.title).toMatch(/14:00/);
    expect(lead!.title).toMatch(/300 分钟/);
  });

  it("compares minute-of-day, not raw timestamps", () => {
    // Comparing absolute epoch values across days would make every later day
    // look "late" by 24 hours.
    seedBaseline(9, 8);
    addSpan(today, at(9), 3_600_000);
    expect(p().run(db, ctxWithTokens(0))).toBeNull();
  });
});

describe("attention.new_app", () => {
  const p = () => probe("attention.new_app");

  const seedHistory = (days: number, bundle = "com.example.old") => {
    for (let i = 1; i <= days; i++) {
      const d = new Date(2026, 7, 10 - i);
      addSpan(dayOf(d), new Date(2026, 7, 10 - i, 9, 0).getTime(), 3_600_000, bundle);
    }
  };

  it("refuses to speak until the data covers a full window", () => {
    // Guard against the worst failure mode: with only a few days ingested,
    // "first seen inside the window" is true for EVERY app, so this probe would
    // report a pile of fake new apps every day for the first two weeks.
    seedHistory(5);
    addSpan(today, at(10), 30 * 60_000, "com.example.brandnew");
    expect(p().run(db, ctxWithTokens(0))).toBeNull();
  });

  it("stays silent when today's apps are all familiar", () => {
    seedHistory(20);
    addSpan(today, at(10), 30 * 60_000, "com.example.old");
    expect(p().run(db, ctxWithTokens(0))).toBeNull();
  });

  it("stays silent when the new app was barely touched", () => {
    seedHistory(20);
    addSpan(today, at(10), 60_000, "com.example.brandnew");
    expect(p().run(db, ctxWithTokens(0))).toBeNull();
  });

  it("speaks when a genuinely new app got real use", () => {
    seedHistory(20);
    addSpan(today, at(10), 25 * 60_000, "com.example.brandnew");
    const lead = p().run(db, ctxWithTokens(0));
    expect(lead).not.toBeNull();
    expect(lead!.title).toMatch(/25 分钟/);
  });

  it("prefers the mac_apps display name over the bundle id", () => {
    seedHistory(20);
    db.prepare(
      `INSERT INTO mac_apps (bundle_id, name, path, source_root, first_seen_at, last_seen_at, inserted_at, updated_at)
       VALUES ('com.example.brandnew', 'Brand New', '/Applications/B.app', '/Applications', 'x','x','x','x')`
    ).run();
    addSpan(today, at(10), 25 * 60_000, "com.example.brandnew");
    expect(p().run(db, ctxWithTokens(0))!.title).toMatch(/Brand New/);
  });
});

describe("registry wiring", () => {
  it("registers all three attention probes with a baseline and a deep link", () => {
    for (const id of ["attention.absent", "attention.late_start", "attention.new_app"]) {
      const p = probe(id);
      expect(p.baseline.kind).toBeTruthy();
      expect(p.href).toBe("/attention");
    }
  });

  it("uses three different baseline kinds", () => {
    // Each probe has to say what makes today unusual, and these three are
    // unusual in genuinely different ways.
    const kinds = ["attention.absent", "attention.late_start", "attention.new_app"].map(
      (id) => probe(id).baseline.kind
    );
    expect(new Set(kinds).size).toBe(3);
  });
});
