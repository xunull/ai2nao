// 范围比较走 event_at_utc 字符串;pin 北京(与 timeline 一致),避免 CI 漂移。
process.env.TZ = "Asia/Shanghai";

import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { openDatabase } from "../src/store/open.js";
import { upsertUserMessagesBatch } from "../src/agentUserMessages/store.js";
import { userMessageList } from "../src/agentUserMessages/queries.js";
import type {
  UpsertUserMessageInput,
  AgentUserMessageSource,
} from "../src/agentUserMessages/types.js";

function freshDb(): Database.Database {
  const dir = mkdtempSync(join(tmpdir(), "aum-list-"));
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

const NOW = new Date("2026-07-08T12:00:00+08:00"); // = 2026-07-08T04:00:00Z

describe("userMessageList — 窗口浏览(全源、逆序、keyset)", () => {
  it("最新在前 + 全源(不受 source 影响)", () => {
    const db = freshDb();
    seed(db, [
      row("claude", "2026-07-05T02:00:00Z"),
      row("codex", "2026-07-06T02:00:00Z"),
      row("opencode", "2026-07-07T02:00:00Z"),
    ]);
    const p = userMessageList(db, { window: "1w", now: NOW });
    expect(p.items).toHaveLength(3);
    // 最新在前;三源都在(全源)
    expect(p.items.map((i) => i.source)).toEqual(["opencode", "codex", "claude"]);
  });

  it("codex#2:同 event_at_utc 多行,复合游标翻页不跳不重", () => {
    const db = freshDb();
    // 3 行同一时间戳(插入序 → id 1,2,3)
    seed(db, [
      row("claude", "2026-07-05T02:00:00Z"),
      row("codex", "2026-07-05T02:00:00Z"),
      row("opencode", "2026-07-05T02:00:00Z"),
    ]);
    const p1 = userMessageList(db, { window: "1w", limit: 2, now: NOW });
    expect(p1.items.map((i) => i.id)).toEqual([3, 2]); // event_at 相同 → id DESC
    expect(p1.nextBefore).toEqual({ eventAt: "2026-07-05T02:00:00Z", id: 2 });

    const p2 = userMessageList(db, {
      window: "1w",
      limit: 2,
      before: p1.nextBefore!.eventAt,
      beforeId: p1.nextBefore!.id,
      now: NOW,
    });
    expect(p2.items.map((i) => i.id)).toEqual([1]); // 同时间戳剩余行不被跳过
    expect(p2.nextBefore).toBeNull();
    // 两页拼起 = 全部 3 行,无重叠无丢失
    expect([...p1.items, ...p2.items].map((i) => i.id)).toEqual([3, 2, 1]);
  });

  it("范围 1w:窗口外不计", () => {
    const db = freshDb();
    seed(db, [
      row("claude", "2026-07-05T02:00:00Z"), // 窗口内
      row("claude", "2026-06-20T02:00:00Z"), // 1 周前之外
    ]);
    expect(userMessageList(db, { window: "1w", now: NOW }).items).toHaveLength(1);
  });

  it("范围 today:今天 0 点起(昨天不计)", () => {
    const db = freshDb();
    seed(db, [
      row("claude", "2026-07-08T02:00:00Z"), // 北京 07-08 10:00 今天
      row("claude", "2026-07-07T02:00:00Z"), // 昨天
    ]);
    expect(userMessageList(db, { window: "today", now: NOW }).items).toHaveLength(1);
  });

  it("is_human 过滤(注入不计)", () => {
    const db = freshDb();
    seed(db, [
      row("claude", "2026-07-05T02:00:00Z"),
      row("claude", "2026-07-05T03:00:00Z", false), // 注入
    ]);
    expect(userMessageList(db, { window: "1w", now: NOW }).items).toHaveLength(1);
  });

  it("limit 夹取 + 满页 nextBefore 非空、再取到底返空", () => {
    const db = freshDb();
    seed(db, [
      row("claude", "2026-07-05T02:00:00Z"),
      row("claude", "2026-07-05T03:00:00Z"),
    ]);
    const p1 = userMessageList(db, { window: "1w", limit: 2, now: NOW });
    expect(p1.items).toHaveLength(2);
    expect(p1.nextBefore).not.toBeNull(); // 恰满页 → 给游标
    const p2 = userMessageList(db, {
      window: "1w",
      limit: 2,
      before: p1.nextBefore!.eventAt,
      beforeId: p1.nextBefore!.id,
      now: NOW,
    });
    expect(p2.items).toHaveLength(0);
    expect(p2.nextBefore).toBeNull();
  });

  it("text = cleaned_text;空窗口 → [] + null", () => {
    const db = freshDb();
    seed(db, [row("claude", "2026-07-05T02:00:00Z")]);
    expect(userMessageList(db, { window: "1w", now: NOW }).items[0].text).toBe("x");

    const empty = userMessageList(db, { window: "today", now: NOW });
    expect(empty.items).toEqual([]);
    expect(empty.nextBefore).toBeNull();
  });
});
