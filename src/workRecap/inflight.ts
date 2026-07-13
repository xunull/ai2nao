import type { WorkRecapRun, WorkRecapWindow } from "./types.js";

/**
 * Process-wide in-flight tracker for recap generation.
 *
 * This used to live inside `routes.ts`, which meant it only guarded the HTTP
 * path. The scheduled push task calls `generateRecap()` directly, so it would
 * have bypassed the guard entirely: the 21:00 tick colliding with a manual
 * 「生成 recap」 click = two LLM calls, two `work_recap_runs` rows, double spend.
 * Hoisting it here lets BOTH the route and the tick share one guard.
 *
 * Per-process, not durable across restarts (a crashed generate can't be
 * in-flight anyway).
 */
export type Inflight = {
  startedAt: Date;
  promise: Promise<WorkRecapRun>;
};

const inflight = new Map<WorkRecapWindow, Inflight>();

export function getInflight(windowKey: WorkRecapWindow): Inflight | undefined {
  return inflight.get(windowKey);
}

export function isInflight(windowKey: WorkRecapWindow): boolean {
  return inflight.has(windowKey);
}

export function setInflight(windowKey: WorkRecapWindow, entry: Inflight): void {
  inflight.set(windowKey, entry);
}

export function clearInflight(windowKey: WorkRecapWindow): void {
  inflight.delete(windowKey);
}

export function __resetInflightForTests(): void {
  inflight.clear();
}
