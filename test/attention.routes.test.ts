import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/serve/app.js";
import { openDatabase } from "../src/store/open.js";

let dir: string;
let db: Database.Database;
let app: ReturnType<typeof createApp>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ai2nao-attn-routes-"));
  db = openDatabase(join(dir, "index.db"));
  app = createApp({ db });
});

afterEach(() => {
  vi.unstubAllEnvs();
  db?.close();
  rmSync(dir, { recursive: true, force: true });
});

function addSpan(bundle: string, startMs: number, endMs: number, day: string): void {
  db.prepare(
    `INSERT INTO attention_focus_spans
       (source, source_instance_id, source_row_id, part_index, bundle_id,
        start_ms, end_ms, duration_ms, local_day, inserted_at)
     VALUES ('knowledgec','i',?,0,?,?,?,?,?,'x')`
  ).run(
    Math.floor(Math.random() * 1e9),
    bundle,
    startMs,
    endMs,
    endMs - startMs,
    day
  );
}

describe("attention routes", () => {
  it("GET /api/attention/status always answers, even with nothing ingested", async () => {
    const res = await app.request("/api/attention/status");
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    // On a dev runtime this is unsupported_runtime; either way the endpoint
    // must say *why* rather than return an empty success.
    expect(typeof body.status.status).toBe("string");
    expect(body.status.message.length).toBeGreaterThan(0);
    expect(body.status.spanCount).toBe(0);
  });

  it("declares the sources it cannot cross alongside the status", async () => {
    // The page has to be able to say "shell commands are not crossable yet"
    // instead of implying no commands were run.
    const res = await app.request("/api/attention/status");
    const body = (await res.json()) as any;
    expect(body.unsupportedSources.map((s: any) => s.source)).toContain("atuin");
  });

  it("GET /api/attention/day returns a day payload", async () => {
    const base = new Date(2026, 7, 10, 9, 0, 0, 0).getTime();
    addSpan("com.example.editor", base, base + 3600_000, "2026-08-10");
    const res = await app.request("/api/attention/day?day=2026-08-10");
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.day.localDay).toBe("2026-08-10");
    expect(body.day.spanCount).toBe(1);
    expect(body.day.totalMs).toBe(3600_000);
    expect(body.day.byBundle[0].bundleId).toBe("com.example.editor");
  });

  it("rejects a malformed day instead of silently defaulting", async () => {
    const res = await app.request("/api/attention/day?day=yesterday");
    expect(res.status).toBe(400);
    const body = (await res.json()) as any;
    expect(body.error.message).toMatch(/YYYY-MM-DD/);
  });

  it("falls back to today when no day is given", async () => {
    const res = await app.request("/api/attention/day");
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.day.localDay).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("GET /api/attention/days lists days that hold data, newest first", async () => {
    const d1 = new Date(2026, 7, 9, 9).getTime();
    const d2 = new Date(2026, 7, 10, 9).getTime();
    addSpan("com.example.a", d1, d1 + 60_000, "2026-08-09");
    addSpan("com.example.a", d2, d2 + 120_000, "2026-08-10");
    const res = await app.request("/api/attention/days");
    const body = (await res.json()) as any;
    expect(body.days.map((d: any) => d.day)).toEqual(["2026-08-10", "2026-08-09"]);
    expect(body.days[0].total_ms).toBe(120_000);
  });

  it("clamps an absurd limit rather than trusting it", async () => {
    const res = await app.request("/api/attention/days?limit=99999");
    expect(res.status).toBe(200);
    const res2 = await app.request("/api/attention/days?limit=notanumber");
    expect(res2.status).toBe(200);
  });
});
