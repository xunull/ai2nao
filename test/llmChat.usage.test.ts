/**
 * 用量聚合接口。
 *
 * 直接打 `sessionUsage`,不走 HTTP —— 端点只是一层薄包装(404 与 500 的分支
 * 由既有路由测试覆盖),而这里要验的是聚合本身。
 */
import { existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Message } from "@ag-ui/client";
import {
  activateChatCompaction,
  ensureLlmChatSession,
  finishChatCall,
  insertPendingChatCall,
  persistGenerated,
  revertChatCompaction,
  sessionUsage,
  type ChatCallUsage,
} from "../src/llmChat/sessions.js";
import { openDatabase } from "../src/store/open.js";

function tempDbPath(name: string): string {
  return join(tmpdir(), `ai2nao-${Date.now()}-${Math.random().toString(36).slice(2)}-${name}`);
}

function withDb(name: string, run: (db: ReturnType<typeof openDatabase>) => void) {
  return () => {
    const path = tempDbPath(name);
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
  input: null,
  noCache: null,
  cacheRead: null,
  cacheWrite: null,
  output: null,
  reasoning: null,
  ...over,
});

const MODEL = { modelId: "m1", provider: "deepseek", model: "deepseek-chat", label: "DS" };

/** 落一笔账并结算。不传 priceMap 时走「只记 pending/unknown」那条路。 */
function call(
  db: ReturnType<typeof openDatabase>,
  sessionId: string,
  runId: string,
  purpose: "answer" | "finalize",
  stepIndex: number,
  u: ChatCallUsage | null
): string {
  const callId = `c:${runId}:${purpose}:${stepIndex}:0`;
  insertPendingChatCall(db, sessionId, {
    callId,
    runId,
    fence: 1,
    purpose,
    stepIndex,
    attempt: 0,
    model: MODEL,
  });
  finishChatCall(db, sessionId, callId, "completed", u);
  return callId;
}

describe("sessionUsage", () => {
  it(
    "displayMessageId 取该轮**最后一条** assistant —— 有补答时就是补答那条",
    withDb("usage-display.db", (db) => {
      const sid = "s-display";
      ensureLlmChatSession(db, sid);
      // 一轮三步:两步主回答 + 一次补答,各落一笔账。
      call(db, sid, "run-1", "answer", 0, usage({ input: 10, output: 5 }));
      call(db, sid, "run-1", "answer", 1, usage({ input: 20, output: 7 }));
      call(db, sid, "run-1", "finalize", 0, usage({ input: 30, output: 9 }));
      // 三条 assistant 消息,按 stepKey 派生 id。
      persistGenerated(db, sid, [
        { id: "u1", role: "user", content: "问题" },
        { id: "a:run-1:answer:0", role: "assistant", content: "第一步" },
        { id: "a:run-1:answer:1", role: "assistant", content: "第二步" },
        { id: "a:run-1:finalize:0", role: "assistant", content: "补答" },
      ] as unknown as Message[]);

      const u = sessionUsage(db, sid);
      // **最容易错的一条**:取最后一条,不是第一条、也不是 stepIndex 最大的 answer。
      expect(u.byRun["run-1"]!.displayMessageId).toBe("a:run-1:finalize:0");
      expect(u.byRun["run-1"]!.calls).toHaveLength(3);
      // 合计含全部步骤与补答。
      expect(u.byRun["run-1"]!.totals.input).toBe(60);
      expect(u.byRun["run-1"]!.totals.output).toBe(21);
    })
  );

  it(
    "服务端专有行不混进来 —— 账目行与占位行都带 ai2nao: 前缀",
    withDb("usage-serveronly.db", (db) => {
      const sid = "s-serveronly";
      ensureLlmChatSession(db, sid);
      call(db, sid, "run-1", "answer", 0, usage({ input: 10, output: 5 }));
      persistGenerated(db, sid, [
        { id: "u1", role: "user", content: "问题" },
        { id: "a:run-1:answer:0", role: "assistant", content: "答案" },
      ] as unknown as Message[]);

      const u = sessionUsage(db, sid);
      // 账目行本身是 role=activity 的 `ai2nao:call:*`,绝不能被当成 assistant。
      const ids = Object.keys(u.byAssistantMessage);
      expect(ids).toEqual(["a:run-1:answer:0"]);
      expect(ids.some((i) => i.startsWith("ai2nao:"))).toBe(false);
      expect(u.byRun["run-1"]!.displayMessageId).toBe("a:run-1:answer:0");
    })
  );

  it(
    "pending 不计入费用,但让合计变成下限",
    withDb("usage-pending.db", (db) => {
      const sid = "s-pending";
      ensureLlmChatSession(db, sid);
      // 只落待定账、不结算 —— 这笔停在 pending。
      insertPendingChatCall(db, sid, {
        callId: "c:run-1:answer:0:0",
        runId: "run-1",
        fence: 1,
        purpose: "answer",
        stepIndex: 0,
        attempt: 0,
        model: MODEL,
      });

      const u = sessionUsage(db, sid);
      expect(u.session.costUsd).toBe(0);
      // **非空转的关键**:钱没算出来时必须标下限,否则界面会把 $0 当成真的没花钱。
      expect(u.session.atLeast).toBe(true);
      expect(u.session.costStates.pending).toBe(1);
    })
  );

  it(
    "compactions 返回「当前栈 + 事件列表」;context 未注入时是 null",
    withDb("usage-placeholder.db", (db) => {
      const sid = "s-placeholder";
      ensureLlmChatSession(db, sid);
      const u = sessionUsage(db, sid);
      // **null 表示「未知」,不是「占用为 0」** —— 它由上层注入,本模块算不了
      // (sessions.ts 是这棵子树的最底层,反向 import 会造出环)。
      expect(u.context).toBeNull();
      expect(u.compactions).toEqual({ stack: [], events: [] });
      // 空会话的聚合是合法的空结构,不是错误。
      expect(u.byRun).toEqual({});
      expect(u.session.atLeast).toBe(false);
    })
  );

  it(
    "★ 压缩栈与事件列表分开给:撤销之后栈空了,事件仍在",
    withDb("usage-compactions.db", (db) => {
      const sid = "s-compactions";
      ensureLlmChatSession(db, sid);
      activateChatCompaction(db, sid, {
        id: "k1",
        trigger: "manual",
        excludedMessageIds: ["u1"],
        summary: { decisions: ["决定"], constraints: [], state: [], nextSteps: [] },
        summaryCallIds: [],
      });
      expect(sessionUsage(db, sid).compactions.stack.map((c) => c.id)).toEqual(["k1"]);

      expect(revertChatCompaction(db, sid, "k1").ok).toBe(true);
      const after = sessionUsage(db, sid).compactions;
      // 只给栈不给事件的话,界面就没法显示「压缩过又撤销了」这段历史。
      expect(after.stack).toEqual([]);
      expect(after.events.map((e) => e.kind)).toEqual(["compaction", "revert"]);
    })
  );

  it(
    "注入的 context 原样透出 —— 路由层算好再塞进来",
    withDb("usage-context.db", (db) => {
      const sid = "s-context";
      ensureLlmChatSession(db, sid);
      const ctx = {
        model: { provider: "p", model: "m", label: "L" },
        contextWindow: 1000,
        outputReserve: 100,
        estimatedInput: 42,
        estimateOnly: true,
        breakdown: { system: 10, summary: 2, recent: 20, toolResults: 10, images: 0 },
        breakdownTotal: 42,
        toolResultsOmitted: false,
        autoCompaction: false,
        suggestedCompactUpTo: 12,
      };
      expect(sessionUsage(db, sid, ctx).context).toEqual(ctx);
    })
  );
});
