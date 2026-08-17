import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { migrate } from "../src/store/migrations.js";
import { searchUserMessages } from "../src/agentUserMessages/queries.js";
import { upsertUserMessagesBatch } from "../src/agentUserMessages/store.js";
import type { UpsertUserMessageInput } from "../src/agentUserMessages/types.js";

/**
 * 搜索的 role 过滤(V53)。
 *
 * **硬约束:不传 role 时结果与 V53 之前逐条一致。** /agent-messages 今天已经能用,
 * 加 AI 内容不能让它变难用 —— AI 消息是人类消息的 5.76 倍(实测 13414 : 2299),
 * 中位长度只有 87 字,默认混进去会淹没结果。
 *
 * "user" 走 `is_human = 1` 而不是 `role = 'user'`:表里还留着 4.9 万条 role='user'
 * 但 is_human=0 的注入噪音行(留底,从不删),用 role 筛会把它们放进结果。
 */
describe("searchUserMessages —— role 过滤", () => {
  let db: Database.Database;
  const now = "2026-08-17T00:00:00.000Z";

  const row = (
    key: string,
    text: string,
    o: { role: "user" | "assistant"; isHuman: boolean; anchor?: string }
  ): UpsertUserMessageInput => ({
    source: "claude",
    sourceSessionId: "proj:sess",
    sourceMessageKey: key,
    project: "proj",
    eventAtUtc: `2026-08-1${key.length % 9}T00:00:00.000Z`,
    rawText: text,
    rawPayloadJson: JSON.stringify(text),
    cleanedText: text,
    isHuman: o.isHuman,
    cleanerVersion: 4,
    parserVersion: 1,
    sourcePath: null,
    role: o.role,
    answeringUserKey: o.anchor ?? null,
  });

  beforeEach(() => {
    db = new Database(":memory:");
    migrate(db);
    upsertUserMessagesBatch(
      db,
      [
        row("u-1", "帮我修一下 watermark 的问题", { role: "user", isHuman: true }),
        // 留底噪音:role='user' 但 is_human=0,搜索永远不该返回它。
        row("u-noise", "watermark 注入噪音", { role: "user", isHuman: false }),
        row("a-1", "watermark 是已处理干净的时间点", {
          role: "assistant",
          isHuman: false,
          anchor: "u-1",
        }),
        row("a-2", "另一段关于 watermark 的解释", {
          role: "assistant",
          isHuman: false,
          anchor: "u-1",
        }),
      ],
      now
    );
  });
  afterEach(() => db?.close());

  const keys = (hits: { id: number }[]) =>
    hits
      .map(
        (h) =>
          (
            db
              .prepare(
                "SELECT source_message_key AS k FROM agent_user_messages WHERE id = ?"
              )
              .get(h.id) as { k: string }
          ).k
      )
      .sort();

  describe("默认行为(不传 role)", () => {
    it("只返回 is_human=1 的行 —— AI 的话和留底噪音都不进", () => {
      const hits = searchUserMessages(db, { q: "watermark" });
      expect(keys(hits)).toEqual(["u-1"]);
    });

    it("与显式传 role='user' 逐条相同", () => {
      const def = searchUserMessages(db, { q: "watermark" });
      const explicit = searchUserMessages(db, { q: "watermark", role: "user" });
      expect(explicit).toEqual(def);
    });

    it("两条路径都守约束:<3 码点走 LIKE 兜底时同样只出 is_human=1", () => {
      // 2 字中文 → trigram 命中不了,走 LIKE 全表兜底(queries.ts 的 D4 分支)。
      const hits = searchUserMessages(db, { q: "问题" });
      expect(keys(hits)).toEqual(["u-1"]);
    });
  });

  describe("role='assistant'", () => {
    it("只返回 AI 说的话", () => {
      const hits = searchUserMessages(db, { q: "watermark", role: "assistant" });
      expect(keys(hits)).toEqual(["a-1", "a-2"]);
    });

    it("带出它在回答的那个提问", () => {
      const hits = searchUserMessages(db, { q: "watermark", role: "assistant" });
      expect(hits.length).toBeGreaterThan(0);
      for (const h of hits) {
        expect(h.role).toBe("assistant");
        expect(h.answering).toBe("帮我修一下 watermark 的问题");
      }
    });

    it("LIKE 兜底路径也带 answering", () => {
      const hits = searchUserMessages(db, { q: "解释", role: "assistant" });
      expect(hits).toHaveLength(1);
      expect(hits[0].answering).toBe("帮我修一下 watermark 的问题");
    });
  });

  describe("role='all'", () => {
    it("人和 AI 都返回,但仍然排除留底噪音", () => {
      const hits = searchUserMessages(db, { q: "watermark", role: "all" });
      expect(keys(hits)).toEqual(["a-1", "a-2", "u-1"]);
      expect(keys(hits)).not.toContain("u-noise");
    });

    it("user 行的 answering 为空(它没有在回答谁)", () => {
      const hits = searchUserMessages(db, { q: "watermark", role: "all" });
      const user = hits.find((h) => h.role === "user");
      expect(user).toBeDefined();
      expect(user!.answering).toBeNull();
    });
  });

  describe("锚点行消失时", () => {
    it("answering 为 null,不炸", () => {
      db.prepare(
        "DELETE FROM agent_user_messages WHERE source_message_key = 'u-1'"
      ).run();
      const hits = searchUserMessages(db, { q: "watermark", role: "assistant" });
      expect(hits.length).toBeGreaterThan(0);
      expect(hits[0].answering).toBeNull();
    });
  });
});
