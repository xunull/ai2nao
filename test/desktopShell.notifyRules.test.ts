import { describe, expect, it } from "vitest";
import {
  decideQuotaNotifications,
  decideRunNotifications,
  emptyNotifyState,
  QUOTA_CLEAR_PERCENT,
  QUOTA_LOW_PERCENT,
  type QuotaItem,
  type RunRow,
} from "../src/desktopShell/notifyRules.js";

/**
 * Which events are worth interrupting a human for.
 *
 * Every rule here was picked from this machine's real history, not from taste:
 *
 *   68,184 scheduled runs in 30 days   → "notify on every finished run" is 2,273
 *                                        interruptions a day. Not a near miss.
 *   8 `failed` runs, all-time          → failing tasks are a genuinely rare,
 *                                        genuinely interesting signal.
 *   cursor.projects.sync   675 partial, 0 success
 *   vscode.recent.sync     674 partial, 0 success
 *   git.line_churn.sync    669 partial, 0 success
 *   mac_apps.sync           30 partial, 0 success
 *                                      → `partial` is the STEADY STATE for these
 *                                        four. "status !== success" would fire
 *                                        ~70 times a day for tasks that are fine.
 *   3 failures of work.tokens.refresh within 2 minutes (2026-06-29 02:29→02:31)
 *                                      → without a cooldown, one broken task
 *                                        fires three times before you can react.
 *   63 manual triggers, all-time       → you asked for those; telling you they
 *                                        finished is welcome, not noise.
 *
 * The stakes are not comfort. If the shell is annoying on day one it gets muted,
 * and a muted shell cannot answer the only question Approach A exists to answer:
 * does always-on actually change how often you use this.
 */

const T0 = new Date("2026-07-29T10:00:00.000Z");

function run(over: Partial<RunRow> = {}): RunRow {
  return {
    id: 100,
    taskKey: "work.tokens.refresh",
    status: "success",
    trigger: "scheduled",
    startedAt: "2026-07-29T09:59:00.000Z",
    finishedAt: "2026-07-29T09:59:10.000Z",
    errorSummary: null,
    ...over,
  };
}

function quota(over: Partial<QuotaItem> = {}): QuotaItem {
  return {
    provider: "codex",
    itemKey: "7d",
    label: "7 天用量",
    remainingPercent: 100,
    ...over,
  };
}

/** A state that has already seen run #99, so new rows are genuinely new. */
function seenState(lastSeenRunId = 99) {
  return { ...emptyNotifyState(), lastSeenRunId };
}

describe("decideRunNotifications — what fires", () => {
  it("failed fires", () => {
    const out = decideRunNotifications({
      runs: [run({ id: 100, status: "failed", errorSummary: "database is locked" })],
      state: seenState(),
      now: T0,
    });
    expect(out.notifications).toHaveLength(1);
    expect(out.notifications[0]?.kind).toBe("task-failed");
    // The error has to be in the body, otherwise the notification says "something
    // broke" and you still have to go looking.
    expect(out.notifications[0]?.body).toContain("database is locked");
  });

  it("a manual run finishing fires — you asked for it", () => {
    const out = decideRunNotifications({
      runs: [run({ id: 100, status: "success", trigger: "manual", taskKey: "repos.scan" })],
      state: seenState(),
      now: T0,
    });
    expect(out.notifications).toHaveLength(1);
    expect(out.notifications[0]?.kind).toBe("manual-done");
  });

  it("success on a schedule does NOT fire — 68,184 of these in 30 days", () => {
    const out = decideRunNotifications({ runs: [run({ id: 100 })], state: seenState(), now: T0 });
    expect(out.notifications).toEqual([]);
  });

  it("partial does NOT fire — it is the steady state for four real tasks", () => {
    const out = decideRunNotifications({
      runs: [
        run({ id: 100, taskKey: "cursor.projects.sync", status: "partial" }),
        run({ id: 101, taskKey: "vscode.recent.sync", status: "partial" }),
        run({ id: 102, taskKey: "git.line_churn.sync", status: "partial" }),
        run({ id: 103, taskKey: "mac_apps.sync", status: "partial" }),
      ],
      state: seenState(),
      now: T0,
    });
    expect(out.notifications).toEqual([]);
  });

  it("a run still in flight does not fire — wait for it to land", () => {
    const out = decideRunNotifications({
      runs: [run({ id: 100, status: "running", finishedAt: null, trigger: "manual" })],
      state: seenState(),
      now: T0,
    });
    expect(out.notifications).toEqual([]);
    // ...and it must not be marked as seen, or we would never report its outcome.
    expect(out.state.lastSeenRunId).toBe(99);
  });

  it("a manual run that failed produces ONE notification, not two", () => {
    const out = decideRunNotifications({
      runs: [run({ id: 100, status: "failed", trigger: "manual", errorSummary: "boom" })],
      state: seenState(),
      now: T0,
    });
    expect(out.notifications).toHaveLength(1);
    expect(out.notifications[0]?.kind).toBe("task-failed");
  });
});

describe("decideRunNotifications — cooldown", () => {
  it("the same task failing repeatedly fires once per window", () => {
    // Replays 2026-06-29: work.tokens.refresh failed at 02:29:32, 02:30:25, 02:31:20.
    let state = seenState();
    const at = (iso: string) => new Date(iso);
    const fail = (id: number, startedAt: string) =>
      run({ id, status: "failed", startedAt, errorSummary: "no column named preview" });

    let out = decideRunNotifications({
      runs: [fail(100, "2026-06-29T02:29:32.531Z")],
      state,
      now: at("2026-06-29T02:29:40Z"),
    });
    expect(out.notifications).toHaveLength(1);
    state = out.state;

    out = decideRunNotifications({
      runs: [fail(101, "2026-06-29T02:30:25.595Z")],
      state,
      now: at("2026-06-29T02:30:30Z"),
    });
    expect(out.notifications).toEqual([]);
    state = out.state;

    out = decideRunNotifications({
      runs: [fail(102, "2026-06-29T02:31:20.622Z")],
      state,
      now: at("2026-06-29T02:31:30Z"),
    });
    expect(out.notifications).toEqual([]);
  });

  it("a different task failing in the same window still fires", () => {
    let state = seenState();
    let out = decideRunNotifications({
      runs: [run({ id: 100, status: "failed", taskKey: "work.tokens.refresh" })],
      state,
      now: T0,
    });
    expect(out.notifications).toHaveLength(1);
    state = out.state;

    out = decideRunNotifications({
      runs: [run({ id: 101, status: "failed", taskKey: "repos.scan" })],
      state,
      now: new Date(T0.getTime() + 60_000),
    });
    expect(out.notifications).toHaveLength(1);
  });

  it("fires again once the window has passed", () => {
    let state = seenState();
    let out = decideRunNotifications({
      runs: [run({ id: 100, status: "failed" })],
      state,
      now: T0,
    });
    state = out.state;
    out = decideRunNotifications({
      runs: [run({ id: 101, status: "failed" })],
      state,
      now: new Date(T0.getTime() + 31 * 60_000),
    });
    expect(out.notifications).toHaveLength(1);
  });

  it("manual runs are not rate limited — a second click deserves a second answer", () => {
    let state = seenState();
    let out = decideRunNotifications({
      runs: [run({ id: 100, trigger: "manual", taskKey: "repos.scan" })],
      state,
      now: T0,
    });
    expect(out.notifications).toHaveLength(1);
    state = out.state;
    out = decideRunNotifications({
      runs: [run({ id: 101, trigger: "manual", taskKey: "repos.scan" })],
      state,
      now: new Date(T0.getTime() + 5_000),
    });
    expect(out.notifications).toHaveLength(1);
  });

  it("does not accumulate cooldown entries forever", () => {
    let state = seenState();
    for (let i = 0; i < 50; i += 1) {
      state = decideRunNotifications({
        runs: [run({ id: 200 + i, status: "failed", taskKey: `task.${i}` })],
        state,
        now: new Date(T0.getTime() + i * 60 * 60_000),
      }).state;
    }
    // Entries older than the cooldown window carry no information; keeping them
    // would grow this object for the life of the process.
    expect(Object.keys(state.lastFiredAt).length).toBeLessThan(5);
  });
});

describe("decideRunNotifications — first run and window overflow", () => {
  it("first ever poll establishes a baseline and fires NOTHING", () => {
    // scheduled_task_runs has ~100k rows. Getting this wrong buries the user on
    // first launch — the single most expensive first impression available.
    const runs = Array.from({ length: 50 }, (_, i) =>
      run({ id: 1000 + i, status: "failed", errorSummary: "old news" })
    );
    const out = decideRunNotifications({ runs, state: emptyNotifyState(), now: T0 });
    expect(out.notifications).toEqual([]);
    expect(out.state.lastSeenRunId).toBe(1049);
  });

  it("window overflow rebuilds the baseline silently instead of replaying history", () => {
    // Laptop asleep overnight: far more than one page of runs happened. We cannot
    // prove we saw them all, and firing for a subset is worse than saying nothing.
    const runs = Array.from({ length: 50 }, (_, i) =>
      run({ id: 5000 + i, status: "failed", errorSummary: "while you slept" })
    );
    const out = decideRunNotifications({ runs, state: seenState(99), now: T0 });
    expect(out.notifications).toEqual([]);
    expect(out.state.lastSeenRunId).toBe(5049);
  });

  it("a normal poll that overlaps what we already saw does fire", () => {
    // The batch reaches back past lastSeenRunId, so nothing was missed.
    const runs = [
      run({ id: 98, status: "failed" }),
      run({ id: 99, status: "failed" }),
      run({ id: 100, status: "failed", errorSummary: "this one is new" }),
    ];
    const out = decideRunNotifications({ runs, state: seenState(99), now: T0 });
    expect(out.notifications).toHaveLength(1);
    expect(out.notifications[0]?.body).toContain("this one is new");
  });

  it("an empty poll changes nothing once a baseline exists", () => {
    const out = decideRunNotifications({ runs: [], state: seenState(99), now: T0 });
    expect(out.notifications).toEqual([]);
    expect(out.state.lastSeenRunId).toBe(99);
  });

  it("an empty FIRST poll still sets the baseline — caught in real-world testing", () => {
    // The bug this pins: on a fresh install the table is empty, so the first poll
    // returned early and left lastSeenRunId null. The next poll then saw the first
    // real runs, decided it was the first poll, and swallowed them as history.
    // Result: a brand new install never notifies about anything, ever.
    const first = decideRunNotifications({ runs: [], state: emptyNotifyState(), now: T0 });
    expect(first.state.lastSeenRunId).toBe(0);

    const second = decideRunNotifications({
      runs: [run({ id: 1, status: "failed", errorSummary: "磁盘满了" })],
      state: first.state,
      now: T0,
    });
    expect(second.notifications).toHaveLength(1);
    expect(second.notifications[0]?.body).toContain("磁盘满了");
  });
});

describe("decideQuotaNotifications — threshold with hysteresis", () => {
  it("fires when remaining drops below the low mark", () => {
    const out = decideQuotaNotifications({
      items: [quota({ remainingPercent: QUOTA_LOW_PERCENT - 1 })],
      state: emptyNotifyState(),
      now: T0,
    });
    expect(out.notifications).toHaveLength(1);
    expect(out.notifications[0]?.kind).toBe("quota-low");
    expect(out.notifications[0]?.body).toContain("7 天用量");
  });

  it("does not fire again while it stays low — the latch", () => {
    let state = emptyNotifyState();
    let out = decideQuotaNotifications({
      items: [quota({ remainingPercent: 19 })],
      state,
      now: T0,
    });
    expect(out.notifications).toHaveLength(1);
    state = out.state;

    for (const pct of [18, 15, 9, 3, 1]) {
      out = decideQuotaNotifications({ items: [quota({ remainingPercent: pct })], state, now: T0 });
      expect(out.notifications).toEqual([]);
      state = out.state;
    }
  });

  it("hovering around the threshold does not chatter", () => {
    // The failure mode this prevents: a value oscillating across 20% fires on
    // every crossing, which is exactly the pattern that gets notifications muted.
    let state = emptyNotifyState();
    let fired = 0;
    for (const pct of [19, 21, 19, 21, 19, 22, 18]) {
      const out = decideQuotaNotifications({
        items: [quota({ remainingPercent: pct })],
        state,
        now: T0,
      });
      fired += out.notifications.length;
      state = out.state;
    }
    expect(fired).toBe(1);
  });

  it("re-arms only after recovering past the clear mark", () => {
    let state = emptyNotifyState();
    state = decideQuotaNotifications({
      items: [quota({ remainingPercent: 10 })],
      state,
      now: T0,
    }).state;

    // Reset happened, quota is full again.
    state = decideQuotaNotifications({
      items: [quota({ remainingPercent: QUOTA_CLEAR_PERCENT + 1 })],
      state,
      now: T0,
    }).state;

    const out = decideQuotaNotifications({
      items: [quota({ remainingPercent: 5 })],
      state,
      now: T0,
    });
    expect(out.notifications).toHaveLength(1);
  });

  it("tracks each provider/item independently", () => {
    const out = decideQuotaNotifications({
      items: [
        quota({ provider: "codex", itemKey: "7d", remainingPercent: 5 }),
        quota({ provider: "kimi", itemKey: "5h", remainingPercent: 90 }),
        quota({ provider: "claude", itemKey: "5h", remainingPercent: 2 }),
      ],
      state: emptyNotifyState(),
      now: T0,
    });
    expect(out.notifications).toHaveLength(2);
  });

  it("ignores items with no percentage — plan/membership rows are not quotas", () => {
    // provider_usage really does carry rows like codex/plan with
    // remaining_percent = null. Treating null as 0 would fire constantly.
    const out = decideQuotaNotifications({
      items: [quota({ itemKey: "plan", label: "当前档位", remainingPercent: null })],
      state: emptyNotifyState(),
      now: T0,
    });
    expect(out.notifications).toEqual([]);
  });
});
