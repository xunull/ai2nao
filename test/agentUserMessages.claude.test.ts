import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { openDatabase } from "../src/store/open.js";
import {
  CLAUDE_CLEANER_VERSION,
  CLAUDE_PARSER_VERSION,
  extractClaudeUserMessages,
  recleanClaudeFromPayload,
} from "../src/claudeCodeHistory/myMessages.js";
import type { Message } from "../src/cursorHistory/types.js";
import { upsertUserMessagesBatch } from "../src/agentUserMessages/store.js";
import { recleanClaude, searchUserMessages } from "../src/agentUserMessages/queries.js";
// 后端 cleaner 的 golden 用例见 test/cleanUserMessage.test.ts(option C:清洗归后端)。

function freshDb(): Database.Database {
  const dir = mkdtempSync(join(tmpdir(), "aum-claude-"));
  return openDatabase(join(dir, "test.db"));
}

function userMessage(id: string, content: string, iso = "2026-06-29T01:00:00Z"): Message {
  return {
    id,
    role: "user",
    content,
    timestamp: new Date(iso),
  } as unknown as Message;
}

describe("CLAUDE_CLEANER_VERSION pin", () => {
  it("cleaner=2 —— 改 claude 清洗规则时必须同步 +1 并回填", () => {
    expect(CLAUDE_CLEANER_VERSION).toBe(2);
    expect(CLAUDE_PARSER_VERSION).toBe(1);
  });
});

describe("claude 机器注入过滤(v2 根因修复,2026-07-04)", () => {
  it("压缩摘要续接 → is_human=false", () => {
    const ex = extractClaudeUserMessages([
      userMessage("m1", "This session is being continued from a previous conversation that ran out of context. …摘要…"),
    ]);
    expect(ex[0].cleanedText).toBe("");
    expect(ex[0].isHuman).toBe(false);
  });
  it("/context 报告 → is_human=false", () => {
    const ex = extractClaudeUserMessages([
      userMessage("m1", "## Context Usage\n\n**Model:** claude-opus-4-8[1m]\n…"),
    ]);
    expect(ex[0].isHuman).toBe(false);
  });
  it("task-notification 注入 → is_human=false", () => {
    const ex = extractClaudeUserMessages([
      userMessage("m1", "<task-notification>\n<task-id>abc</task-id>\n完成\n</task-notification>"),
    ]);
    expect(ex[0].isHuman).toBe(false);
  });
  it("纯图片占位 → is_human=false;混文字 → 保留文字", () => {
    const pure = extractClaudeUserMessages([
      userMessage("m1", "[Image: original 3024x4032, displayed at 1500x2000. Multiply coordinates by 2]"),
    ]);
    expect(pure[0].isHuman).toBe(false);
    const mixed = extractClaudeUserMessages([
      userMessage("m2", "[Image #1] 这个图标没显示出来"),
    ]);
    expect(mixed[0].cleanedText).toBe("这个图标没显示出来");
    expect(mixed[0].isHuman).toBe(true);
  });
});

describe("extractClaudeUserMessages — role 门 + 口径", () => {
  it("丢 assistant、剥注入、纯注入轮 is_human=false 但仍返回(留底)", () => {
    const ex = extractClaudeUserMessages([
      userMessage("m1", "帮我修一个 bug"),
      { id: "a1", role: "assistant", content: "好的", timestamp: new Date() } as unknown as Message,
      userMessage("m3", "<command-name>/clear</command-name>"),
      userMessage("m4", "<system-reminder>噪音</system-reminder>再加个测试"),
    ]);
    // assistant 不产出
    expect(ex.map((e) => e.messageKey)).toEqual(["m1", "m3", "m4"]);
    expect(ex[0].cleanedText).toBe("帮我修一个 bug");
    expect(ex[0].isHuman).toBe(true);
    // 纯 command → cleaned '' / is_human false(留底)
    expect(ex[1].cleanedText).toBe("");
    expect(ex[1].isHuman).toBe(false);
    // 剥注入留真人
    expect(ex[2].cleanedText).toBe("再加个测试");
  });

  it("重清洗往返:payload 能重现 cleaned(证明 D5)", () => {
    const ex = extractClaudeUserMessages([
      userMessage("m1", "<system-reminder>x</system-reminder>真正的问题在这"),
    ]);
    const re = recleanClaudeFromPayload(ex[0].rawPayloadJson);
    expect(re.cleanedText).toBe(ex[0].cleanedText);
    expect(re.isHuman).toBe(ex[0].isHuman);
  });
});

describe("claude 入库 + 搜索 + 回填", () => {
  function upsertClaude(db: Database.Database, sessionKey: string, messages: Message[]) {
    const rows = extractClaudeUserMessages(messages).map((ex) => ({
      source: "claude" as const,
      sourceSessionId: sessionKey,
      sourceMessageKey: ex.messageKey,
      project: "proj1",
      eventAtUtc: new Date(ex.eventAtMs).toISOString(),
      rawText: ex.rawText,
      rawPayloadJson: ex.rawPayloadJson,
      cleanedText: ex.cleanedText,
      isHuman: ex.isHuman,
      cleanerVersion: CLAUDE_CLEANER_VERSION,
      parserVersion: CLAUDE_PARSER_VERSION,
      sourcePath: "/x.jsonl",
    }));
    upsertUserMessagesBatch(db, rows, "2026-07-03T00:00:00Z");
  }

  it("claude 行可搜(source 混排下 source 过滤生效)", () => {
    const db = freshDb();
    upsertClaude(db, "proj1:sess1", [userMessage("m1", "我们讨论一下这个功能")]);
    const hits = searchUserMessages(db, { q: "讨论一下" });
    expect(hits.length).toBe(1);
    expect(hits[0].source).toBe("claude");
    expect(searchUserMessages(db, { q: "讨论一下", source: "claude" }).length).toBe(1);
    expect(searchUserMessages(db, { q: "讨论一下", source: "opencode" }).length).toBe(0);
  });

  it("recleanClaude 只碰 claude 行、从 payload 重算 + FTS 同步", () => {
    const db = freshDb();
    upsertClaude(db, "proj1:sess1", [userMessage("m1", "帮我修复登录问题")]);
    const id = (db.prepare("SELECT id FROM agent_user_messages LIMIT 1").get() as { id: number }).id;
    db.prepare("UPDATE agent_user_messages SET cleaner_version=0, cleaned_text='STALE' WHERE id=?").run(id);
    db.prepare("DELETE FROM agent_user_messages_fts WHERE rowid=?").run(id);
    db.prepare(
      "INSERT INTO agent_user_messages_fts(rowid, cleaned_text, source, event_at_utc) VALUES (?,?,?,?)"
    ).run(id, "STALE", "claude", "2026-07-03T00:00:00Z");

    const res = recleanClaude(db);
    expect(res).toEqual({ scanned: 1, updated: 1 });
    const row = db.prepare("SELECT cleaned_text AS c, cleaner_version AS v FROM agent_user_messages WHERE id=?").get(id) as { c: string; v: number };
    expect(row.c).toBe("帮我修复登录问题");
    expect(row.v).toBe(CLAUDE_CLEANER_VERSION);
    expect(searchUserMessages(db, { q: "修复" }).length).toBe(1);
  });
});
