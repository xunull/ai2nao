process.env.TZ = "Asia/Shanghai";

import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { openDatabase } from "../src/store/open.js";
import { upsertUserMessagesBatch } from "../src/agentUserMessages/store.js";
import { weeklySourceMix } from "../src/aiRhythm/queries.js";
import type {
  UpsertUserMessageInput,
  AgentUserMessageSource,
} from "../src/agentUserMessages/types.js";

function freshDb(): Database.Database {
  const dir = mkdtempSync(join(tmpdir(), "ai-rhythm-src-"));
  return openDatabase(join(dir, "test.db"));
}

let seq = 0;
function row(
  eventAtUtc: string,
  source: AgentUserMessageSource,
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
const at = (ymd: string) => `${ymd}T04:00:00Z`; // 北京当天 12:00

describe("weeklySourceMix — 三源迁移周趋势", () => {
  it("周分桶 + 三源 pivot + 排序", () => {
    const db = freshDb();
    seed(db, [
      row(at("2026-07-06"), "codex"), // 周 W1
      row(at("2026-07-06"), "codex"),
      row(at("2026-07-07"), "claude"), // 同周
      row(at("2026-07-13"), "claude"), // 下一周 W2
    ]);
    const { weeks } = weeklySourceMix(db);
    expect(weeks.length).toBe(2);
    expect(weeks[0]).toMatchObject({ codex: 2, claude: 1, opencode: 0, total: 3 });
    expect(weeks[1]).toMatchObject({ claude: 1, codex: 0, total: 1 });
    // 排序:字典序 = 时间序
    expect(weeks[0].week < weeks[1].week).toBe(true);
  });

  it("坏时间戳过滤 + is_human 过滤", () => {
    const db = freshDb();
    seed(db, [
      row(at("2026-07-06"), "claude"),
      row("not-a-date", "codex"), // 坏 ts → 剔除
      row(at("2026-07-06"), "codex", false), // 注入 → 不计
    ]);
    const { weeks } = weeklySourceMix(db);
    expect(weeks.length).toBe(1);
    expect(weeks[0]).toMatchObject({ claude: 1, codex: 0, total: 1 });
  });

  it("空库 → weeks []", () => {
    const db = freshDb();
    const { weeks } = weeklySourceMix(db);
    expect(weeks).toEqual([]);
  });
});
