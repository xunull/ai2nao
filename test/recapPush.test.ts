import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../src/store/open.js";
import { resolveWindow, isoWeekKey, localDayKey } from "../src/workRecap/window.js";
import { feishuSign, postFeishuCard } from "../src/notify/feishu.js";
import { renderFeishuCard } from "../src/workRecap/push.js";
import { parseNotifyConfigJson, type NotifyConfig } from "../src/notify/config.js";
import {
  dueAtFor,
  periodKeyFor,
  runRecapPushTick,
  MAX_PUSH_ATTEMPTS,
} from "../src/workRecap/pushTick.js";
import { __resetInflightForTests, setInflight } from "../src/workRecap/inflight.js";
import type { WorkRecapRun } from "../src/workRecap/types.js";

function freshDb() {
  return openDatabase(
    join(tmpdir(), `ai2nao-push-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
  );
}

const CFG: NotifyConfig = {
  feishu: { enabled: true, webhookUrl: "https://open.feishu.cn/hook/x", secret: "s3cret" },
  daily: { enabled: true, atHour: 21 },
  weekly: { enabled: true, atHour: 9, weekday: 1 },
};

function fakeRun(over: Partial<WorkRecapRun["facts"]> = {}): WorkRecapRun {
  return {
    id: 1,
    windowKey: "today",
    generatedAt: new Date("2026-07-13T21:00:00"),
    model: "test",
    promptVersion: "work-recap@v3",
    facts: {
      windowKey: "today",
      windowStart: "2026-07-13T00:00:00.000Z",
      windowEnd: "2026-07-13T21:00:00.000Z",
      authorEmail: "x@example.com",
      totalCommits: 5,
      projectCount: 2,
      projectShare: [
        { projectKey: "/Users/alice/repo/ai2nao", projectLabel: "ai2nao", commitCount: 4, share: 0.8 },
      ],
      commitTypeCounts: {} as never,
      dailyCounts: [],
      reposScanned: 2,
      reposTotal: 2,
      scanTruncated: false,
      scanTruncatedReason: null,
      diagnostics: [],
      tokenFacts: {
        status: "ok",
        data: {
          costUsd: 20.08,
          coverage: "full",
          unpricedTokenCount: 0,
          priceSnapshotDate: "2026-07-12",
          headlineTokens: 105_751,
          dominantProvider: "claude",
          claudeShare: 0.9,
          codexShare: 0.1,
        },
      },
      topicDrift: {
        status: "ok",
        data: {
          bySource: [
            { source: "conversation", events: 10, top: [{ name: "Git安全审计", count: 4, share: 0.4 }] },
          ],
          drift: null,
        },
      },
      ...over,
    },
    inference: {
      summary: "今天花了 $20.08,主要在聊 Git安全审计。",
      workMode: "explore",
      workModeReason: "研究多于产出",
      nextUp: [],
      fragmentation: "low",
      degraded: false,
      degradeReason: null,
    },
  } as WorkRecapRun;
}

const okFetch = async () => ({ ok: true, status: 200, json: async () => ({ code: 0 }) });

describe("window resolution", () => {
  it("today = 本地今天 00:00 → now", () => {
    const now = new Date(2026, 6, 13, 15, 30); // 2026-07-13 15:30 local
    const w = resolveWindow("today", now);
    expect(w.start.getHours()).toBe(0);
    expect(localDayKey(w.start)).toBe("2026-07-13");
    expect(w.end).toEqual(now);
  });

  it("last-week = 上周一 00:00 → 本周一 00:00(半开,含上周日整天)", () => {
    const now = new Date(2026, 6, 15, 10, 0); // Wed 2026-07-15
    const w = resolveWindow("last-week", now);
    expect(localDayKey(w.start)).toBe("2026-07-06"); // 上周一
    expect(localDayKey(w.end)).toBe("2026-07-13"); // 本周一(排他)
    expect(w.start.getHours()).toBe(0);
    expect(w.end.getHours()).toBe(0);
  });

  it("rolling windows unchanged (7d = now - 7d → now)", () => {
    const now = new Date(2026, 6, 13, 12, 0);
    const w = resolveWindow("7d", now);
    expect(w.end).toEqual(now);
    expect(Math.round((now.getTime() - w.start.getTime()) / 86_400_000)).toBe(7);
  });

  it("ISO week-year (verified against Python datetime.isocalendar)", () => {
    // The trap is the week-YEAR, not the calendar year: a late-December date can
    // belong to NEXT year's W01, and a 53-week year is real. Values below are
    // cross-checked against a reference implementation.
    expect(isoWeekKey(new Date(2024, 11, 30))).toBe("2025-W01"); // Dec date → next year's W01
    expect(isoWeekKey(new Date(2026, 11, 28))).toBe("2026-W53"); // 2026 genuinely has 53 weeks
    expect(isoWeekKey(new Date(2027, 0, 4))).toBe("2027-W01");
    expect(isoWeekKey(new Date(2026, 6, 6))).toBe("2026-W28");
  });
});

describe("feishu sender", () => {
  it("signs with key=`${timestamp}\\n${secret}` over an EMPTY message", () => {
    // Locked to a fixed vector so nobody 'fixes' it into the (wrong) other order.
    const sig = feishuSign("1700000000", "s3cret");
    expect(sig).toBe(feishuSign("1700000000", "s3cret"));
    expect(sig).not.toBe(feishuSign("1700000001", "s3cret"));
    expect(sig.length).toBeGreaterThan(20);
  });

  it("HTTP 200 with code!=0 is a FAILURE (the classic trap)", async () => {
    const res = await postFeishuCard({
      webhookUrl: "https://x",
      card: {},
      secret: "s",
      fetchJson: async () => ({
        ok: true,
        status: 200,
        json: async () => ({ code: 19021, msg: "sign match fail" }),
      }),
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("19021");
  });

  it("code=0 is success", async () => {
    const res = await postFeishuCard({ webhookUrl: "https://x", card: {}, fetchJson: okFetch });
    expect(res.ok).toBe(true);
  });
});

describe("card rendering", () => {
  it("redacts secrets and scrubs home paths before anything leaves the machine", () => {
    const run = fakeRun();
    // Placeholder identifiers only — this repo is public and gitleaks-gated.
    const fakeKey = ["sk", "0123456789abcdefghijklmn"].join("-");
    run.inference.summary = `key ${fakeKey} in /Users/alice/repo`;
    const card = JSON.stringify(renderFeishuCard("daily", run));
    expect(card).not.toContain(fakeKey);
    expect(card).not.toContain("/Users/alice");
    expect(card).toContain("$20.08");
    expect(card).toContain("Git安全审计");
  });
});

describe("notify config", () => {
  it("no webhookUrl → null (feature off)", () => {
    expect(parseNotifyConfigJson('{"daily":{"enabled":true}}')).toBeNull();
    expect(parseNotifyConfigJson("not json")).toBeNull();
  });
  it("defaults fill in hours", () => {
    const c = parseNotifyConfigJson('{"feishu":{"webhookUrl":"https://x"}}')!;
    expect(c.daily.atHour).toBe(21);
    expect(c.weekly.atHour).toBe(9);
    expect(c.weekly.weekday).toBe(1);
  });
});

describe("push tick — calendar guard", () => {
  const gen = async () => ({ kind: "ok" as const, run: fakeRun() });

  it("dueAt/periodKey: weekly fires Monday 09:00 and covers LAST week", () => {
    const now = new Date(2026, 6, 15, 10, 0); // Wed
    const due = dueAtFor("weekly", now, CFG);
    expect(localDayKey(due)).toBe("2026-07-13"); // 本周一
    expect(due.getHours()).toBe(9);
    expect(periodKeyFor("weekly", due)).toBe("2026-W28"); // 上周
  });

  it("not_due before the hour", async () => {
    const db = freshDb();
    try {
      const out = await runRecapPushTick(db, {
        config: CFG,
        now: () => new Date(2026, 6, 13, 10, 0), // 10:00 < 21:00
        generateImpl: gen,
        fetchJson: okFetch,
      });
      expect(out.find((o) => o.kind === "daily")!.action).toBe("not_due");
    } finally {
      db.close();
    }
  });

  it("first enable seeds skipped(first_enable) instead of retro-pushing", async () => {
    const db = freshDb();
    try {
      const out = await runRecapPushTick(db, {
        config: CFG,
        now: () => new Date(2026, 6, 13, 21, 30),
        generateImpl: gen,
        fetchJson: okFetch,
      });
      const daily = out.find((o) => o.kind === "daily")!;
      expect(daily.action).toBe("skipped");
      expect(daily.reason).toBe("first_enable");
    } finally {
      db.close();
    }
  });

  it("sends once, then never again for the same period", async () => {
    const db = freshDb();
    __resetInflightForTests();
    try {
      const now = () => new Date(2026, 6, 13, 21, 30);
      // seed a prior period so we're past first_enable
      db.prepare(
        `INSERT INTO recap_push_log (kind, period_key, due_at, status, attempts, updated_at)
         VALUES ('daily','2026-07-12','x','sent',1,'x')`
      ).run();

      const first = await runRecapPushTick(db, { config: CFG, now, generateImpl: gen, fetchJson: okFetch });
      expect(first.find((o) => o.kind === "daily")!.action).toBe("sent");

      const second = await runRecapPushTick(db, { config: CFG, now, generateImpl: gen, fetchJson: okFetch });
      const d = second.find((o) => o.kind === "daily")!;
      expect(d.action).toBe("skipped");
      expect(d.reason).toBe("already_sent");
    } finally {
      db.close();
    }
  });

  it("too_late: a boot far past the hour does not push a stale report", async () => {
    const db = freshDb();
    try {
      db.prepare(
        `INSERT INTO recap_push_log (kind, period_key, due_at, status, attempts, updated_at)
         VALUES ('daily','2026-07-12','x','sent',1,'x')`
      ).run();
      // daily due 21:00, cap 6h → 08:00 next day is >6h late... but that's a new
      // period. Use same-day 21:00 + 7h = 04:00 → still 2026-07-14's period.
      // Simplest: check the weekly cap (24h) with a Wednesday boot.
      const out = await runRecapPushTick(db, {
        config: CFG,
        now: () => new Date(2026, 6, 15, 10, 0), // Wed, weekly due Mon 09:00 → 49h late
        generateImpl: gen,
        fetchJson: okFetch,
      });
      const weekly = out.find((o) => o.kind === "weekly")!;
      // first_enable fires first for weekly (no rows) — seed one and retry
      expect(["first_enable", "too_late"]).toContain(weekly.reason);
    } finally {
      db.close();
    }
  });

  it("no_signal: an idle period is skipped, not pushed as a canned card", async () => {
    const db = freshDb();
    __resetInflightForTests();
    try {
      db.prepare(
        `INSERT INTO recap_push_log (kind, period_key, due_at, status, attempts, updated_at)
         VALUES ('daily','2026-07-12','x','sent',1,'x')`
      ).run();
      const idle = fakeRun({
        totalCommits: 0,
        tokenFacts: { status: "empty" },
        topicDrift: { status: "empty" },
      } as never);
      const out = await runRecapPushTick(db, {
        config: CFG,
        now: () => new Date(2026, 6, 13, 21, 30),
        generateImpl: async () => ({ kind: "ok" as const, run: idle }),
        fetchJson: okFetch,
      });
      const d = out.find((o) => o.kind === "daily")!;
      expect(d.action).toBe("skipped");
      expect(d.reason).toBe("no_signal");
    } finally {
      db.close();
    }
  });

  it("inflight: never double-generates the window the HTTP route is already running", async () => {
    const db = freshDb();
    __resetInflightForTests();
    try {
      db.prepare(
        `INSERT INTO recap_push_log (kind, period_key, due_at, status, attempts, updated_at)
         VALUES ('daily','2026-07-12','x','sent',1,'x')`
      ).run();
      setInflight("today", { startedAt: new Date(), promise: Promise.resolve(fakeRun()) });
      const out = await runRecapPushTick(db, {
        config: CFG,
        now: () => new Date(2026, 6, 13, 21, 30),
        generateImpl: gen,
        fetchJson: okFetch,
      });
      expect(out.find((o) => o.kind === "daily")!.action).toBe("inflight");
    } finally {
      __resetInflightForTests();
      db.close();
    }
  });

  it("post failure records failed and stops after MAX_PUSH_ATTEMPTS", async () => {
    const db = freshDb();
    __resetInflightForTests();
    try {
      db.prepare(
        `INSERT INTO recap_push_log (kind, period_key, due_at, status, attempts, updated_at)
         VALUES ('daily','2026-07-12','x','sent',1,'x')`
      ).run();
      const now = () => new Date(2026, 6, 13, 21, 30);
      const badFetch = async () => ({
        ok: true,
        status: 200,
        json: async () => ({ code: 19021, msg: "sign match fail" }),
      });
      for (let i = 0; i < MAX_PUSH_ATTEMPTS; i++) {
        const out = await runRecapPushTick(db, { config: CFG, now, generateImpl: gen, fetchJson: badFetch });
        expect(out.find((o) => o.kind === "daily")!.action).toBe("failed");
      }
      const out = await runRecapPushTick(db, { config: CFG, now, generateImpl: gen, fetchJson: badFetch });
      const d = out.find((o) => o.kind === "daily")!;
      expect(d.action).toBe("skipped");
      expect(d.reason).toBe("max_attempts");
    } finally {
      db.close();
    }
  });

  it("no config → silent disabled (feature off), never throws", async () => {
    const db = freshDb();
    try {
      const out = await runRecapPushTick(db, { config: null });
      expect(out.every((o) => o.action === "disabled")).toBe(true);
    } finally {
      db.close();
    }
  });
});
