import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { openDatabase } from "../src/store/open.js";
import {
  CLEANER_VERSION,
  PARSER_VERSION,
  extractOpencodeUserMessage,
  recleanOpencodeFromPayload,
} from "../src/opencodeHistory/myMessages.js";
import type {
  OpencodeRawMessage,
  OpencodeRawPart,
} from "../src/opencodeHistory/stateDb.js";
import { upsertUserMessagesBatch } from "../src/agentUserMessages/store.js";
import {
  getUserMessageRaw,
  recleanOpencode,
  searchUserMessages,
} from "../src/agentUserMessages/queries.js";
import type { UpsertUserMessageInput } from "../src/agentUserMessages/types.js";

function freshDb(): Database.Database {
  const dir = mkdtempSync(join(tmpdir(), "aum-test-"));
  return openDatabase(join(dir, "test.db"));
}

function userMsg(id: string, ms = 1000): OpencodeRawMessage {
  return {
    id,
    timeCreated: ms,
    data: JSON.stringify({ role: "user", time: { created: ms } }),
  };
}
function assistantMsg(id: string): OpencodeRawMessage {
  return { id, timeCreated: 1, data: JSON.stringify({ role: "assistant" }) };
}
function textPart(
  messageId: string,
  text: string,
  extra: Record<string, unknown> = {}
): OpencodeRawPart {
  return {
    messageId,
    timeCreated: 1,
    data: JSON.stringify({ type: "text", text, ...extra }),
  };
}

function toInput(
  ex: NonNullable<ReturnType<typeof extractOpencodeUserMessage>>,
  sessionId: string
): UpsertUserMessageInput {
  return {
    source: "opencode",
    sourceSessionId: sessionId,
    sourceMessageKey: ex.messageId,
    project: null,
    eventAtUtc: new Date(ex.eventAtMs).toISOString(),
    rawText: ex.rawText,
    rawPayloadJson: ex.rawPayloadJson,
    cleanedText: ex.cleanedText,
    isHuman: ex.isHuman,
    cleanerVersion: CLEANER_VERSION,
    parserVersion: PARSER_VERSION,
    sourcePath: "/x/opencode.db",
  };
}

function upsertExtracted(
  db: Database.Database,
  sessionId: string,
  m: OpencodeRawMessage,
  parts: OpencodeRawPart[]
): void {
  const ex = extractOpencodeUserMessage(m, parts);
  if (!ex) return;
  upsertUserMessagesBatch(db, [toInput(ex, sessionId)], "2026-07-03T00:00:00Z");
}

describe("extractOpencodeUserMessage — 口径 & role 门", () => {
  it("assistant 消息 → null(role 门在 extractor 内)", () => {
    const ex = extractOpencodeUserMessage(assistantMsg("a1"), [
      textPart("a1", "我是助手回答"),
    ]);
    expect(ex).toBeNull();
  });

  it("干净 user 消息 → cleaned=raw, is_human, payload 保留完整 part", () => {
    const m = userMsg("m1", 5000);
    const ex = extractOpencodeUserMessage(m, [textPart("m1", "我们讨论一下这个功能")]);
    expect(ex).not.toBeNull();
    expect(ex!.cleanedText).toBe("我们讨论一下这个功能");
    expect(ex!.rawText).toBe("我们讨论一下这个功能");
    expect(ex!.isHuman).toBe(true);
    expect(ex!.eventAtMs).toBe(5000);
    // payload = 原始 part.data 字符串数组
    const payload = JSON.parse(ex!.rawPayloadJson) as string[];
    expect(payload).toHaveLength(1);
    expect(JSON.parse(payload[0]).text).toBe("我们讨论一下这个功能");
  });

  it("纯注入 user 消息 → 返回行但 cleaned='' / is_human=false(留底)", () => {
    const m = userMsg("m2");
    const ex = extractOpencodeUserMessage(m, [
      textPart("m2", "<system-reminder>OMO_INTERNAL_INITIATOR bg</system-reminder>"),
      textPart("m2", "file open", { metadata: { kind: "editor_context" } }),
    ]);
    expect(ex).not.toBeNull();
    expect(ex!.cleanedText).toBe("");
    expect(ex!.isHuman).toBe(false);
    // rawText 保留原始(不做注入过滤)
    expect(ex!.rawText).toContain("OMO_INTERNAL_INITIATOR");
  });
});

describe("重清洗往返(证明 D5:payload 能重现 cleaner 输出)", () => {
  it("recleanOpencodeFromPayload(payload) === 首次 extract 的 cleaned", () => {
    const m = userMsg("m3");
    // 混合:注入 part + 真人 part → 清洗后只剩真人
    const ex = extractOpencodeUserMessage(m, [
      textPart("m3", "file", { metadata: { kind: "editor_context" } }),
      textPart("m3", "真正的问题在这里"),
      textPart("m3", "OMO_INTERNAL_INITIATOR noise"),
    ]);
    expect(ex!.cleanedText).toBe("真正的问题在这里");
    const re = recleanOpencodeFromPayload(ex!.rawPayloadJson);
    expect(re.cleanedText).toBe(ex!.cleanedText);
    expect(re.isHuman).toBe(ex!.isHuman);
  });

  it("坏 payload → 空清洗,不抛", () => {
    const re = recleanOpencodeFromPayload("not-json");
    expect(re.cleanedText).toBe("");
    expect(re.isHuman).toBe(false);
  });
});

describe("CLEANER_VERSION pin(改清洗逻辑必 bump)", () => {
  it("CLEANER_VERSION 固定为 1 —— 改动 myMessages 清洗规则时必须同步 +1", () => {
    // 这条 pin 逼出有意识的版本升:清洗改了但没 bump,此断言会挂,提醒补 bump + 回填。
    expect(CLEANER_VERSION).toBe(1);
    expect(PARSER_VERSION).toBe(1);
  });
});

describe("store upsert + FTS + search", () => {
  it("幂等:同一 message 重复 upsert 不增行", () => {
    const db = freshDb();
    upsertExtracted(db, "s1", userMsg("m1"), [textPart("m1", "我们讨论一下这个功能")]);
    upsertExtracted(db, "s1", userMsg("m1"), [textPart("m1", "我们讨论一下这个功能")]);
    const c = (db.prepare("SELECT COUNT(*) c FROM agent_user_messages").get() as { c: number }).c;
    expect(c).toBe(1);
    const fc = (db.prepare("SELECT COUNT(*) c FROM agent_user_messages_fts").get() as { c: number }).c;
    expect(fc).toBe(1);
  });

  it("中文 ≥3 字走 trigram、2 字走 LIKE 兜底,都能命中", () => {
    const db = freshDb();
    upsertExtracted(db, "s1", userMsg("m1", 1000), [textPart("m1", "我们讨论一下这个功能")]);
    upsertExtracted(db, "s1", userMsg("m2", 2000), [textPart("m2", "帮我修复登录问题")]);

    const tri = searchUserMessages(db, { q: "讨论一下" }); // 4 码点 → trigram
    expect(tri.map((h) => h.sourceSessionId)).toContain("s1");
    expect(tri[0].snippet).toContain("[");

    const like = searchUserMessages(db, { q: "登录" }); // 2 码点 → LIKE
    expect(like.length).toBe(1);
    expect(like[0].snippet).toContain("[登录]");
  });

  it("is_human=0(纯注入)行永不出现在搜索结果", () => {
    const db = freshDb();
    upsertExtracted(db, "s1", userMsg("m1"), [
      textPart("m1", "<system-reminder>OMO_INTERNAL_INITIATOR</system-reminder>"),
    ]);
    // 该行入库留底,但 cleaned='' → 不该被搜到
    const total = (db.prepare("SELECT COUNT(*) c FROM agent_user_messages").get() as { c: number }).c;
    expect(total).toBe(1);
    const hits = searchUserMessages(db, { q: "system-reminder" });
    expect(hits.length).toBe(0);
  });

  it("source 过滤生效", () => {
    const db = freshDb();
    upsertExtracted(db, "s1", userMsg("m1"), [textPart("m1", "我们讨论一下这个功能")]);
    expect(searchUserMessages(db, { q: "讨论一下", source: "opencode" }).length).toBe(1);
    expect(searchUserMessages(db, { q: "讨论一下", source: "claude" }).length).toBe(0);
  });

  it("原文审计返回 raw_text + payload", () => {
    const db = freshDb();
    upsertExtracted(db, "s1", userMsg("m1"), [textPart("m1", "我们讨论一下这个功能")]);
    const id = (db.prepare("SELECT id FROM agent_user_messages LIMIT 1").get() as { id: number }).id;
    const raw = getUserMessageRaw(db, id);
    expect(raw?.rawText).toBe("我们讨论一下这个功能");
    expect(raw?.cleanerVersion).toBe(CLEANER_VERSION);
    expect(getUserMessageRaw(db, 999999)).toBeNull();
  });
});

describe("cleaner_version 回填(D10:从 payload 重算 + FTS 逐行同步)", () => {
  it("落后版本行被重算、版本推进、FTS 更新可搜", () => {
    const db = freshDb();
    upsertExtracted(db, "s1", userMsg("m1"), [textPart("m1", "帮我修复登录问题")]);
    const id = (db.prepare("SELECT id FROM agent_user_messages LIMIT 1").get() as { id: number }).id;
    // 模拟旧行:cleaner_version=0 + cleaned 被污染(且 FTS 也污染)
    db.prepare(
      "UPDATE agent_user_messages SET cleaner_version=0, cleaned_text='STALE' WHERE id=?"
    ).run(id);
    db.prepare("DELETE FROM agent_user_messages_fts WHERE rowid=?").run(id);
    db.prepare(
      "INSERT INTO agent_user_messages_fts(rowid, cleaned_text, source, event_at_utc) VALUES (?,?,?,?)"
    ).run(id, "STALE", "opencode", "2026-07-03T00:00:00Z");

    const res = recleanOpencode(db);
    expect(res.scanned).toBe(1);
    expect(res.updated).toBe(1);

    const raw = getUserMessageRaw(db, id);
    expect(raw?.cleanedText).toBe("帮我修复登录问题"); // 从 payload 重算回真值
    expect(raw?.cleanerVersion).toBe(CLEANER_VERSION);
    // FTS 已同步:能搜到真值(2 字 LIKE),搜不到 STALE
    expect(searchUserMessages(db, { q: "修复" }).length).toBe(1);
  });

  it("同版本行不动(scanned=0)", () => {
    const db = freshDb();
    upsertExtracted(db, "s1", userMsg("m1"), [textPart("m1", "我们讨论一下这个功能")]);
    expect(recleanOpencode(db)).toEqual({ scanned: 0, updated: 0 });
  });
});
