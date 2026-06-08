import { WORK_DURATION_IDLE_THRESHOLD_MS } from "./types.js";

export type ComputedSessionDuration = {
  startedAt: Date;
  endedAt: Date;
  wallMs: number;
  activeMs: number;
  eventCount: number;
};

export function computeSessionDuration(
  timestamps: Array<Date | string | number | null | undefined>,
  idleThresholdMs = WORK_DURATION_IDLE_THRESHOLD_MS
): ComputedSessionDuration | null {
  const sorted = timestamps
    .map((value) => value instanceof Date ? value : value == null ? null : new Date(value))
    .filter((date): date is Date => Boolean(date && !Number.isNaN(date.getTime())))
    .map((date) => date.getTime())
    .sort((a, b) => a - b);
  if (sorted.length === 0) return null;

  let activeMs = 0;
  for (let idx = 1; idx < sorted.length; idx++) {
    const gap = sorted[idx] - sorted[idx - 1];
    if (gap > 0) activeMs += Math.min(gap, idleThresholdMs);
  }

  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  return {
    startedAt: new Date(first),
    endedAt: new Date(last),
    wallMs: Math.max(0, last - first),
    activeMs: Math.max(0, Math.min(activeMs, last - first)),
    eventCount: sorted.length,
  };
}
