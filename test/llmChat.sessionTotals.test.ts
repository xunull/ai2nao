/**
 * 会话累计写进 `metadata_json`(JSONL 的 T9)。
 *
 * **读侧与写侧必须分开验。** 上一步只做了读侧(`withParsedUsage`),那时它恒返回
 * `undefined` —— 读得对和写进去了是两回事,只测读侧会一直绿着而累计从来没落过库。
 */
import { existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ensureLlmChatSession,
  finishChatCall,
  getLlmChatSession,
  insertPendingChatCall,
  listLlmChatSessions,
  recomputeSessionUsage,
  type ChatCallUsage,
} from "../src/llmChat/sessions.js";
import { openDatabase } from "../src/store/open.js";

function withDb(name: string, run: (db: ReturnType<typeof openDatabase>) => void) {
  return () => {
    const path = join(tmpdir(), `ai2nao-${Date.now()}-${Math.random().toString(36).slice(2)}-${name}`);
    const db = openDatabase(path);
    try {
      run(db);
    } finally {
      db.close();
      if (existsSync(path)) unlinkSync(path);
    }
  };
}

const usage = (over: Partial<ChatCallUsage>): ChatCallUsage => ({
  input: null, noCache: null, cacheRead: null, cacheWrite: null, output: null, reasoning: null,
  ...over,
});

const MODEL = { modelId: "m1", provider: "deepseek", model: "deepseek-chat", label: "DS" };

function pend(db: ReturnType<typeof openDatabase>, sid: string, callId: string) {
  insertPendingChatCall(db, sid, {
    callId, runId: "run-1", fence: 1, purpose: "answer", stepIndex: 0, attempt: 0, model: MODEL,
  });
}

describe("会话累计落库", () => {
  it(
    "pending 阶段就写累计:费用为 0,但 atLeast 已经是 true",
    withDb("totals-pending.db", (db) => {
      const sid = "s1";
      ensureLlmChatSession(db, sid);
      pend(db, sid, "c1");

      const u = getLlmChatSession(db, sid)!.usage;
      // **非空转的关键**:不写的话这里是 undefined,而不是「有值但为 0」。
      expect(u).toBeDefined();
      expect(u!.costUsd).toBe(0);
      // 正在跑的那一轮必须带下限标记,否则左栏看着像已经算准了。
      expect(u!.atLeast).toBe(true);
    })
  );

  it(
    "结算后累计跟着更新 —— 费用是在这一刻产生的",
    withDb("totals-settle.db", (db) => {
      const sid = "s1";
      ensureLlmChatSession(db, sid);
      pend(db, sid, "c1");
      const before = getLlmChatSession(db, sid)!.usage!;

      finishChatCall(db, sid, "c1", "completed", usage({ input: 100, output: 20, cacheRead: 5 }));
      const after = getLlmChatSession(db, sid)!.usage!;

      // token 进了累计。
      expect(before.input).toBe(0);
      expect(after.input).toBe(100);
      expect(after.output).toBe(20);
      expect(after.cacheRead).toBe(5);
      // 没传 priceMap → 这笔停在「有用量但没算钱」,所以仍是下限。
      expect(after.atLeast).toBe(true);
      expect(after.updatedAt >= before.updatedAt).toBe(true);
    })
  );

  it(
    "列表与详情走同一条解析 —— 只改一处会让左栏有、详情没有",
    withDb("totals-both.db", (db) => {
      const sid = "s1";
      ensureLlmChatSession(db, sid);
      pend(db, sid, "c1");
      finishChatCall(db, sid, "c1", "completed", usage({ input: 42, output: 7 }));

      const fromList = listLlmChatSessions(db).find((s) => s.id === sid)!;
      const fromDetail = getLlmChatSession(db, sid)!;
      expect(fromList.usage?.input).toBe(42);
      expect(fromDetail.usage?.input).toBe(42);
      expect(fromList.usage).toEqual(fromDetail.usage);
    })
  );

  it(
    "没有账目的旧会话:usage 是 undefined,不是 0",
    withDb("totals-legacy.db", (db) => {
      const sid = "s1";
      ensureLlmChatSession(db, sid);
      // 一笔账都没落过 → metadata_json 还是建表默认的 '{}'。
      const u = getLlmChatSession(db, sid)!.usage;
      // **「还没算过」与「花了 0 元」必须分开** —— 后者会让界面显示 $0.00 像是确定值。
      expect(u).toBeUndefined();
    })
  );

  it(
    "recomputeSessionUsage 与明细一致,可用于对账",
    withDb("totals-recompute.db", (db) => {
      const sid = "s1";
      ensureLlmChatSession(db, sid);
      pend(db, sid, "c1");
      finishChatCall(db, sid, "c1", "completed", usage({ input: 10, output: 3 }));

      // 手工把累计写坏,模拟「与明细对不上」。
      db.prepare("UPDATE llm_chat_sessions SET metadata_json = ? WHERE id = ?")
        .run(JSON.stringify({ usage: { costUsd: 999, atLeast: false, input: 1, output: 1, reasoning: 0, cacheRead: 0, cacheWrite: 0, updatedAt: "x" } }), sid);
      expect(getLlmChatSession(db, sid)!.usage!.input).toBe(1);

      const fixed = recomputeSessionUsage(db, sid);
      expect(fixed.input).toBe(10);
      expect(fixed.output).toBe(3);
      // 重算的结果确实写回了库,不只是返回值。
      expect(getLlmChatSession(db, sid)!.usage!.input).toBe(10);
    })
  );
});
