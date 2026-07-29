import { describe, expect, it } from "vitest";
import {
  decidePoll,
  mapQuotaItems,
  mapRunRows,
  pollOnce,
  QUOTA_POLL_MS,
  RUN_POLL_MS,
  emptyPollClock,
} from "../src/desktopShell/notifyPoller.js";
import { emptyNotifyState } from "../src/desktopShell/notifyRules.js";

/**
 * The layer between the daemon's HTTP API and the notification rules.
 *
 * Two cadences, not one, and the reason is measurable: `GET /api/providers` calls
 * `ensureProviderConfigs` (src/providers/store.ts:88-97), an INSERT OR IGNORE
 * transaction that takes a write lock on EVERY request. Polling it every 30s
 * makes the shell a permanent writer against a 898MB database — for numbers whose
 * underlying windows are 5 hours and 7 days. Runs are a pure read, so they can be
 * cheap and frequent; quota is a write-lock, so it is slow and rare.
 *
 * The mapping half exists because shape drift is silent. If `/api/scheduler/runs`
 * ever renames a field, an unvalidated map yields `undefined` statuses, every run
 * looks non-terminal, and notifications simply stop — with nothing in any log.
 */

const BASE = "http://127.0.0.1:8787";
const T0 = 1_800_000_000_000;

function jsonFetch(routes: Record<string, unknown>): typeof fetch {
  return (async (input: string | URL) => {
    const url = new URL(String(input));
    const key = url.pathname;
    if (!(key in routes)) return new Response("Not Found", { status: 404 });
    return new Response(JSON.stringify(routes[key]), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

describe("decidePoll — two cadences", () => {
  it("polls both on the very first tick", () => {
    expect(decidePoll({ now: T0, clock: emptyPollClock() })).toEqual({
      pollRuns: true,
      pollQuota: true,
    });
  });

  it("polls runs often and quota rarely", () => {
    const clock = { lastRunPollAt: T0, lastQuotaPollAt: T0 };
    // One run interval later: runs yes, quota no.
    expect(decidePoll({ now: T0 + RUN_POLL_MS, clock })).toEqual({
      pollRuns: true,
      pollQuota: false,
    });
    // Quota only comes due much later.
    expect(decidePoll({ now: T0 + QUOTA_POLL_MS, clock })).toEqual({
      pollRuns: true,
      pollQuota: true,
    });
  });

  it("quota is an order of magnitude rarer than runs — the write-lock tax", () => {
    expect(QUOTA_POLL_MS / RUN_POLL_MS).toBeGreaterThanOrEqual(10);
  });

  it("polls nothing when neither is due", () => {
    const clock = { lastRunPollAt: T0, lastQuotaPollAt: T0 };
    expect(decidePoll({ now: T0 + 1_000, clock })).toEqual({
      pollRuns: false,
      pollQuota: false,
    });
  });
});

describe("mapRunRows — validation at the boundary", () => {
  it("maps the real API shape", () => {
    const rows = mapRunRows({
      runs: [
        {
          id: 7,
          taskKey: "repos.scan",
          trigger: "manual",
          startedAt: "2026-07-29T10:00:00.000Z",
          finishedAt: "2026-07-29T10:00:05.000Z",
          status: "success",
          summary: {},
          errorSummary: null,
          leaseOwner: null,
        },
      ],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      id: 7,
      taskKey: "repos.scan",
      trigger: "manual",
      startedAt: "2026-07-29T10:00:00.000Z",
      finishedAt: "2026-07-29T10:00:05.000Z",
      status: "success",
      errorSummary: null,
    });
  });

  it("drops malformed rows rather than emitting undefined fields", () => {
    // An undefined status reads as non-terminal forever, which silently stops all
    // notifications. Dropping the row is loud by comparison.
    const rows = mapRunRows({
      runs: [
        { id: "seven", taskKey: "x", trigger: "manual", startedAt: "", status: "success" },
        { id: 8, taskKey: "ok", trigger: "manual", startedAt: "t", status: "success" },
      ],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(8);
  });

  it("survives a payload that is not the expected envelope", () => {
    expect(mapRunRows({})).toEqual([]);
    expect(mapRunRows(null)).toEqual([]);
    expect(mapRunRows({ runs: "nope" })).toEqual([]);
  });
});

describe("mapQuotaItems — flattening providers to quota lines", () => {
  it("flattens enabled providers and carries the provider id down", () => {
    const items = mapQuotaItems({
      ok: true,
      providers: [
        {
          id: "codex",
          enabled: true,
          items: [
            { key: "7d", label: "7 天用量", remainingPercent: 100 },
            { key: "plan", label: "当前档位", remainingPercent: null },
          ],
        },
      ],
    });
    expect(items).toEqual([
      { provider: "codex", itemKey: "7d", label: "7 天用量", remainingPercent: 100 },
      { provider: "codex", itemKey: "plan", label: "当前档位", remainingPercent: null },
    ]);
  });

  it("skips providers the user disabled — no alerts for something switched off", () => {
    const items = mapQuotaItems({
      providers: [
        { id: "minimax", enabled: false, items: [{ key: "a", label: "A", remainingPercent: 1 }] },
        { id: "kimi", enabled: true, items: [{ key: "b", label: "B", remainingPercent: 1 }] },
      ],
    });
    expect(items.map((i) => i.provider)).toEqual(["kimi"]);
  });

  it("survives junk", () => {
    expect(mapQuotaItems({})).toEqual([]);
    expect(mapQuotaItems({ providers: [{ id: "x", enabled: true }] })).toEqual([]);
  });
});

describe("pollOnce — end to end over a fake daemon", () => {
  const runsPayload = (rows: unknown[]) => ({ runs: rows });
  const runRow = (over: Record<string, unknown> = {}) => ({
    id: 100,
    taskKey: "work.tokens.refresh",
    trigger: "scheduled",
    startedAt: "2026-07-29T10:00:00.000Z",
    finishedAt: "2026-07-29T10:00:01.000Z",
    status: "failed",
    errorSummary: "database is locked",
    ...over,
  });

  it("first poll is silent and establishes a baseline", async () => {
    const out = await pollOnce({
      baseUrl: BASE,
      state: emptyNotifyState(),
      clock: emptyPollClock(),
      now: T0,
      fetchImpl: jsonFetch({
        "/api/scheduler/runs": runsPayload([runRow()]),
        "/api/providers": { providers: [] },
      }),
    });
    expect(out.notifications).toEqual([]);
    expect(out.state.lastSeenRunId).toBe(100);
    expect(out.clock.lastRunPollAt).toBe(T0);
    expect(out.clock.lastQuotaPollAt).toBe(T0);
  });

  it("a failure after the baseline fires once", async () => {
    const first = await pollOnce({
      baseUrl: BASE,
      state: emptyNotifyState(),
      clock: emptyPollClock(),
      now: T0,
      fetchImpl: jsonFetch({
        "/api/scheduler/runs": runsPayload([runRow({ id: 100, status: "success" })]),
        "/api/providers": { providers: [] },
      }),
    });

    const second = await pollOnce({
      baseUrl: BASE,
      state: first.state,
      clock: first.clock,
      now: T0 + RUN_POLL_MS,
      fetchImpl: jsonFetch({
        "/api/scheduler/runs": runsPayload([runRow({ id: 101 }), runRow({ id: 100, status: "success" })]),
        "/api/providers": { providers: [] },
      }),
    });
    expect(second.notifications).toHaveLength(1);
    expect(second.notifications[0]?.kind).toBe("task-failed");
  });

  it("does not touch /api/providers when quota is not due", async () => {
    const hits: string[] = [];
    const spy: typeof fetch = (async (input: string | URL) => {
      hits.push(new URL(String(input)).pathname);
      return new Response(JSON.stringify({ runs: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    await pollOnce({
      baseUrl: BASE,
      state: emptyNotifyState(),
      clock: { lastRunPollAt: T0 - RUN_POLL_MS, lastQuotaPollAt: T0 },
      now: T0,
      fetchImpl: spy,
    });
    expect(hits).toEqual(["/api/scheduler/runs"]);
  });

  it("a daemon that went away does not throw or corrupt state", async () => {
    const dead: typeof fetch = (async () => {
      throw Object.assign(new Error("ECONNREFUSED"), { code: "ECONNREFUSED" });
    }) as typeof fetch;

    const state = { ...emptyNotifyState(), lastSeenRunId: 99 };
    const out = await pollOnce({
      baseUrl: BASE,
      state,
      clock: emptyPollClock(),
      now: T0,
      fetchImpl: dead,
    });
    expect(out.notifications).toEqual([]);
    // Crucially the baseline is preserved: losing it would replay history the
    // next time the daemon comes back.
    expect(out.state.lastSeenRunId).toBe(99);
  });

  it("asks for exactly one page of runs", async () => {
    let seen = "";
    const spy: typeof fetch = (async (input: string | URL) => {
      seen = String(input);
      return new Response(JSON.stringify({ runs: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    await pollOnce({
      baseUrl: BASE,
      state: emptyNotifyState(),
      clock: { lastRunPollAt: T0 - RUN_POLL_MS, lastQuotaPollAt: T0 },
      now: T0,
      fetchImpl: spy,
    });
    expect(seen).toContain("limit=50");
  });
});
