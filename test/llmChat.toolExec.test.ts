/**
 * 有副作用的工具:执行前落记录(分歧 7)。
 *
 * 这个文件里最要紧的是**顺序**,不是「跑完之后库里有行」—— 后者在
 * 「先跑后记」的实现下同样成立,等于没测。所以塞一个假 `BashToolService`,
 * 在它的 `run` 被调用的那一刻探库:先记后跑才探得到 `started`。
 */
import { existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { BashToolResult, BashToolService } from "../src/bashTool/index.js";
import { createBashExecRecorder } from "../src/llmChat/copilotRuntime.js";
import {
  claimChatRun,
  completeChatRun,
  ensureLlmChatSession,
  finishChatToolExec,
  listChatToolExecs,
  markStaleToolExecsUnknown,
  startChatToolExec,
} from "../src/llmChat/sessions.js";
import { createBashTool } from "../src/llmTools/bashTool.js";
import { openDatabase } from "../src/store/open.js";

function tempDbPath(name: string): string {
  return join(tmpdir(), `ai2nao-${Date.now()}-${Math.random().toString(36).slice(2)}-${name}`);
}

/** 假结果。字段照 `deniedResult` 的必填集合给,不多不少。 */
function fakeResult(over?: Partial<BashToolResult>): BashToolResult {
  return {
    ok: true,
    command: "echo hi",
    cwd: ".",
    risk: "read-only",
    exitCode: 0,
    timedOut: false,
    durationMs: 1,
    stdout: "hi",
    stderr: "",
    outputTruncated: false,
    ...over,
  };
}

function withDb(name: string, run: (db: ReturnType<typeof openDatabase>) => Promise<void> | void) {
  return async () => {
    const path = tempDbPath(name);
    const db = openDatabase(path);
    try {
      await run(db);
    } finally {
      db.close();
      if (existsSync(path)) unlinkSync(path);
    }
  };
}

describe("bash 执行前落记录", () => {
  it(
    "记录落在命令执行之前 —— service.run 发生的那一刻,库里已经是 started",
    withDb("tool-exec-order.db", async (db) => {
      const sessionId = "t-order";
      ensureLlmChatSession(db, sessionId);
      const claim = claimChatRun(db, sessionId, "u1");
      expect(claim.ok).toBe(true);
      if (!claim.ok) return;

      const probes: string[][] = [];
      const service: BashToolService = {
        run: async () => {
          probes.push(listChatToolExecs(db, sessionId).map((e) => e.status));
          return fakeResult();
        },
      };

      const shell = createBashTool(service, {
        defaultTimeoutMs: 5_000,
        execRecorder: createBashExecRecorder(db, sessionId, claim.run.runId, claim.run.fence),
      });
      const out = (await shell.execute!(
        { command: "echo hi" },
        { toolCallId: "call-1", messages: [] }
      )) as BashToolResult;

      expect(out.ok).toBe(true);
      // **非空转的关键。** 先记后跑 → [["started"]];先跑后记 → [[]]。
      expect(probes).toEqual([["started"]]);

      const rows = listChatToolExecs(db, sessionId);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.status).toBe("completed");
      expect(rows[0]?.exitCode).toBe(0);
      expect(rows[0]?.command).toBe("echo hi");
      expect(rows[0]?.runId).toBe(claim.run.runId);
      expect(rows[0]?.fence).toBe(claim.run.fence);
    })
  );

  it(
    "执行权已易主:命令一个字节都不跑,也不留记录",
    withDb("tool-exec-superseded.db", async (db) => {
      const sessionId = "t-superseded";
      ensureLlmChatSession(db, sessionId);
      const first = claimChatRun(db, sessionId, "u1");
      expect(first.ok).toBe(true);
      if (!first.ok) return;
      // 第一轮收尾后别人占住 —— fence +1,旧进程手里的 fence 就过期了。
      completeChatRun(db, sessionId, first.run.runId, "completed");
      const second = claimChatRun(db, sessionId, "u2");
      expect(second.ok).toBe(true);
      if (!second.ok) return;
      expect(second.run.fence).toBeGreaterThan(first.run.fence);

      let ran = false;
      const service: BashToolService = {
        run: async () => {
          ran = true;
          return fakeResult();
        },
      };

      // 用**旧** fence 建记录器 = 被接管后醒来的那个进程。
      const shell = createBashTool(service, {
        defaultTimeoutMs: 5_000,
        execRecorder: createBashExecRecorder(db, sessionId, first.run.runId, first.run.fence),
      });
      const out = (await shell.execute!(
        { command: "rm -rf build" },
        { toolCallId: "call-stale", messages: [] }
      )) as BashToolResult;

      expect(ran).toBe(false);
      expect(out.ok).toBe(false);
      expect(out.deniedReason).toContain("接管");
      expect(listChatToolExecs(db, sessionId)).toEqual([]);
    })
  );

  it(
    "失败也落终态,带上退出码",
    withDb("tool-exec-failed.db", async (db) => {
      const sessionId = "t-failed";
      ensureLlmChatSession(db, sessionId);
      const claim = claimChatRun(db, sessionId, "u1");
      if (!claim.ok) throw new Error("claim failed");

      const service: BashToolService = {
        run: async () => fakeResult({ ok: false, exitCode: 1, stderr: "boom" }),
      };
      const shell = createBashTool(service, {
        defaultTimeoutMs: 5_000,
        execRecorder: createBashExecRecorder(db, sessionId, claim.run.runId, claim.run.fence),
      });
      await shell.execute!({ command: "npm run test" }, { toolCallId: "call-2", messages: [] });

      const rows = listChatToolExecs(db, sessionId);
      expect(rows[0]?.status).toBe("failed");
      expect(rows[0]?.exitCode).toBe(1);
    })
  );

  it(
    "终态不可回退:迟到的事件改不动已经结束的那一条",
    withDb("tool-exec-terminal.db", async (db) => {
      const sessionId = "t-terminal";
      ensureLlmChatSession(db, sessionId);
      const claim = claimChatRun(db, sessionId, "u1");
      if (!claim.ok) throw new Error("claim failed");

      const started = startChatToolExec(db, sessionId, {
        toolCallId: "call-1",
        runId: claim.run.runId,
        fence: claim.run.fence,
        toolName: "ai2nao_run_shell",
        command: "echo hi",
        cwd: null,
      });
      expect(started.ok).toBe(true);

      finishChatToolExec(db, sessionId, "call-1", "completed", 0);
      finishChatToolExec(db, sessionId, "call-1", "failed", 1);

      const rows = listChatToolExecs(db, sessionId);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.status).toBe("completed");
      expect(rows[0]?.exitCode).toBe(0);
    })
  );

  it(
    "被接管后,旧 fence 的 started 标成结果未知;当前 fence 的不动",
    withDb("tool-exec-unknown.db", async (db) => {
      const sessionId = "t-unknown";
      ensureLlmChatSession(db, sessionId);
      const first = claimChatRun(db, sessionId, "u1");
      if (!first.ok) throw new Error("claim failed");
      // 旧一轮跑到一半:只有 started,没有终态。
      startChatToolExec(db, sessionId, {
        toolCallId: "call-old",
        runId: first.run.runId,
        fence: first.run.fence,
        toolName: "ai2nao_run_shell",
        command: "npm run build",
        cwd: null,
      });

      completeChatRun(db, sessionId, first.run.runId, "aborted");
      const second = claimChatRun(db, sessionId, "u2");
      if (!second.ok) throw new Error("second claim failed");
      startChatToolExec(db, sessionId, {
        toolCallId: "call-new",
        runId: second.run.runId,
        fence: second.run.fence,
        toolName: "ai2nao_run_shell",
        command: "echo new",
        cwd: null,
      });

      const marked = markStaleToolExecsUnknown(db, sessionId, second.run.fence);
      expect(marked).toBe(1);

      const byId = Object.fromEntries(listChatToolExecs(db, sessionId).map((e) => [e.toolCallId, e]));
      expect(byId["call-old"]?.status).toBe("unknown");
      // 本轮自己的那条不能被顺手标掉 —— 它还在跑。
      expect(byId["call-new"]?.status).toBe("started");

      // 再标一次不会把已经 unknown 的重复计数。
      expect(markStaleToolExecsUnknown(db, sessionId, second.run.fence)).toBe(0);
    })
  );
});
