// localtime 分桶用 strftime('localtime');pin 北京(UTC+8,与 timeline 测试一致),避免 CI 漂移。
process.env.TZ = "Asia/Shanghai";

import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { openDatabase } from "../src/store/open.js";
import { upsertUserMessagesBatch } from "../src/agentUserMessages/store.js";
import { heatmapRhythm } from "../src/aiRhythm/queries.js";
import type {
  UpsertUserMessageInput,
  AgentUserMessageSource,
} from "../src/agentUserMessages/types.js";

function freshDb(): Database.Database {
  const dir = mkdtempSync(join(tmpdir(), "ai-rhythm-"));
  return openDatabase(join(dir, "test.db"));
}

let seq = 0;
function row(
  source: AgentUserMessageSource,
  eventAtUtc: string,
  isHuman = true
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

// 参照日:2026-07-08 = 周三(%w=3);07-05 周日(%w=0);07-06 周一(%w=1)。
describe("heatmapRhythm — 作息热力图(weekday × hour)", () => {
  it("分桶 + localtime + is_human + 全源;CAST 出 number", () => {
    const db = freshDb();
    seed(db, [
      row("claude", "2026-07-08T02:00:00Z"), // 北京 周三 10:00
      row("codex", "2026-07-08T02:00:00Z"), // 周三 10:00(同格,全源)
      row("claude", "2026-07-08T03:00:00Z"), // 周三 11:00
      row("claude", "2026-07-08T02:30:00Z", false), // 注入,不计
    ]);
    const h = heatmapRhythm(db);
    const c1 = h.cells.find((c) => c.weekday === 3 && c.hour === 10)!;
    expect(c1.count).toBe(2);
    expect(typeof c1.weekday).toBe("number"); // CAST(... AS INTEGER)
    expect(typeof c1.hour).toBe("number");
    expect(h.cells.find((c) => c.weekday === 3 && c.hour === 11)!.count).toBe(1);
    expect(h.total).toBe(3);
    expect(h.maxCount).toBe(2);
    expect(h.peak).toEqual({ weekday: 3, hour: 10, count: 2 });
    expect(typeof h.generatedAt).toBe("string");
  });

  it("peak tie-break:同 count → 周一起最早 → hour 最早", () => {
    const db = freshDb();
    seed(db, [
      row("claude", "2026-07-05T01:00:00Z"), // 北京 周日 09:00 → weekday=0
      row("claude", "2026-07-06T00:00:00Z"), // 北京 周一 08:00 → weekday=1
    ]);
    const h = heatmapRhythm(db);
    expect(h.maxCount).toBe(1);
    // 平局:周一(Mon-first 序 0)赢过周日(序 6)
    expect(h.peak).toEqual({ weekday: 1, hour: 8, count: 1 });
  });

  it("坏时间戳(不可解析)→ 被过滤,不产 null 格", () => {
    const db = freshDb();
    seed(db, [
      row("claude", "2026-07-08T02:00:00Z"), // good
      row("claude", "not-a-date"), // bad → strftime NULL → WHERE 剔除
    ]);
    const h = heatmapRhythm(db);
    expect(h.total).toBe(1);
    expect(h.cells.every((c) => c.weekday != null && c.hour != null)).toBe(true);
  });

  it("空库 → cells=[], maxCount=0, total=0, peak=null(前端据此防除零)", () => {
    const db = freshDb();
    const h = heatmapRhythm(db);
    expect(h.cells).toEqual([]);
    expect(h.maxCount).toBe(0);
    expect(h.total).toBe(0);
    expect(h.peak).toBeNull();
  });
});
