import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { computeSessionDuration } from "../src/workDuration/compute.js";
import {
  listWorkProjectDurationUsage,
  upsertWorkDurationRow,
} from "../src/workDuration/queries.js";
import { WORK_DURATION_IDLE_THRESHOLD_MS } from "../src/workDuration/types.js";
import { openDatabase } from "../src/store/open.js";

function makeDb() {
  return openDatabase(
    join(tmpdir(), `ai2nao-work-duration-${Date.now()}-${Math.random().toString(16).slice(2)}.db`)
  );
}

describe("work duration", () => {
  it("caps active time between adjacent events at the idle threshold", () => {
    const duration = computeSessionDuration([
      "2026-06-07T10:00:00.000Z",
      "2026-06-07T10:05:00.000Z",
      "2026-06-07T11:00:00.000Z",
      "2026-06-07T11:02:00.000Z",
    ]);

    expect(duration).toMatchObject({
      wallMs: 62 * 60_000,
      activeMs: 17 * 60_000,
      eventCount: 4,
    });
  });

  it("aggregates only full duration rows by project", () => {
    const db = makeDb();
    try {
      const now = "2026-06-07T12:00:00.000Z";
      upsertWorkDurationRow(db, {
        source: "codex",
        session_id: "s1",
        transcript_path: "/tmp/s1.jsonl",
        transcript_mtime_ms: 1,
        transcript_size_bytes: 2,
        cwd: "/work/app",
        project_key: "/work/app",
        project_path: "/work/app",
        identity_confidence: "high",
        title: "s1",
        started_at: "2026-06-07T10:00:00.000Z",
        ended_at: "2026-06-07T10:20:00.000Z",
        wall_ms: 20 * 60_000,
        active_ms: 12 * 60_000,
        event_count: 3,
        idle_threshold_ms: WORK_DURATION_IDLE_THRESHOLD_MS,
        duration_status: "full",
        parse_error: null,
        missing_since: null,
        source_seen_at: now,
        updated_at: now,
      });
      upsertWorkDurationRow(db, {
        source: "claude-code",
        session_id: "s2",
        transcript_path: "/tmp/s2.jsonl",
        transcript_mtime_ms: 1,
        transcript_size_bytes: 2,
        cwd: "/work/app",
        project_key: "/work/app",
        project_path: "/work/app",
        identity_confidence: "high",
        title: "s2",
        started_at: null,
        ended_at: null,
        wall_ms: 0,
        active_ms: 0,
        event_count: 0,
        idle_threshold_ms: WORK_DURATION_IDLE_THRESHOLD_MS,
        duration_status: "error",
        parse_error: "broken",
        missing_since: null,
        source_seen_at: now,
        updated_at: now,
      });

      const usage = listWorkProjectDurationUsage(db, {
        projectKeys: ["/work/app"],
        from: null,
        sources: ["codex", "claude-code"],
      }).get("/work/app");

      expect(usage).toMatchObject({
        activeMs: 12 * 60_000,
        wallMs: 20 * 60_000,
        knownSessions: 1,
        totalSessions: 2,
        errorSessions: 1,
        coverage: "partial",
      });
    } finally {
      db.close();
    }
  });
});
