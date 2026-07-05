process.env.TZ = "Asia/Shanghai";

import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { openDatabase } from "../src/store/open.js";
import { upsertUserMessagesBatch } from "../src/agentUserMessages/store.js";
import { personalRecords } from "../src/aiRhythm/queries.js";
import type { UpsertUserMessageInput } from "../src/agentUserMessages/types.js";

function freshDb(): Database.Database {
  const dir = mkdtempSync(join(tmpdir(), "ai-rhythm-rec-"));
  return openDatabase(join(dir, "test.db"));
}

let seq = 0;
// char_len = [...cleanedText].length,用 "x".repeat(len) 控制。
function row(eventAtUtc: string, len = 1, isHuman = true): UpsertUserMessageInput {
  seq++;
  return {
    source: "claude",
    sourceSessionId: `s${seq}`,
    sourceMessageKey: `m${seq}`,
    project: null,
    eventAtUtc,
    rawText: "x",
    rawPayloadJson: '"x"',
    cleanedText: isHuman ? "x".repeat(len) : "",
    isHuman,
    cleanerVersion: 1,
    parserVersion: 1,
    sourcePath: "/x",
  };
}
function seed(db: Database.Database, rows: UpsertUserMessageInput[]) {
  upsertUserMessagesBatch(db, rows, "2026-07-08T00:00:00Z");
}
const at = (ymd: string) => `${ymd}T04:00:00Z`; // 北京当天 12:00

describe("personalRecords — 个人纪录/极值", () => {
  it("最忙一天 / 一小时最多 / 总量 / 起始日 / 最大输入", () => {
    const db = freshDb();
    seed(db, [
      row(at("2026-07-06"), 10),
      row(at("2026-07-06"), 20),
      row(at("2026-07-06"), 500), // 07-06 共 3 条,都在 12:00
      row(at("2026-07-07"), 30), // 07-07 1 条
    ]);
    const r = personalRecords(db);
    expect(r.busiestDay).toEqual({ day: "2026-07-06", count: 3 });
    expect(r.peakHour).toEqual({ hour: "2026-07-06 12:00", count: 3 });
    expect(r.total).toBe(4);
    expect(r.firstDay).toBe("2026-07-06");
    expect(r.maxCharLen).toBe(500);
  });

  it("平局取最早(最忙一天)", () => {
    const db = freshDb();
    seed(db, [
      row(at("2026-07-06")),
      row(at("2026-07-06")),
      row(at("2026-07-08")),
      row(at("2026-07-08")),
    ]);
    expect(personalRecords(db).busiestDay).toEqual({ day: "2026-07-06", count: 2 });
  });

  it("坏时间戳(records 排除)+ is_human 过滤", () => {
    const db = freshDb();
    seed(db, [
      row(at("2026-07-06")), // good
      row("not-a-date"), // 坏 ts:不进 busiestDay,但计入 total
      row(at("2026-07-06"), 1, false), // 注入:全不计
    ]);
    const r = personalRecords(db);
    expect(r.busiestDay).toEqual({ day: "2026-07-06", count: 1 });
    expect(r.total).toBe(2); // good + 坏 ts(都 is_human);注入不计
  });

  it("空库 → null / 0", () => {
    const db = freshDb();
    const r = personalRecords(db);
    expect(r.busiestDay).toBeNull();
    expect(r.peakHour).toBeNull();
    expect(r.total).toBe(0);
    expect(r.firstDay).toBeNull();
    expect(r.maxCharLen).toBe(0);
  });
});
