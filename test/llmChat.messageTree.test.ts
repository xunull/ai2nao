import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import {
  activePathIds,
  branchPosition,
  deepestLeafFrom,
  ensureLlmChatSession,
  getActiveLeafId,
  nextBranchIndex,
  replaceLlmChatSessionMessages,
  setActiveLeaf,
  siblingIds,
} from "../src/llmChat/sessions.js";
import { openDatabase } from "../src/store/open.js";

/**
 * AI 对话的消息树(V61):重新生成 / 编辑重发 / 分支切换。
 *
 * 三条最要紧的性质:
 *  1. **只有激活路径算数** —— 发给模型的上下文、界面看到的对话、压缩的作用域都认它
 *  2. **activity 行不在树上**(run / 账目 / 工具执行 / 压缩,index >= 1e6),parent 恒 null
 *  3. **切换分支只动一个指针**,一条消息都不删 —— 原提问和已经花钱生成的回答都留着
 */

function freshDb(): Database.Database {
  return openDatabase(join(mkdtempSync(join(tmpdir(), "ai2nao-tree-")), "index.db"));
}

const NOW = "2026-09-24T00:00:00.000Z";

/** 直接写树节点。绕开整轮覆盖写,这里只测树本身。 */
function addNode(
  db: Database.Database,
  sessionId: string,
  o: { id: string; parent: string | null; index: number; branch?: number; role?: string }
): void {
  db.prepare(
    `INSERT INTO llm_chat_messages
       (id, session_id, message_id, message_index, role, raw_json, plain_text, preview,
        created_at, updated_at, parent_id, branch_index)
     VALUES (?, ?, ?, ?, ?, '{}', ?, ?, ?, ?, ?, ?)`
  ).run(
    `${sessionId}:${o.id}`, sessionId, o.id, o.index, o.role ?? "user",
    o.id, o.id, NOW, NOW, o.parent, o.branch ?? 0
  );
}

/** 一问一答的直链:u1 → a1。 */
function straight(db: Database.Database): string {
  const sid = "s1";
  ensureLlmChatSession(db, sid, "测试");
  addNode(db, sid, { id: "u1", parent: null, index: 0 });
  addNode(db, sid, { id: "a1", parent: "u1", index: 1, role: "assistant" });
  setActiveLeaf(db, sid, "a1");
  return sid;
}

describe("激活路径", () => {
  it("从叶子回溯到根,给出时序", () => {
    const db = freshDb();
    const sid = straight(db);
    expect(activePathIds(db, sid)).toEqual(["u1", "a1"]);
    db.close();
  });

  it("没有树也没有 active_leaf 时回退到平铺 —— V61 之前的老库", () => {
    const db = freshDb();
    ensureLlmChatSession(db, "s1", "测试");
    addNode(db, "s1", { id: "u1", parent: null, index: 0 });
    addNode(db, "s1", { id: "a1", parent: null, index: 1, role: "assistant" });
    expect(getActiveLeafId(db, "s1")).toBeNull();
    expect(activePathIds(db, "s1")).toEqual(["u1", "a1"]);
    db.close();
  });

  it("有树但叶子为空 → 空路径,不是把所有分支平铺出来", () => {
    // 编辑首问时会短暂处于这个状态:叶子退到 null,等新提问落地。
    // 这里平铺的话,其他分支会整批冒出来当成当前对话。
    const db = freshDb();
    ensureLlmChatSession(db, "s1", "测试");
    addNode(db, "s1", { id: "u1", parent: null, index: 0 });
    addNode(db, "s1", { id: "a1", parent: "u1", index: 1, role: "assistant" });
    expect(activePathIds(db, "s1")).toEqual([]);
    db.close();
  });

  it("activity 行不在树上 —— 账目不该出现在对话里", () => {
    const db = freshDb();
    const sid = straight(db);
    addNode(db, sid, { id: "run-1", parent: null, index: 1_000_001, role: "assistant" });
    addNode(db, sid, { id: "call-1", parent: null, index: 2_000_000, role: "assistant" });
    expect(activePathIds(db, sid)).toEqual(["u1", "a1"]);
    db.close();
  });

  it("parent 指针成环时停下,不挂住请求", () => {
    const db = freshDb();
    ensureLlmChatSession(db, "s1", "测试");
    addNode(db, "s1", { id: "a", parent: "b", index: 0 });
    addNode(db, "s1", { id: "b", parent: "a", index: 1 });
    setActiveLeaf(db, "s1", "a");
    expect(activePathIds(db, "s1")).toEqual(["b", "a"]);
    db.close();
  });

  it("空会话给空数组", () => {
    const db = freshDb();
    ensureLlmChatSession(db, "s1", "测试");
    expect(activePathIds(db, "s1")).toEqual([]);
    db.close();
  });
});

describe("重新生成:同一 parent 下长出第二个 assistant", () => {
  it("切到旧分支后,激活路径变回旧答案 —— 两条都还在", () => {
    const db = freshDb();
    const sid = straight(db);
    addNode(db, sid, { id: "a2", parent: "u1", index: 2, branch: 1, role: "assistant" });
    setActiveLeaf(db, sid, "a2");
    expect(activePathIds(db, sid)).toEqual(["u1", "a2"]);

    setActiveLeaf(db, sid, "a1");
    expect(activePathIds(db, sid)).toEqual(["u1", "a1"]);
    // 一条都没删
    expect(siblingIds(db, sid, "u1")).toEqual(["a1", "a2"]);
    db.close();
  });

  it("branchPosition 给出 1/2、2/2", () => {
    const db = freshDb();
    const sid = straight(db);
    addNode(db, sid, { id: "a2", parent: "u1", index: 2, branch: 1, role: "assistant" });
    expect(branchPosition(db, sid, "a1")).toEqual({ branchIndex: 0, numberOfBranches: 2 });
    expect(branchPosition(db, sid, "a2")).toEqual({ branchIndex: 1, numberOfBranches: 2 });
    db.close();
  });

  it("只有一个回答时 numberOfBranches 是 1 —— 界面据此不渲染导航", () => {
    const db = freshDb();
    const sid = straight(db);
    expect(branchPosition(db, sid, "a1").numberOfBranches).toBe(1);
    db.close();
  });

  it("nextBranchIndex 让新分支永远排在最后", () => {
    const db = freshDb();
    const sid = straight(db);
    expect(nextBranchIndex(db, sid, "u1")).toBe(1);
    addNode(db, sid, { id: "a2", parent: "u1", index: 2, branch: 1, role: "assistant" });
    expect(nextBranchIndex(db, sid, "u1")).toBe(2);
    // 根一层也要能算(编辑第一条提问时用)
    expect(nextBranchIndex(db, sid, null)).toBe(1);
    db.close();
  });
});

describe("编辑重发:同一 parent 下长出第二个 user", () => {
  it("原提问与它下面的回答都留着,可以切回去", () => {
    const db = freshDb();
    const sid = straight(db);
    // 编辑 u1 → 在根下新建 u2,并在它下面答一次
    addNode(db, sid, { id: "u2", parent: null, index: 2, branch: 1 });
    addNode(db, sid, { id: "a3", parent: "u2", index: 3, role: "assistant" });
    setActiveLeaf(db, sid, "a3");
    expect(activePathIds(db, sid)).toEqual(["u2", "a3"]);

    setActiveLeaf(db, sid, "a1");
    expect(activePathIds(db, sid)).toEqual(["u1", "a1"]);
    expect(siblingIds(db, sid, null)).toEqual(["u1", "u2"]);
    db.close();
  });
});

describe("deepestLeafFrom", () => {
  it("切到某个分支时沿最新的兄弟走到底", () => {
    const db = freshDb();
    const sid = straight(db);
    addNode(db, sid, { id: "u2", parent: "a1", index: 2 });
    addNode(db, sid, { id: "a2", parent: "u2", index: 3, role: "assistant" });
    expect(deepestLeafFrom(db, sid, "u1")).toBe("a2");
    db.close();
  });

  it("叶子本身返回自己", () => {
    const db = freshDb();
    const sid = straight(db);
    expect(deepestLeafFrom(db, sid, "a1")).toBe("a1");
    db.close();
  });
});

/**
 * **整轮覆盖写不许毁掉其他分支。**
 *
 * `replaceLlmChatSessionMessages` 的老规则是「不在客户端集合里就删、其余全部重排」。
 * 客户端只认识激活路径 —— 照老规则,你点「重新生成」保住的那个旧答案,
 * 再说一句话就没了;而且重排会把它的 message_index 取负之后永久停在负数区。
 *
 * 这一组是这个功能里最该有的回归测试。
 */
describe("覆盖写与分支共存", () => {
  const msg = (id: string, role: "user" | "assistant", text: string) => ({
    id,
    role,
    content: text,
  });

  it("下一轮对话不会删掉其他分支,也不会把它的索引弄负", () => {
    const db = freshDb();
    const sid = straight(db); // u1 → a1
    addNode(db, sid, { id: "a2", parent: "u1", index: 2, branch: 1, role: "assistant" });
    setActiveLeaf(db, sid, "a2");

    // 客户端接着说了一句:它传的是激活路径 [u1, a2] 加新的 u2
    replaceLlmChatSessionMessages(db, sid, {
      messages: [
        msg("u1", "user", "第一问"),
        msg("a2", "assistant", "新答案"),
        msg("u2", "user", "第二问"),
      ] as never[],
    });

    const all = db
      .prepare(
        `SELECT message_id, message_index FROM llm_chat_messages
         WHERE session_id = ? AND message_index < 1000000 ORDER BY message_index`
      )
      .all(sid) as { message_id: string; message_index: number }[];

    // a1 还在
    expect(all.map((r) => r.message_id).sort()).toEqual(["a1", "a2", "u1", "u2"]);
    // 没有任何行掉进负数区
    expect(all.every((r) => r.message_index >= 0)).toBe(true);
    // 切回去仍然拿得到旧答案
    setActiveLeaf(db, sid, "a1");
    expect(activePathIds(db, sid)).toEqual(["u1", "a1"]);
    db.close();
  });

  it("新消息挂在前一条下面,激活叶子跟着走", () => {
    const db = freshDb();
    const sid = straight(db);
    replaceLlmChatSessionMessages(db, sid, {
      messages: [
        msg("u1", "user", "第一问"),
        msg("a1", "assistant", "第一答"),
        msg("u2", "user", "第二问"),
      ] as never[],
    });
    expect(activePathIds(db, sid)).toEqual(["u1", "a1", "u2"]);
    expect(getActiveLeafId(db, sid)).toBe("u2");
    db.close();
  });

  it("已有行的父子关系不被客户端覆盖 —— 覆盖就等于把树压平", () => {
    const db = freshDb();
    const sid = straight(db);
    addNode(db, sid, { id: "a2", parent: "u1", index: 2, branch: 1, role: "assistant" });
    setActiveLeaf(db, sid, "a2");
    replaceLlmChatSessionMessages(db, sid, {
      messages: [msg("u1", "user", "第一问"), msg("a2", "assistant", "新答案")] as never[],
    });
    const a1 = db
      .prepare("SELECT parent_id FROM llm_chat_messages WHERE session_id = ? AND message_id = 'a1'")
      .get(sid) as { parent_id: string | null };
    expect(a1.parent_id).toBe("u1"); // 没被压平成别的
    db.close();
  });
});
