import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import type { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/serve/app.js";
import {
  activePathIds,
  ensureLlmChatSession,
  setActiveLeaf,
} from "../src/llmChat/sessions.js";
import { openDatabase } from "../src/store/open.js";

/**
 * 分支路由。**服务端拥有树的语义,客户端只说意图** ——
 * 三种动作的区别只有一个:把激活叶子移到哪。
 *
 * 重新生成与编辑重发都不在路由里发起模型调用:移动叶子之后由客户端正常发一轮,
 * 新消息自然挂在新叶子下面。这样两者复用了完全相同的那条发送路径,没有第二套运行时。
 */

const NOW = "2026-09-24T00:00:00.000Z";

function setup(): { db: Database.Database; app: Hono } {
  const db = openDatabase(join(mkdtempSync(join(tmpdir(), "ai2nao-branch-")), "index.db"));
  return { db, app: createApp({ db }) };
}

function addNode(
  db: Database.Database,
  sid: string,
  o: { id: string; parent: string | null; index: number; branch?: number; role?: string }
): void {
  db.prepare(
    `INSERT INTO llm_chat_messages
       (id, session_id, message_id, message_index, role, raw_json, plain_text, preview,
        created_at, updated_at, parent_id, branch_index)
     VALUES (?, ?, ?, ?, ?, '{}', ?, ?, ?, ?, ?, ?)`
  ).run(`${sid}:${o.id}`, sid, o.id, o.index, o.role ?? "user", o.id, o.id, NOW, NOW, o.parent, o.branch ?? 0);
}

/** u1 →(a1 | a2),当前激活 a2。 */
function twoAnswers(db: Database.Database): string {
  const sid = "s1";
  ensureLlmChatSession(db, sid, "测试");
  addNode(db, sid, { id: "u1", parent: null, index: 0 });
  addNode(db, sid, { id: "a1", parent: "u1", index: 1, role: "assistant" });
  addNode(db, sid, { id: "a2", parent: "u1", index: 2, branch: 1, role: "assistant" });
  setActiveLeaf(db, sid, "a2");
  return sid;
}

const post = (app: Hono, sid: string, body: unknown) =>
  app.request(`/api/llm-chat/sessions/${sid}/branch`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

describe("分支路由", () => {
  it("switch:切到旧答案,激活路径跟着变,needsRun 为 false", async () => {
    const { db, app } = setup();
    const sid = twoAnswers(db);
    const res = await post(app, sid, { action: "switch", messageId: "a1" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { activePathIds: string[]; needsRun: boolean };
    expect(body.activePathIds).toEqual(["u1", "a1"]);
    expect(body.needsRun).toBe(false);
    expect(activePathIds(db, sid)).toEqual(["u1", "a1"]);
    db.close();
  });

  it("regenerate:叶子退回那条提问,needsRun 为 true —— 再跑一轮就长出第三个答案", async () => {
    const { db, app } = setup();
    const sid = twoAnswers(db);
    const body = (await (await post(app, sid, { action: "regenerate", messageId: "a2" })).json()) as {
      activePathIds: string[];
      needsRun: boolean;
    };
    expect(body.activePathIds).toEqual(["u1"]);
    expect(body.needsRun).toBe(true);
    db.close();
  });

  it("edit 首问:叶子清空 → 空路径,而不是把所有分支平铺出来", async () => {
    const { db, app } = setup();
    const sid = twoAnswers(db);
    const body = (await (await post(app, sid, { action: "edit", messageId: "u1" })).json()) as {
      activePathIds: string[];
    };
    expect(body.activePathIds).toEqual([]);
    db.close();
  });

  it("switch 带 branchIndex:按序号切到那条 user 的第 N 个回答", async () => {
    const { db, app } = setup();
    const sid = twoAnswers(db); // u1 →(a1 | a2),当前 a2
    // 界面只知道「切到第 0 个」,不知道 a1 这个 id —— 由服务端解析
    const body = (await (
      await post(app, sid, { action: "switch", messageId: "u1", branchIndex: 0 })
    ).json()) as { activePathIds: string[] };
    expect(body.activePathIds).toEqual(["u1", "a1"]);

    const back = (await (
      await post(app, sid, { action: "switch", messageId: "u1", branchIndex: 1 })
    ).json()) as { activePathIds: string[] };
    expect(back.activePathIds).toEqual(["u1", "a2"]);
    db.close();
  });

  it("序号越界时退回那条消息自己,不炸", async () => {
    const { db, app } = setup();
    const sid = twoAnswers(db);
    const body = (await (
      await post(app, sid, { action: "switch", messageId: "u1", branchIndex: 99 })
    ).json()) as { activePathIds: string[] };
    expect(body.activePathIds[0]).toBe("u1");
    db.close();
  });

  it("切换是纯指针操作 —— 一条消息都没少", async () => {
    const { db, app } = setup();
    const sid = twoAnswers(db);
    await post(app, sid, { action: "switch", messageId: "a1" });
    const n = db
      .prepare("SELECT COUNT(*) AS n FROM llm_chat_messages WHERE session_id = ?")
      .get(sid) as { n: number };
    expect(n.n).toBe(3);
    db.close();
  });

  it("非法 action / 缺 messageId → 400;会话不存在 → 404", async () => {
    const { db, app } = setup();
    const sid = twoAnswers(db);
    expect((await post(app, sid, { action: "nope", messageId: "a1" })).status).toBe(400);
    expect((await post(app, sid, { action: "switch" })).status).toBe(400);
    expect((await post(app, "没这个会话", { action: "switch", messageId: "a1" })).status).toBe(404);
    db.close();
  });

  it("branches 接口给出 ‹1/2›,挂在那条 user 上", async () => {
    const { db, app } = setup();
    const sid = twoAnswers(db);
    const body = (await (await app.request(`/api/llm-chat/sessions/${sid}/branches`)).json()) as {
      branches: Record<string, { branchIndex: number; numberOfBranches: number }>;
    };
    // 当前激活 a2(第二个答案)
    expect(body.branches.u1).toEqual({ branchIndex: 1, numberOfBranches: 2 });

    await post(app, sid, { action: "switch", messageId: "a1" });
    const after = (await (await app.request(`/api/llm-chat/sessions/${sid}/branches`)).json()) as {
      branches: Record<string, { branchIndex: number }>;
    };
    expect(after.branches.u1!.branchIndex).toBe(0);
    db.close();
  });

  it("只有一个回答时不下发分支信息 —— 界面据此不渲染导航", async () => {
    const { db, app } = setup();
    ensureLlmChatSession(db, "s2", "测试");
    addNode(db, "s2", { id: "u1", parent: null, index: 0 });
    addNode(db, "s2", { id: "a1", parent: "u1", index: 1, role: "assistant" });
    setActiveLeaf(db, "s2", "a1");
    const body = (await (await app.request("/api/llm-chat/sessions/s2/branches")).json()) as {
      branches: Record<string, unknown>;
    };
    expect(Object.keys(body.branches)).toEqual([]);
    db.close();
  });
});
