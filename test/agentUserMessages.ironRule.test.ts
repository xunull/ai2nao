import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { migrate } from "../src/store/migrations.js";
import {
  searchUserMessages,
  userMessageAnalytics,
  userMessageList,
  userMessageTimeline,
} from "../src/agentUserMessages/queries.js";
import { upsertUserMessagesBatch } from "../src/agentUserMessages/store.js";
import {
  extractClaudeMessages,
  extractClaudeUserMessages,
} from "../src/claudeCodeHistory/myMessages.js";
import type { Message } from "../src/cursorHistory/types.js";
import type { UpsertUserMessageInput } from "../src/agentUserMessages/types.js";

/**
 * IRON RULE:把 AI 的话加进 agent_user_messages,**不能动既有的 is_human=1 集合**。
 *
 * 这张表有 10 个消费点(aiRhythm / home.leads / attention / commitBridge /
 * projectCalendar / topicStream×2 / replay / queries),全部带 `is_human = 1` 过滤 ——
 * assistant 行 is_human=0,理论上天然隔离。这里把「理论上」变成断言。
 *
 * 两层防线:
 *   1. 抽取层 —— 同一份 Message[],user 子集必须逐字段相同
 *   2. 读侧   —— 插入 assistant 行前后,所有读函数的输出必须一模一样
 */
describe("IRON RULE —— 加 assistant 不动既有集合", () => {
  let db: Database.Database;
  const now = "2026-08-17T12:00:00.000Z";

  beforeEach(() => {
    db = new Database(":memory:");
    migrate(db);
  });
  afterEach(() => db?.close());

  const msg = (over: Partial<Message> & { role: string }): Message =>
    ({
      id: `m-${Math.random().toString(36).slice(2, 9)}`,
      role: over.role,
      content: over.content ?? "",
      timestamp: over.timestamp ?? "2026-08-17T00:00:00.000Z",
      ...over,
    }) as Message;

  describe("抽取层", () => {
    // 真实语料里的四种形态,一个不落。
    const messages: Message[] = [
      msg({ role: "user", content: "帮我看下 watermark" }),
      msg({ role: "assistant", content: "水位是已处理干净的时间点" }),
      // 纯注入轮:清洗后为空 → is_human=0,但仍要留底。
      msg({ role: "user", content: "<system-reminder>injected</system-reminder>" }),
      // 被阅读模式藏掉的 AI 行(工具调用)。
      msg({
        role: "assistant",
        content: "",
        metadata: { readingHidden: "tool-only" },
      } as Partial<Message> & { role: string }),
      msg({ role: "user", content: "继续" }),
    ];

    it("extractClaudeUserMessages 的输出 == extractClaudeMessages 的 user 子集", () => {
      const viaFilter = extractClaudeMessages(messages).filter(
        (m) => m.role === "user"
      );
      expect(extractClaudeUserMessages(messages)).toEqual(viaFilter);
    });

    it("user 侧仍然收全部(含清洗后为空的留底轮)——不看 readingHidden", () => {
      const users = extractClaudeUserMessages(messages);
      expect(users).toHaveLength(3);
      expect(users.map((u) => u.isHuman)).toEqual([true, false, true]);
    });

    it("assistant 侧只收阅读模式可见的行", () => {
      const ai = extractClaudeMessages(messages).filter(
        (m) => m.role === "assistant"
      );
      expect(ai).toHaveLength(1);
      expect(ai[0].cleanedText).toBe("水位是已处理干净的时间点");
      expect(ai[0].isHuman).toBe(false);
    });

    it("纯 thinking 行不入库(否则会往 FTS 写空串)", () => {
      const thinkingOnly = extractClaudeMessages([
        msg({ role: "user", content: "问题" }),
        // readingHidden 为空(它是 AI 的真实输出),但 content 是空的。
        msg({ role: "assistant", content: "", thinking: "内部推理" } as
          Partial<Message> & { role: string }),
      ]);
      expect(thinkingOnly.filter((m) => m.role === "assistant")).toHaveLength(0);
    });

    it("锚点只认真人说的话,不认纯注入轮", () => {
      const out = extractClaudeMessages([
        msg({ role: "user", content: "真正的提问" }),
        msg({ role: "user", content: "<system-reminder>x</system-reminder>" }),
        msg({ role: "assistant", content: "回答" }),
      ]);
      const ai = out.find((m) => m.role === "assistant")!;
      const realQuestion = out.find((m) => m.isHuman)!;
      expect(ai.answeringUserKey).toBe(realQuestion.messageKey);
    });
  });

  describe("读侧 —— 插 assistant 前后必须一模一样", () => {
    const row = (
      key: string,
      text: string,
      o: { role: "user" | "assistant"; isHuman: boolean; at: string }
    ): UpsertUserMessageInput => ({
      source: "claude",
      sourceSessionId: "proj:sess",
      sourceMessageKey: key,
      project: "proj",
      eventAtUtc: o.at,
      rawText: text,
      rawPayloadJson: JSON.stringify(text),
      cleanedText: text,
      isHuman: o.isHuman,
      cleanerVersion: 4,
      parserVersion: 1,
      sourcePath: null,
      role: o.role,
      answeringUserKey: null,
    });

    /** 表的聚合快照 —— 与设计文档里那条回归基线口径一致。 */
    const snapshot = () =>
      db
        .prepare(
          `SELECT source, is_human, COUNT(*) AS n, SUM(char_len) AS chars
           FROM agent_user_messages WHERE is_human = 1 GROUP BY 1,2 ORDER BY 1,2`
        )
        .all();

    /** 所有读侧的输出打包 —— 任何一个变了都说明隔离失效。 */
    const readAll = () => ({
      snapshot: snapshot(),
      analytics: userMessageAnalytics(db),
      timeline: userMessageTimeline(db, {
        window: "1w",
        now: new Date("2026-08-17T12:00:00Z"),
      }),
      list: userMessageList(db, {
        window: "1w",
        limit: 50,
        now: new Date("2026-08-17T12:00:00Z"),
      }),
      search: searchUserMessages(db, { q: "提问" }),
    });

    beforeEach(() => {
      upsertUserMessagesBatch(
        db,
        [
          row("u-1", "第一个提问", { role: "user", isHuman: true, at: "2026-08-15T00:00:00.000Z" }),
          row("u-2", "第二个提问", { role: "user", isHuman: true, at: "2026-08-16T00:00:00.000Z" }),
          row("u-noise", "", { role: "user", isHuman: false, at: "2026-08-16T01:00:00.000Z" }),
        ],
        now
      );
    });

    it("插入 assistant 行后,全部读侧输出不变", () => {
      const before = readAll();

      upsertUserMessagesBatch(
        db,
        [
          row("a-1", "AI 的一段很长的回答，里面也出现了提问这两个字", {
            role: "assistant",
            isHuman: false,
            at: "2026-08-15T00:01:00.000Z",
          }),
          row("a-2", "AI 的另一段回答", {
            role: "assistant",
            isHuman: false,
            at: "2026-08-16T00:01:00.000Z",
          }),
        ],
        now
      );

      // 表里确实多了行 —— 证明这个测试不是因为什么都没插而假绿。
      const total = (
        db.prepare("SELECT COUNT(*) AS n FROM agent_user_messages").get() as {
          n: number;
        }
      ).n;
      expect(total).toBe(5);

      expect(readAll()).toEqual(before);
    });

    it("assistant 行确实进了 FTS(只是被 is_human 挡在既有查询之外)", () => {
      upsertUserMessagesBatch(
        db,
        [
          row("a-1", "只有 AI 说过的独特词汇", {
            role: "assistant",
            isHuman: false,
            at: "2026-08-15T00:01:00.000Z",
          }),
        ],
        now
      );
      // 默认搜不到……
      expect(searchUserMessages(db, { q: "独特词汇" })).toHaveLength(0);
      // ……但显式搜 AI 就能搜到,说明数据在、索引也在。
      expect(
        searchUserMessages(db, { q: "独特词汇", role: "assistant" })
      ).toHaveLength(1);
    });
  });
});
