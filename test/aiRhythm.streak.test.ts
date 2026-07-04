process.env.TZ = "Asia/Shanghai";

import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { openDatabase } from "../src/store/open.js";
import { upsertUserMessagesBatch } from "../src/agentUserMessages/store.js";
import { streakRhythm } from "../src/aiRhythm/queries.js";
import type {
  UpsertUserMessageInput,
  AgentUserMessageSource,
} from "../src/agentUserMessages/types.js";

function freshDb(): Database.Database {
  const dir = mkdtempSync(join(tmpdir(), "ai-rhythm-streak-"));
  return openDatabase(join(dir, "test.db"));
}

let seq = 0;
function row(
  eventAtUtc: string,
  isHuman = true,
  source: AgentUserMessageSource = "claude"
): UpsertUserMessageInput {
  seq++;
  return {
    source,
    sourceSessionId: `s${seq}`,
    sourceMessageKey: `m${seq}`,
    project: null,
    eventAtUtc,
    rawText: "x",
    rawPayloadJson: '"x"',
    cleanedText: isHuman ? "x" : "",
    isHuman,
    cleanerVersion: 1,
    parserVersion: 1,
    sourcePath: "/x",
  };
}
function seed(db: Database.Database, rows: UpsertUserMessageInput[]) {
  upsertUserMessagesBatch(db, rows, "2026-07-08T00:00:00Z");
}
// 所有消息用 T04:00:00Z = 北京当天 12:00,稳落在那一本地日内。
const at = (ymd: string) => `${ymd}T04:00:00Z`;
const NOW = (ymd: string) => new Date(`${ymd}T04:00:00Z`); // 北京同一天

describe("streakRhythm — 连续天数纪录(grace)", () => {
  it("今天活跃 → 当前连续含今天、todayActive=true", () => {
    const db = freshDb();
    seed(db, [row(at("2026-07-06")), row(at("2026-07-07")), row(at("2026-07-08"))]);
    const s = streakRhythm(db, { now: NOW("2026-07-08") });
    expect(s.longestStreak).toBe(3);
    expect(s.currentStreak).toBe(3);
    expect(s.todayActive).toBe(true);
    expect(s.lastActiveDay).toBe("2026-07-08");
    expect(s.totalActiveDays).toBe(3);
  });

  it("grace:最近活跃=昨天 → 当前连续保留、todayActive=false", () => {
    const db = freshDb();
    seed(db, [row(at("2026-07-06")), row(at("2026-07-07")), row(at("2026-07-08"))]);
    const s = streakRhythm(db, { now: NOW("2026-07-09") });
    expect(s.currentStreak).toBe(3);
    expect(s.todayActive).toBe(false);
    expect(s.longestStreak).toBe(3);
  });

  it("最近活跃 < 昨天 → 当前连续=0(已断),历史最长保留", () => {
    const db = freshDb();
    seed(db, [row(at("2026-07-06")), row(at("2026-07-07")), row(at("2026-07-08"))]);
    const s = streakRhythm(db, { now: NOW("2026-07-10") });
    expect(s.currentStreak).toBe(0);
    expect(s.longestStreak).toBe(3);
    expect(s.todayActive).toBe(false);
  });

  it("有间隔:历史最长 > 当前连续", () => {
    const db = freshDb();
    seed(db, [
      row(at("2026-07-01")),
      row(at("2026-07-02")),
      row(at("2026-07-03")), // 连续 3
      row(at("2026-07-08")), // 今天,单独 1
    ]);
    const s = streakRhythm(db, { now: NOW("2026-07-08") });
    expect(s.longestStreak).toBe(3);
    expect(s.currentStreak).toBe(1);
    expect(s.todayActive).toBe(true);
  });

  it("坏时间戳过滤 + 单日=1", () => {
    const db = freshDb();
    seed(db, [row(at("2026-07-08")), row("not-a-date")]);
    const s = streakRhythm(db, { now: NOW("2026-07-08") });
    expect(s.totalActiveDays).toBe(1);
    expect(s.currentStreak).toBe(1);
    expect(s.longestStreak).toBe(1);
  });

  it("is_human 过滤:只有注入消息 → 全 0", () => {
    const db = freshDb();
    seed(db, [row(at("2026-07-08"), false)]);
    const s = streakRhythm(db, { now: NOW("2026-07-08") });
    expect(s.totalActiveDays).toBe(0);
    expect(s.currentStreak).toBe(0);
    expect(s.lastActiveDay).toBeNull();
  });

  it("空库 → 全 0 / null / false", () => {
    const db = freshDb();
    const s = streakRhythm(db, { now: NOW("2026-07-08") });
    expect(s.currentStreak).toBe(0);
    expect(s.longestStreak).toBe(0);
    expect(s.todayActive).toBe(false);
    expect(s.lastActiveDay).toBeNull();
    expect(s.totalActiveDays).toBe(0);
  });
});
