// 分桶用 strftime 'localtime' + iterateBuckets 用 Node TZ;pin 北京(D8),避免 CI 漂移。
process.env.TZ = "Asia/Shanghai";

import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { openDatabase } from "../src/store/open.js";
import { upsertUserMessagesBatch } from "../src/agentUserMessages/store.js";
import { userMessageTimeline } from "../src/agentUserMessages/queries.js";
import type {
  UpsertUserMessageInput,
  AgentUserMessageSource,
} from "../src/agentUserMessages/types.js";

function freshDb(): Database.Database {
  const dir = mkdtempSync(join(tmpdir(), "aum-timeline-"));
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

// 北京正午,便于推理:1w → day 粒度;windowToRange.from = 7 天前正午。
const NOW = new Date("2026-07-08T12:00:00+08:00"); // = 2026-07-08T04:00:00Z

describe("userMessageTimeline — 窗口 + 自适应粒度 + zero-fill", () => {
  it("1w → day 粒度,桶连续且 zero-fill", () => {
    const db = freshDb();
    seed(db, [row("claude", "2026-07-05T02:00:00Z")]); // 北京 07-05 10:00
    const t = userMessageTimeline(db, { window: "1w", now: NOW });
    expect(t.granularity).toBe("day");
    // 桶连续(每桶 end === 下一桶 start)
    for (let i = 1; i < t.buckets.length; i++) {
      expect(t.buckets[i].bucketStart).toBe(t.buckets[i - 1].bucketEnd);
    }
    // 只有 07-05 那桶有 1 条,其余 zero-fill
    expect(t.windowTotal).toBe(1);
    expect(t.buckets.filter((b) => b.total > 0)).toHaveLength(1);
    expect(t.buckets.some((b) => b.total === 0)).toBe(true);
  });

  it("D3 anchor 向下:首个半截桶的消息不丢(零丢弃)", () => {
    const db = freshDb();
    // windowToRange.from = 2026-07-01T04:00Z(北京 07-01 12:00);消息在其后 1 小时,
    // 落在「from 到首个整桶」的半截区。anchor 向下后首桶=07-01 00:00 北京,应含它。
    seed(db, [row("claude", "2026-07-01T05:00:00Z")]); // 北京 07-01 13:00
    const t = userMessageTimeline(db, { window: "1w", now: NOW });
    expect(t.windowTotal).toBe(1); // 不吸附会被 orphan 丢成 0
    // 首桶覆盖 07-01(北京日)
    expect(t.buckets[0].bucketStart).toBe("2026-06-30T16:00:00.000Z"); // = 2026-07-01 00:00 +08
    expect(t.buckets[0].total).toBe(1);
  });

  it("三源分列 + is_human 过滤(注入不计)", () => {
    const db = freshDb();
    seed(db, [
      row("claude", "2026-07-05T02:00:00Z"),
      row("codex", "2026-07-05T03:00:00Z"),
      row("opencode", "2026-07-05T04:00:00Z"),
      row("claude", "2026-07-05T05:00:00Z", false), // 注入 → 不计
    ]);
    const t = userMessageTimeline(db, { window: "1w", now: NOW });
    const day = t.buckets.find((b) => b.total > 0)!;
    expect(day).toMatchObject({ claude: 1, codex: 1, opencode: 1, total: 3 });
    expect(t.windowTotal).toBe(3);
  });

  it("source 过滤只统计该源", () => {
    const db = freshDb();
    seed(db, [
      row("claude", "2026-07-05T02:00:00Z"),
      row("codex", "2026-07-05T03:00:00Z"),
    ]);
    const t = userMessageTimeline(db, { window: "1w", source: "claude", now: NOW });
    expect(t.windowTotal).toBe(1);
  });

  it("环比:上一等长窗口计数 + deltaRatio", () => {
    const db = freshDb();
    // 本窗口 [~07-01, 07-08):2 条;上一窗口 [~06-24, ~07-01):1 条
    seed(db, [
      row("claude", "2026-07-05T02:00:00Z"),
      row("claude", "2026-07-06T02:00:00Z"),
      row("claude", "2026-06-27T02:00:00Z"), // 上一窗口
    ]);
    const t = userMessageTimeline(db, { window: "1w", now: NOW });
    expect(t.windowTotal).toBe(2);
    expect(t.previousWindowTotal).toBe(1);
    expect(t.deltaRatio).toBeCloseTo(1); // (2-1)/1
  });

  it("prev 为 0 → deltaRatio null", () => {
    const db = freshDb();
    seed(db, [row("claude", "2026-07-05T02:00:00Z")]);
    const t = userMessageTimeline(db, { window: "1w", now: NOW });
    expect(t.previousWindowTotal).toBe(0);
    expect(t.deltaRatio).toBeNull();
  });

  it("末桶 partial(to=now 落在桶中)→ lastBucketPartial true", () => {
    const db = freshDb();
    seed(db, [row("claude", "2026-07-05T02:00:00Z")]);
    const t = userMessageTimeline(db, { window: "1w", now: NOW });
    // 末桶 end = 07-09 00:00 北京 > now(07-08 12:00)
    expect(t.lastBucketPartial).toBe(true);
  });

  it("1d → hour 粒度", () => {
    const db = freshDb();
    seed(db, [row("claude", "2026-07-08T02:00:00Z")]); // 北京 07-08 10:00
    const t = userMessageTimeline(db, { window: "1d", now: NOW });
    expect(t.granularity).toBe("hour");
    expect(t.windowTotal).toBe(1);
  });

  it("今天:小时粒度 + 裁掉最早消息前的空整点(6 点才有消息就从 6 点起)", () => {
    const db = freshDb();
    seed(db, [
      row("claude", "2026-07-07T22:00:00Z"), // 北京 07-08 06:00
      row("codex", "2026-07-08T00:00:00Z"), // 北京 07-08 08:00
    ]);
    const t = userMessageTimeline(db, { window: "today", now: NOW });
    expect(t.granularity).toBe("hour");
    expect(t.windowTotal).toBe(2);
    // 首桶 = 06:00(裁掉今天 00:00–05:00 的空整点),整点起
    expect(t.buckets[0].bucketStart).toBe("2026-07-07T22:00:00.000Z"); // 07-08 06:00 +08
    expect(t.buckets[0].total).toBe(1);
    for (let i = 1; i < t.buckets.length; i++) {
      expect(t.buckets[i].bucketStart).toBe(t.buckets[i - 1].bucketEnd);
    }
  });

  it("今天:全天无消息 → 只留当前整点,不出空图", () => {
    const db = freshDb();
    seed(db, [row("claude", "2026-07-06T02:00:00Z")]); // 两天前
    const t = userMessageTimeline(db, { window: "today", now: NOW });
    expect(t.windowTotal).toBe(0);
    expect(t.buckets.length).toBe(1);
  });
});
