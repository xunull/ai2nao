/**
 * `persistGenerated` —— 增量落库。
 *
 * 与 `replaceLlmChatSessionMessages`(整轮覆盖写)是两条路径,区别就在「增量」:
 * 只往上加、不删任何行、不动已有行的 message_index。表上有
 * `UNIQUE(session_id, message_index)`,所以「不动索引」不是风格问题,是正确性问题。
 */
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../src/store/open.js";
import {
  claimChatRun,
  createLlmChatSession,
  getLlmChatSession,
  persistGenerated,
  replaceLlmChatSessionMessages,
} from "../src/llmChat/sessions.js";

function freshDb() {
  return openDatabase(
    join(tmpdir(), `ai2nao-persist-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
  );
}

function userMessage(id: string, text: string) {
  return { id, role: "user", content: text };
}

function assistantMessage(id: string, text: string) {
  return { id, role: "assistant", content: text };
}

/** 只看普通消息 —— 服务端专有行(占位行)不属于会话内容。 */
function normalRows(db: ReturnType<typeof freshDb>, sessionId: string) {
  return (getLlmChatSession(db, sessionId)?.messages ?? []).filter(
    (m) => !m.message_id.startsWith("ai2nao:")
  );
}

describe("persistGenerated —— 增量落库", () => {
  it("只往上加,不删库里已有的行", () => {
    const db = freshDb();
    try {
      const session = createLlmChatSession(db);
      replaceLlmChatSessionMessages(db, session.id, {
        messages: [userMessage("u1", "问题"), assistantMessage("a1", "回答")],
      });

      // 只传一条新消息 —— 整轮覆盖写会把 u1/a1 删掉,增量写不会。
      persistGenerated(db, session.id, [assistantMessage("a2", "补充")] as never);

      expect(normalRows(db, session.id).map((m) => m.message_id)).toEqual(["u1", "a1", "a2"]);
    } finally {
      db.close();
    }
  });

  it("已有行的 message_index 原地不动,新行追加在最大值之后", () => {
    const db = freshDb();
    try {
      const session = createLlmChatSession(db);
      replaceLlmChatSessionMessages(db, session.id, {
        messages: [userMessage("u1", "问题"), assistantMessage("a1", "回答")],
      });

      persistGenerated(db, session.id, [assistantMessage("a2", "补充")] as never);

      const rows = normalRows(db, session.id);
      expect(rows.map((m) => m.message_id)).toEqual(["u1", "a1", "a2"]);
      expect(rows.map((m) => m.message_index)).toEqual([0, 1, 2]);
    } finally {
      db.close();
    }
  });

  it("重复 upsert 同一条是幂等的 —— 每步落库靠的就是这一点", () => {
    const db = freshDb();
    try {
      const session = createLlmChatSession(db);
      const batch = [userMessage("u1", "问题"), assistantMessage("a1", "第一版")] as never;

      persistGenerated(db, session.id, batch);
      persistGenerated(db, session.id, batch);
      persistGenerated(db, session.id, [
        userMessage("u1", "问题"),
        assistantMessage("a1", "改写后的内容"),
      ] as never);

      const rows = normalRows(db, session.id);
      expect(rows.map((m) => m.message_id)).toEqual(["u1", "a1"]);
      expect(rows.map((m) => m.message_index)).toEqual([0, 1]);
      // 覆盖的是同一行,内容更新到最后一次。
      expect(rows[1]?.plain_text).toBe("改写后的内容");
    } finally {
      db.close();
    }
  });

  it("message_count 与标题按整个会话重算,不是按这一批", () => {
    const db = freshDb();
    try {
      const session = createLlmChatSession(db);
      persistGenerated(db, session.id, [userMessage("u1", "真正的标题")] as never);

      let detail = getLlmChatSession(db, session.id)!;
      expect(detail.message_count).toBe(1);
      expect(detail.title).toBe("真正的标题");

      // 这一批只有一条 assistant。若按批算,count 会被清成 1、标题会丢。
      persistGenerated(db, session.id, [assistantMessage("a1", "回答")] as never);

      detail = getLlmChatSession(db, session.id)!;
      expect(detail.message_count).toBe(2);
      expect(detail.title).toBe("真正的标题");
    } finally {
      db.close();
    }
  });

  it("占位行不参与索引分配,也不进 message_count", () => {
    const db = freshDb();
    try {
      const session = createLlmChatSession(db);
      // 占位行落在 RUN_ROW_INDEX_BASE(1_000_000)之上的保留区。
      const claim = claimChatRun(db, session.id, "u1");
      expect(claim.ok).toBe(true);

      persistGenerated(db, session.id, [
        userMessage("u1", "问题"),
        assistantMessage("a1", "回答"),
      ] as never);

      // 如果 nextIndex 把占位行算进去,这里会变成 1000002/1000003 —— 静默且难查。
      const rows = normalRows(db, session.id);
      expect(rows.map((m) => m.message_index)).toEqual([0, 1]);
      expect(getLlmChatSession(db, session.id)?.message_count).toBe(2);
    } finally {
      db.close();
    }
  });
});
