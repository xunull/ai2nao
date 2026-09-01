// 分桶用 strftime 'localtime';pin 北京时区,避免 CI 机器时区导致的按天漂移(同 workTokensTrend)。
process.env.TZ = "Asia/Shanghai";

import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { openDatabase } from "../src/store/open.js";
import { upsertUserMessagesBatch } from "../src/agentUserMessages/store.js";
import { userMessageAnalytics, userMessageTimeline } from "../src/agentUserMessages/queries.js";
import type { UpsertUserMessageInput, AgentUserMessageSource } from "../src/agentUserMessages/types.js";

function freshDb(): Database.Database {
  const dir = mkdtempSync(join(tmpdir(), "aum-analytics-"));
  return openDatabase(join(dir, "test.db"));
}

let seq = 0;
function row(
  source: AgentUserMessageSource,
  cleaned: string,
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
    rawText: cleaned || "raw",
    rawPayloadJson: JSON.stringify(cleaned),
    cleanedText: cleaned,
    isHuman,
    cleanerVersion: 1,
    parserVersion: 1,
    sourcePath: "/x",
  };
}

describe("userMessageAnalytics — 跨源统计 + 按天(只算 is_human)", () => {
  it("totals 按源分组、byDay 按本地日分桶,注入(is_human=0)不计", () => {
    const db = freshDb();
    upsertUserMessagesBatch(
      db,
      [
        // 04:00Z = 北京 12:00 → 当天
        row("claude", "问题一", "2026-07-01T04:00:00Z"),
        row("claude", "问题二", "2026-07-01T05:00:00Z"),
        row("opencode", "问题三", "2026-07-02T04:00:00Z"),
        row("codex", "", "2026-07-02T04:00:00Z", false), // 注入留底 → 不计
      ],
      "2026-07-03T00:00:00Z"
    );

    const a = userMessageAnalytics(db);
    // totals:claude 2 / opencode 1;codex(纯注入)不出现
    expect(a.totals).toEqual([
      { source: "claude", count: 2, charSum: 6 },
      { source: "opencode", count: 1, charSum: 3 },
    ]);
    // byDay:两天,共 3 条 human
    expect(a.byDay).toEqual([
      { day: "2026-07-01", count: 2 },
      { day: "2026-07-02", count: 1 },
    ]);
  });

  it("source 过滤只统计该源", () => {
    const db = freshDb();
    upsertUserMessagesBatch(
      db,
      [row("claude", "a", "2026-07-01T04:00:00Z"), row("opencode", "b", "2026-07-01T04:00:00Z")],
      "2026-07-03T00:00:00Z"
    );
    const a = userMessageAnalytics(db, { source: "claude" });
    expect(a.totals).toEqual([{ source: "claude", count: 1, charSum: 1 }]);
    expect(a.byDay).toEqual([{ day: "2026-07-01", count: 1 }]);
  });
});

describe("userMessageTimeline — 每个源都要计进桶,新源不许静默消失", () => {
  /**
   * 回归:此前桶是固定四字段 + `if/else if` 链,`AgentUserMessageSource` 加成员时
   * 新源既不匹配任何分支、也不进 total —— **从图上静默消失,且全套测试照样绿**。
   * hermes 入库时真踩了:152 条人类消息一条不显示。
   *
   * 现在 SourceCounts 是 Record<AgentUserMessageSource, number>,漏键 tsc 会报;
   * 这条测试守住运行时那一半(累加与求和真的覆盖了每一个源)。
   */
  it("每个已知源各来一条:五个源都进桶,且 total == 各源之和", () => {
    const db = freshDb();
    const sources: AgentUserMessageSource[] = [
      "claude",
      "codex",
      "opencode",
      "kimi",
      "hermes",
    ];
    upsertUserMessagesBatch(
      db,
      sources.map((s) => row(s, `来自 ${s}`, "2026-07-01T04:00:00Z")),
      "2026-07-02T00:00:00Z"
    );

    const t = userMessageTimeline(db, {
      window: "1m",
      now: new Date("2026-07-05T00:00:00Z"),
    });

    const hit = t.buckets.filter((b) => b.total > 0);
    expect(hit).toHaveLength(1);
    const b = hit[0]!;
    // 逐源都得是 1 —— 少任何一个都说明该源没被累加进去。
    for (const s of sources) {
      expect(b[s], `源 ${s} 没有计进桶`).toBe(1);
    }
    // total 必须等于各源之和,而不是某几个源的和。
    const sum = sources.reduce((a, s) => a + b[s], 0);
    expect(b.total).toBe(sum);
    expect(b.total).toBe(sources.length);
    expect(t.windowTotal).toBe(sources.length);
  });
});
