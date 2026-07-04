import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { openDatabase } from "../src/store/open.js";
import { upsertUserMessagesBatch } from "../src/agentUserMessages/store.js";
import { commandLeaderboard } from "../src/aiRhythm/queries.js";
import type { UpsertUserMessageInput } from "../src/agentUserMessages/types.js";

function freshDb(): Database.Database {
  const dir = mkdtempSync(join(tmpdir(), "ai-rhythm-cmd-"));
  return openDatabase(join(dir, "test.db"));
}

let seq = 0;
function cmdRow(cleaned: string, isHuman = true): UpsertUserMessageInput {
  seq++;
  return {
    source: "claude",
    sourceSessionId: `s${seq}`,
    sourceMessageKey: `m${seq}`,
    project: null,
    eventAtUtc: "2026-07-08T04:00:00Z",
    rawText: cleaned,
    rawPayloadJson: '"x"',
    cleanedText: cleaned,
    isHuman,
    cleanerVersion: 1,
    parserVersion: 1,
    sourcePath: "/x",
  };
}
function seed(db: Database.Database, rows: UpsertUserMessageInput[]) {
  upsertUserMessagesBatch(db, rows, "2026-07-08T00:00:00Z");
}

describe("commandLeaderboard — 命令用量排行", () => {
  it("提名 + 路径守卫 + arg 不影响名", () => {
    const db = freshDb();
    seed(db, [
      cmdRow("/plan-eng-review"),
      cmdRow("/plan-eng-review 参数"),
      cmdRow("/graphify ./src"), // arg 里的 / 不影响 → graphify
      cmdRow("/tmp/a/b"), // 绝对路径首 token 含 / → 不计
      cmdRow("/"), // 单 / → 不计
    ]);
    const lb = commandLeaderboard(db);
    const byName = new Map(lb.commands.map((c) => [c.name, c.count]));
    expect(byName.get("plan-eng-review")).toBe(2);
    expect(byName.get("graphify")).toBe(1);
    expect(lb.commands.some((c) => c.name.includes("Users"))).toBe(false);
    expect(lb.totalCommands).toBe(3);
    expect(lb.distinctCommands).toBe(2);
  });

  it("平局按 name 升序;maxCount = 榜首", () => {
    const db = freshDb();
    seed(db, [cmdRow("/zebra"), cmdRow("/apple"), cmdRow("/apple")]);
    const lb = commandLeaderboard(db, { limit: 5 });
    expect(lb.commands.map((c) => c.name)).toEqual(["apple", "zebra"]);
    expect(lb.maxCount).toBe(2);
  });

  it("平局稳定:两命令同 count → name 升序", () => {
    const db = freshDb();
    seed(db, [cmdRow("/zebra"), cmdRow("/apple")]);
    const lb = commandLeaderboard(db);
    expect(lb.commands.map((c) => c.name)).toEqual(["apple", "zebra"]);
  });

  it("top N 截断,distinct 仍是全量", () => {
    const db = freshDb();
    seed(db, [
      cmdRow("/a"),
      cmdRow("/a"),
      cmdRow("/a"),
      cmdRow("/b"),
      cmdRow("/b"),
      cmdRow("/c"),
    ]);
    const lb = commandLeaderboard(db, { limit: 2 });
    expect(lb.commands.map((c) => c.name)).toEqual(["a", "b"]);
    expect(lb.distinctCommands).toBe(3);
    expect(lb.totalCommands).toBe(6);
  });

  it("is_human 过滤:注入命令不计", () => {
    const db = freshDb();
    seed(db, [cmdRow("/plan-eng-review", false)]);
    const lb = commandLeaderboard(db);
    expect(lb.totalCommands).toBe(0);
    expect(lb.commands).toEqual([]);
  });

  it("空库 → [] / 全 0", () => {
    const db = freshDb();
    const lb = commandLeaderboard(db);
    expect(lb.commands).toEqual([]);
    expect(lb.maxCount).toBe(0);
    expect(lb.totalCommands).toBe(0);
    expect(lb.distinctCommands).toBe(0);
  });
});
