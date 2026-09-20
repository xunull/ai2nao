/**
 * 轮级占位行:跨进程互斥、执行权令牌(fence)、重复提交判定。
 *
 * 这些行为以前靠进程内的一个 Set(`runningThreadIds`),桌面版与开发版同时跑
 * 同一个会话时完全挡不住。这里全部打在库上,因为要挡的就是「另一个进程」。
 */
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openDatabase } from "../src/store/open.js";
import {
  claimChatRun,
  completeChatRun,
  createLlmChatSession,
  finishChatCall,
  getLlmChatSession,
  insertPendingChatCall,
  isChatRunCurrent,
  listChatCalls,
  listChatRuns,
  renewChatRunLease,
  replaceLlmChatSessionMessages,
} from "../src/llmChat/sessions.js";

function freshDb() {
  return openDatabase(
    join(tmpdir(), `ai2nao-chat-run-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
  );
}

function userMessage(id: string, text: string) {
  return { id, role: "user", content: text };
}

function assistantMessage(id: string, text: string) {
  return { id, role: "assistant", content: text };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("轮级占位行", () => {
  it("同一会话的第二次占用被拒,且不产生新的占位行", () => {
    const db = freshDb();
    try {
      const session = createLlmChatSession(db);
      const first = claimChatRun(db, session.id, "u1");
      expect(first.ok).toBe(true);

      const second = claimChatRun(db, session.id, "u2");
      expect(second).toEqual({ ok: false, reason: "running" });
      expect(listChatRuns(db, session.id)).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  it("终态之后可以再占,fence 递增", () => {
    const db = freshDb();
    try {
      const session = createLlmChatSession(db);
      const first = claimChatRun(db, session.id, "u1");
      if (!first.ok) throw new Error("first claim should succeed");
      expect(first.run.fence).toBe(1);

      completeChatRun(db, session.id, first.run.runId, "completed");
      const second = claimChatRun(db, session.id, "u2");
      if (!second.ok) throw new Error("second claim should succeed");
      expect(second.run.fence).toBe(2);
    } finally {
      db.close();
    }
  });

  it("租约过期后别的进程能接管 —— 心跳停了就不再拥有执行权", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-16T00:00:00.000Z"));
    const db = freshDb();
    try {
      const session = createLlmChatSession(db);
      const first = claimChatRun(db, session.id, "u1");
      if (!first.ok) throw new Error("first claim should succeed");

      // 还没过期:拒。
      vi.setSystemTime(new Date("2026-09-16T00:00:30.000Z"));
      expect(claimChatRun(db, session.id, "u2")).toEqual({ ok: false, reason: "running" });

      // 过期后:接管成功,fence 递增。
      vi.setSystemTime(new Date("2026-09-16T00:02:00.000Z"));
      const taken = claimChatRun(db, session.id, "u2");
      if (!taken.ok) throw new Error("takeover should succeed");
      expect(taken.run.fence).toBe(2);

      // 被接管之后,原持有者的 fence 不再是当前的 —— 它必须就此停手。
      expect(isChatRunCurrent(db, session.id, first.run.fence)).toBe(false);
      expect(isChatRunCurrent(db, session.id, taken.run.fence)).toBe(true);
    } finally {
      db.close();
    }
  });

  it("续期能把租约推后,从而挡住接管", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-16T00:00:00.000Z"));
    const db = freshDb();
    try {
      const session = createLlmChatSession(db);
      const first = claimChatRun(db, session.id, "u1");
      if (!first.ok) throw new Error("first claim should succeed");

      vi.setSystemTime(new Date("2026-09-16T00:00:45.000Z"));
      renewChatRunLease(db, session.id, first.run.runId);

      // 若没有续期,这一刻(75 秒)已经过期了。
      vi.setSystemTime(new Date("2026-09-16T00:01:15.000Z"));
      expect(claimChatRun(db, session.id, "u2")).toEqual({ ok: false, reason: "running" });
    } finally {
      db.close();
    }
  });

  it("同一条用户消息重复提交被判为 duplicate,而不是新一轮", () => {
    const db = freshDb();
    try {
      const session = createLlmChatSession(db);
      const first = claimChatRun(db, session.id, "u1");
      if (!first.ok) throw new Error("first claim should succeed");
      completeChatRun(db, session.id, first.run.runId, "completed");

      expect(claimChatRun(db, session.id, "u1")).toEqual({
        ok: false,
        reason: "duplicate",
        runId: first.run.runId,
      });
    } finally {
      db.close();
    }
  });

  it("失败或中止的那一轮不算 duplicate —— 用户重发必须真的重跑", () => {
    const db = freshDb();
    try {
      const session = createLlmChatSession(db);
      for (const status of ["failed", "aborted"] as const) {
        const claim = claimChatRun(db, session.id, `u-${status}`);
        if (!claim.ok) throw new Error("claim should succeed");
        completeChatRun(db, session.id, claim.run.runId, status);

        const again = claimChatRun(db, session.id, `u-${status}`);
        expect(again.ok, `${status} 之后重发应该重跑`).toBe(true);
        if (!again.ok) throw new Error("unreachable");
        completeChatRun(db, session.id, again.run.runId, "completed");
      }
    } finally {
      db.close();
    }
  });

  it("终态不可回退:迟到的事件改不动已经结束的那一轮", () => {
    const db = freshDb();
    try {
      const session = createLlmChatSession(db);
      const claim = claimChatRun(db, session.id, "u1");
      if (!claim.ok) throw new Error("claim should succeed");

      completeChatRun(db, session.id, claim.run.runId, "aborted");
      completeChatRun(db, session.id, claim.run.runId, "completed");

      expect(listChatRuns(db, session.id)[0]?.status).toBe("aborted");
    } finally {
      db.close();
    }
  });

  it("整轮覆盖写不会删掉占位行,也不会把它卷进重排", () => {
    const db = freshDb();
    try {
      const session = createLlmChatSession(db);
      const claim = claimChatRun(db, session.id, "u1");
      if (!claim.ok) throw new Error("claim should succeed");

      replaceLlmChatSessionMessages(db, session.id, {
        messages: [userMessage("u1", "问题"), assistantMessage("a1", "回答")],
      });

      // 占位行还在,状态没被动过。
      const runs = listChatRuns(db, session.id);
      expect(runs).toHaveLength(1);
      expect(runs[0]?.status).toBe("running");

      // 普通消息仍然是干净的 0..n-1,占位行留在保留区,没有撞号。
      const detail = getLlmChatSession(db, session.id)!;
      const normal = detail.messages.filter((m) => !m.message_id.startsWith("ai2nao:"));
      expect(normal.map((m) => m.message_id)).toEqual(["u1", "a1"]);
      expect(normal.map((m) => m.message_index)).toEqual([0, 1]);

      const runRow = detail.messages.find((m) => m.message_id.startsWith("ai2nao:"));
      expect(runRow?.message_index).toBeGreaterThanOrEqual(1_000_000);
    } finally {
      db.close();
    }
  });

  it("占位行不进 message_count,也不抢标题", () => {
    const db = freshDb();
    try {
      const session = createLlmChatSession(db);
      claimChatRun(db, session.id, "u1");
      const detail = replaceLlmChatSessionMessages(db, session.id, {
        messages: [userMessage("u1", "真正的标题"), assistantMessage("a1", "回答")],
      });

      expect(detail.message_count).toBe(2);
      expect(detail.title).toBe("真正的标题");
    } finally {
      db.close();
    }
  });

  it("★ 接管租约过期的一轮:它标成 aborted,名下 pending 的账一并 aborted;已结算的与活着的都不动", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-16T00:00:00.000Z"));
    const db = freshDb();
    try {
      const session = createLlmChatSession(db);
      const first = claimChatRun(db, session.id, "u1");
      if (!first.ok) throw new Error("first claim should succeed");
      const pending = (callId: string) =>
        insertPendingChatCall(db, session.id, {
          callId, runId: first.run.runId, fence: first.run.fence, purpose: "answer",
          stepIndex: 0, attempt: 0, model: null,
          sendView: { count: 1, prefixHash: "a".repeat(12), systemHash: "b".repeat(12), toolsHash: "c".repeat(12) },
          maxOutputTokens: 100,
        });
      pending("c:stale:0");
      pending("c:done:0");
      finishChatCall(db, session.id, "c:done:0", "completed", {
        input: 1, noCache: 1, cacheRead: 0, cacheWrite: 0, output: 1, reasoning: 0,
      });

      // 租约还活着:接管被拒,**什么都不能动** —— 那一笔可能正在另一个进程里跑。
      vi.setSystemTime(new Date("2026-09-16T00:00:30.000Z"));
      expect(claimChatRun(db, session.id, "u2")).toEqual({ ok: false, reason: "running" });
      expect(listChatCalls(db, session.id).find((c) => c.callId === "c:stale:0")?.status).toBe("pending");

      // 过期后接管:上一轮与它名下 pending 的账标 aborted;已结算的那笔保持 completed。
      vi.setSystemTime(new Date("2026-09-16T00:02:00.000Z"));
      const taken = claimChatRun(db, session.id, "u2");
      if (!taken.ok) throw new Error("takeover should succeed");
      const runs = listChatRuns(db, session.id);
      expect(runs.find((r) => r.runId === first.run.runId)?.status).toBe("aborted");
      const byId = new Map(listChatCalls(db, session.id).map((c) => [c.callId, c]));
      expect(byId.get("c:stale:0")?.status).toBe("aborted");
      expect(byId.get("c:stale:0")?.costState).toBe("unknown"); // 不知道就是不知道,不是 $0
      expect(byId.get("c:done:0")?.status).toBe("completed");

      // 原持有者醒来仍能按补写路径把用量补上 —— 这条路径正是为「被别人标成 aborted」准备的。
      finishChatCall(db, session.id, "c:stale:0", "completed", {
        input: 5, noCache: 5, cacheRead: 0, cacheWrite: 0, output: 2, reasoning: 0,
      });
      const after = listChatCalls(db, session.id).find((c) => c.callId === "c:stale:0");
      expect(after?.status).toBe("aborted");
      expect(after?.usage?.input).toBe(5);
    } finally {
      db.close();
    }
  });
});

