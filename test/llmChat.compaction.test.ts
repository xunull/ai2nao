import { existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Message } from "@ag-ui/core";
import {
  activateChatCompaction,
  activeCompaction,
  ensureLlmChatSession,
  readChatCompactionEvents,
  replaceLlmChatSessionMessages,
  replayCompactionStack,
  revertChatCompaction,
} from "../src/llmChat/sessions.js";
import { openDatabase } from "../src/store/open.js";

/**
 * 压缩事件的存储层(粗 T7,按规格改成事件流 + 栈)。
 *
 * **只追加、不修改**:撤销是追加一条 `revert`,不是把旧行上的布尔值翻掉。
 * 「当前生效的是哪一条」因此由**回放**决定 —— 布尔值那一版允许跳层撤销,
 * 同一串事件回放不出同一个结果。
 *
 * 下面每条盯的都是静默错:顺序错、层级错、或者两种事件撞了同一个 message_id。
 */

function withDb(run: (db: ReturnType<typeof openDatabase>) => void): void {
  const path = join(
    tmpdir(),
    `ai2nao-compaction-${Date.now()}-${Math.random().toString(36).slice(2)}.db`
  );
  const db = openDatabase(path);
  try {
    run(db);
  } finally {
    db.close();
    if (existsSync(path)) unlinkSync(path);
  }
}

const SUMMARY = {
  decisions: ["用 SQLite 存账目"],
  constraints: ["SCHEMA_VERSION 钉在 60"],
  state: ["粗 T6 已完成"],
  nextSteps: ["做压缩"],
};

function seed(
  db: ReturnType<typeof openDatabase>,
  sid: string,
  id: string,
  excluded: string[],
  trigger: "manual" | "auto" = "manual"
) {
  return activateChatCompaction(db, sid, {
    id,
    trigger,
    excludedMessageIds: excluded,
    summary: SUMMARY,
    summaryCallIds: [`c:r1:compact:0:0`],
  });
}

const stackOf = (db: ReturnType<typeof openDatabase>, sid: string) =>
  replayCompactionStack(readChatCompactionEvents(db, sid)).map((c) => c.id);

describe("压缩事件的落库与读回", () => {
  it("写进去读得回来,字段原样保留", () => {
    withDb((db) => {
      ensureLlmChatSession(db, "s1");
      seed(db, "s1", "k1", ["u1", "a1"], "auto");
      const events = readChatCompactionEvents(db, "s1");
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        v: 1,
        kind: "compaction",
        id: "k1",
        baseId: null,
        trigger: "auto",
        excludedMessageIds: ["u1", "a1"],
        summary: SUMMARY,
        summaryCallIds: ["c:r1:compact:0:0"],
      });
    });
  });

  it("★ 落在 4e6 保留区,压缩与撤销**共用同一个递增计数** —— 回放依赖行序", () => {
    withDb((db) => {
      ensureLlmChatSession(db, "s1");
      seed(db, "s1", "A", ["u1"]);
      seed(db, "s1", "B", ["u1", "a1"]);
      expect(revertChatCompaction(db, "s1", "B").ok).toBe(true);
      const idx = db
        .prepare(
          `SELECT message_index FROM llm_chat_messages
            WHERE session_id = ? AND message_id LIKE 'ai2nao:compaction%'
            ORDER BY message_index ASC`
        )
        .all("s1") as { message_index: number }[];
      // 撤销若另起一套编号,它会插在压缩行中间,回放顺序当场反过来。
      expect(idx.map((r) => r.message_index)).toEqual([4_000_000, 4_000_001, 4_000_002]);
    });
  });

  it("叠加:A 之后再 B,栈顶是 B,且 B.baseId 指向 A", () => {
    withDb((db) => {
      ensureLlmChatSession(db, "s1");
      seed(db, "s1", "A", ["u1"]);
      const b = seed(db, "s1", "B", ["u1", "a1"]);
      expect(stackOf(db, "s1")).toEqual(["A", "B"]);
      expect(activeCompaction(db, "s1")?.id).toBe("B");
      // baseId 断了的话,B 的摘要就不是「A 的摘要 + 新折叠的轮次」,A 记住的决定会无声消失。
      expect(b.baseId).toBe("A");
    });
  });

  it("★ 撤销 B 退回 A,再撤销 A 回到「没有压缩」—— 行不删,才退得回中间层", () => {
    withDb((db) => {
      ensureLlmChatSession(db, "s1");
      seed(db, "s1", "A", ["u1"]);
      seed(db, "s1", "B", ["u1", "a1"]);

      expect(revertChatCompaction(db, "s1", "B").ok).toBe(true);
      expect(activeCompaction(db, "s1")?.id).toBe("A");

      expect(revertChatCompaction(db, "s1", "A").ok).toBe(true);
      expect(activeCompaction(db, "s1")).toBeNull();

      // 四条事件都还在(2 压缩 + 2 撤销),只是回放结果是空栈。
      expect(readChatCompactionEvents(db, "s1")).toHaveLength(4);
    });
  });

  it("★ 只能撤销栈顶:撤销 A(它下面还压着 B)被拒,栈一动不动", () => {
    withDb((db) => {
      ensureLlmChatSession(db, "s1");
      seed(db, "s1", "A", ["u1"]);
      seed(db, "s1", "B", ["u1", "a1"]);
      const res = revertChatCompaction(db, "s1", "A");
      expect(res).toEqual({ ok: false, reason: "not-top" });
      // 拒绝必须是**不写入**,不是写完再说不算 —— 写了的话回放就多一条对不上的 revert。
      expect(readChatCompactionEvents(db, "s1")).toHaveLength(2);
      expect(stackOf(db, "s1")).toEqual(["A", "B"]);
    });
  });

  it("空栈或未知 id 撤销:拒绝且不写入", () => {
    withDb((db) => {
      ensureLlmChatSession(db, "s1");
      expect(revertChatCompaction(db, "s1", "谁")).toEqual({ ok: false, reason: "empty" });
      seed(db, "s1", "A", ["u1"]);
      expect(revertChatCompaction(db, "s1", "不存在")).toEqual({ ok: false, reason: "not-top" });
      expect(revertChatCompaction(db, "s1", "A").ok).toBe(true);
      // 已经撤销过的再撤一次:栈已空,不该「复活」也不该报错。
      expect(revertChatCompaction(db, "s1", "A")).toEqual({ ok: false, reason: "empty" });
      expect(activeCompaction(db, "s1")).toBeNull();
    });
  });

  it("★ 撤销行与压缩行用不同前缀 —— 同前缀会撞 UNIQUE,把被撤销的那条原地覆盖掉", () => {
    withDb((db) => {
      ensureLlmChatSession(db, "s1");
      seed(db, "s1", "A", ["u1"]);
      expect(revertChatCompaction(db, "s1", "A").ok).toBe(true);
      const ids = db
        .prepare(
          `SELECT message_id FROM llm_chat_messages
            WHERE session_id = ? AND message_id LIKE 'ai2nao:compaction%'
            ORDER BY message_index ASC`
        )
        .all("s1") as { message_id: string }[];
      // 撞了的话这里只有一行,而且那一行的 kind 变成了 revert —— A 的摘要整条消失,
      // 栈回放却仍然「正确」地得出空栈,于是错误完全不可见。
      expect(ids.map((r) => r.message_id)).toEqual([
        "ai2nao:compaction:A",
        "ai2nao:compaction-revert:A",
      ]);
      expect(readChatCompactionEvents(db, "s1").map((e) => e.kind)).toEqual([
        "compaction",
        "revert",
      ]);
    });
  });

  it("★ 普通消息重排不碰保留区 —— 这条钉的是只靠读 WHERE 子句推出来的结论", () => {
    withDb((db) => {
      ensureLlmChatSession(db, "s1");
      seed(db, "s1", "k1", ["u1"]);

      // `replaceLlmChatSessionMessages` 会把普通消息的 message_index 取负再重排。
      // 那条 UPDATE 的 WHERE 显式排除了 `ai2nao:%`;推理对不对,只能靠这条测试。
      replaceLlmChatSessionMessages(db, "s1", {
        messages: [
          { id: "u1", role: "user", content: "问题" } as Message,
          { id: "a1", role: "assistant", content: "回答" } as Message,
        ],
      });

      const idx = db
        .prepare(
          `SELECT message_index FROM llm_chat_messages
            WHERE session_id = ? AND message_id LIKE 'ai2nao:compaction:%'`
        )
        .get("s1") as { message_index: number } | undefined;
      expect(idx?.message_index).toBe(4_000_000);
      expect(activeCompaction(db, "s1")?.id).toBe("k1");
    });
  });

  it("★ 重排之后排除集合仍指向同一批消息 —— 这是改存 id 不存下标的全部理由", () => {
    withDb((db) => {
      ensureLlmChatSession(db, "s1");
      const before: Message[] = [
        { id: "u1", role: "user", content: "一" } as Message,
        { id: "a1", role: "assistant", content: "二" } as Message,
        { id: "u2", role: "user", content: "三" } as Message,
        { id: "a2", role: "assistant", content: "四" } as Message,
      ];
      replaceLlmChatSessionMessages(db, "s1", { messages: before });
      seed(db, "s1", "k1", ["u1", "a1"]); // 等价于「折叠到下标 2」

      // 前面插一条 —— 所有下标 +1。存下标的话,原来的 cutoff=2 现在覆盖的是 {x0,u1},
      // a1 会悄悄回到上下文里,而 x0 莫名其妙被折叠掉。
      replaceLlmChatSessionMessages(db, "s1", {
        messages: [{ id: "x0", role: "user", content: "插队" } as Message, ...before],
      });

      const a1 = db
        .prepare("SELECT message_index FROM llm_chat_messages WHERE session_id = ? AND message_id = ?")
        .get("s1", "a1") as { message_index: number } | undefined;
      expect(a1?.message_index).toBe(2); // 下标确实动了(原来是 1)
      // 而排除集合按 id 存,指向的还是同一批消息。
      expect(activeCompaction(db, "s1")?.excludedMessageIds).toEqual(["u1", "a1"]);
    });
  });
});
