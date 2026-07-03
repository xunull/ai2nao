import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { openDatabase } from "../src/store/open.js";
import {
  CODEX_CLEANER_VERSION,
  CODEX_PARSER_VERSION,
  extractCodexUserMessages,
  recleanCodexFromPayload,
} from "../src/codexHistory/myMessages.js";
import type { Message } from "../src/cursorHistory/types.js";
import { upsertUserMessagesBatch } from "../src/agentUserMessages/store.js";
import { recleanCodex, searchUserMessages } from "../src/agentUserMessages/queries.js";
// 后端 codex cleaner 的 golden 用例见 test/cleanCodexUserMessage.test.ts。

function freshDb(): Database.Database {
  const dir = mkdtempSync(join(tmpdir(), "aum-codex-"));
  return openDatabase(join(dir, "test.db"));
}

function eventMsg(id: string, content: string, iso = "2026-06-29T01:00:00Z"): Message {
  return {
    id,
    role: "user",
    content,
    timestamp: new Date(iso),
    metadata: { codexSource: "event_msg" },
  } as unknown as Message;
}
function responseItemUser(id: string, content: string): Message {
  return {
    id,
    role: "user",
    content,
    timestamp: new Date(),
    metadata: { codexSource: "response_item" },
  } as unknown as Message;
}

describe("CODEX_CLEANER_VERSION pin", () => {
  it("固定为 1 —— 改 codex 清洗规则时必须同步 +1 并回填", () => {
    expect(CODEX_CLEANER_VERSION).toBe(1);
    expect(CODEX_PARSER_VERSION).toBe(1);
  });
});

describe("extractCodexUserMessages — event_msg 双重门", () => {
  it("只取 event_msg user;排除 response_item(双份/AGENTS.md)与 assistant", () => {
    const ex = extractCodexUserMessages([
      eventMsg("u1", "我们讨论一下这个功能"),
      responseItemUser("r1", "我们讨论一下这个功能"), // 双份 → 排除
      { id: "a1", role: "assistant", content: "好的", timestamp: new Date(), metadata: { codexSource: "response_item" } } as unknown as Message,
    ]);
    expect(ex.map((e) => e.messageKey)).toEqual(["u1"]);
    expect(ex[0].cleanedText).toBe("我们讨论一下这个功能");
    expect(ex[0].isHuman).toBe(true);
  });

  it("exec 样板轮 → cleaned='' / is_human=false(留底)", () => {
    const ex = extractCodexUserMessages([
      eventMsg("u1", "IMPORTANT: Do NOT read or execute any files under ~/.claude/ …样板"),
    ]);
    expect(ex[0].cleanedText).toBe("");
    expect(ex[0].isHuman).toBe(false);
    expect(ex[0].rawText).toContain("IMPORTANT");
  });

  it("重清洗往返:payload 能重现 cleaned(证明 D5)", () => {
    const ex = extractCodexUserMessages([eventMsg("u1", "帮我修复登录问题")]);
    const re = recleanCodexFromPayload(ex[0].rawPayloadJson);
    expect(re.cleanedText).toBe(ex[0].cleanedText);
    expect(re.isHuman).toBe(ex[0].isHuman);
  });
});

describe("codex 入库 + 搜索 + 回填", () => {
  function upsertCodex(db: Database.Database, sessionId: string, messages: Message[]) {
    const rows = extractCodexUserMessages(messages).map((ex) => ({
      source: "codex" as const,
      sourceSessionId: sessionId,
      sourceMessageKey: ex.messageKey,
      project: null,
      eventAtUtc: new Date(ex.eventAtMs).toISOString(),
      rawText: ex.rawText,
      rawPayloadJson: ex.rawPayloadJson,
      cleanedText: ex.cleanedText,
      isHuman: ex.isHuman,
      cleanerVersion: CODEX_CLEANER_VERSION,
      parserVersion: CODEX_PARSER_VERSION,
      sourcePath: "/x.jsonl",
    }));
    upsertUserMessagesBatch(db, rows, "2026-07-03T00:00:00Z");
  }

  it("codex 行可搜 + source 过滤", () => {
    const db = freshDb();
    upsertCodex(db, "roll1", [eventMsg("u1", "我们讨论一下这个功能")]);
    const hits = searchUserMessages(db, { q: "讨论一下" });
    expect(hits.length).toBe(1);
    expect(hits[0].source).toBe("codex");
    expect(searchUserMessages(db, { q: "讨论一下", source: "codex" }).length).toBe(1);
    expect(searchUserMessages(db, { q: "讨论一下", source: "claude" }).length).toBe(0);
  });

  it("recleanCodex 只碰 codex 行、从 payload 重算 + FTS 同步", () => {
    const db = freshDb();
    upsertCodex(db, "roll1", [eventMsg("u1", "帮我修复登录问题")]);
    const id = (db.prepare("SELECT id FROM agent_user_messages LIMIT 1").get() as { id: number }).id;
    db.prepare("UPDATE agent_user_messages SET cleaner_version=0, cleaned_text='STALE' WHERE id=?").run(id);
    db.prepare("DELETE FROM agent_user_messages_fts WHERE rowid=?").run(id);
    db.prepare(
      "INSERT INTO agent_user_messages_fts(rowid, cleaned_text, source, event_at_utc) VALUES (?,?,?,?)"
    ).run(id, "STALE", "codex", "2026-07-03T00:00:00Z");

    expect(recleanCodex(db)).toEqual({ scanned: 1, updated: 1 });
    const row = db.prepare("SELECT cleaned_text AS c, cleaner_version AS v FROM agent_user_messages WHERE id=?").get(id) as { c: string; v: number };
    expect(row.c).toBe("帮我修复登录问题");
    expect(row.v).toBe(CODEX_CLEANER_VERSION);
    expect(searchUserMessages(db, { q: "修复" }).length).toBe(1);
  });
});
