import { existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ensureLlmChatSession,
  finishChatCall,
  insertPendingChatCall,
  listLlmChatSessions,
  readSessionCompactionSettings,
  setSessionCompactionAuto,
} from "../src/llmChat/sessions.js";
import { openDatabase } from "../src/store/open.js";

/**
 * 会话级压缩开关(粗 T7 收尾)。
 *
 * 它与累计用量**同住 `metadata_json` 一列**,所以最要紧的一条是两者不能互相抹掉 ——
 * 抹掉的表现是「左栏的花费忽然归零」或「开关自己关了」,都不报错。
 */

function withDb(run: (db: ReturnType<typeof openDatabase>) => void): void {
  const path = join(tmpdir(), `ai2nao-cset-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  const db = openDatabase(path);
  try {
    run(db);
  } finally {
    db.close();
    if (existsSync(path)) unlinkSync(path);
  }
}

/** 落一笔已结算的账 —— 它会触发 writeSessionUsageTotals 去写 metadata_json.usage。 */
function seedUsage(db: ReturnType<typeof openDatabase>, sid: string): void {
  insertPendingChatCall(db, sid, {
    callId: "c:r0:answer:0:0", runId: "r0", fence: 0, purpose: "answer",
    stepIndex: 0, attempt: 0,
    model: { modelId: "p:m", provider: "p", model: "m", label: "M" },
    sendView: { count: 1, prefixHash: "a".repeat(12), systemHash: "b".repeat(12), toolsHash: "c".repeat(12) },
    maxOutputTokens: 1000,
  });
  finishChatCall(db, sid, "c:r0:answer:0:0", "completed", {
    input: 100, noCache: 100, cacheRead: 0, cacheWrite: 0, output: 50, reasoning: 0,
  });
}

describe("会话级压缩开关", () => {
  it("★ 默认关闭 —— 缺失读成「开」会让用户不知情地被扣压缩的钱", () => {
    withDb((db) => {
      ensureLlmChatSession(db, "s1");
      expect(readSessionCompactionSettings(db, "s1")).toEqual({ auto: false });
    });
  });

  it("写入后读得回来,可以来回切", () => {
    withDb((db) => {
      ensureLlmChatSession(db, "s1");
      setSessionCompactionAuto(db, "s1", true);
      expect(readSessionCompactionSettings(db, "s1").auto).toBe(true);
      setSessionCompactionAuto(db, "s1", false);
      expect(readSessionCompactionSettings(db, "s1").auto).toBe(false);
    });
  });

  it("★ 开关与累计用量同住一列,互不抹掉(先用量后开关)", () => {
    withDb((db) => {
      ensureLlmChatSession(db, "s1");
      seedUsage(db, "s1");
      setSessionCompactionAuto(db, "s1", true);
      // 开关写入不能把 usage 冲掉 —— 冲掉的表现是左栏花费归零,而且不报错。
      const summary = listLlmChatSessions(db, 10).find((x) => x.id === "s1");
      expect(summary?.usage?.input).toBe(100);
      expect(readSessionCompactionSettings(db, "s1").auto).toBe(true);
    });
  });

  it("★ 反向也成立:先开开关,再落账目,开关不被用量写入冲掉", () => {
    withDb((db) => {
      ensureLlmChatSession(db, "s1");
      setSessionCompactionAuto(db, "s1", true);
      seedUsage(db, "s1");
      // writeSessionUsageTotals 是读-改-写、只设 usage 键;若它整体覆盖,这里会变 false。
      expect(readSessionCompactionSettings(db, "s1").auto).toBe(true);
      expect(listLlmChatSessions(db, 10).find((x) => x.id === "s1")?.usage?.input).toBe(100);
    });
  });

  it("坏 JSON 当作「关」,不抛", () => {
    withDb((db) => {
      ensureLlmChatSession(db, "s1");
      db.prepare("UPDATE llm_chat_sessions SET metadata_json = ? WHERE id = ?").run("{坏", "s1");
      expect(readSessionCompactionSettings(db, "s1")).toEqual({ auto: false });
    });
  });
});
