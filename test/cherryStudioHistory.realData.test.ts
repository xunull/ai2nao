import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  countTopics,
  listTopics,
  loadTopic,
  openCherryStudioDb,
  searchMessages,
} from "../src/cherryStudioHistory/db.js";
import { cherryStudioDbPath, defaultCherryStudioRoot } from "../src/cherryStudioHistory/paths.js";

/**
 * 真机对账。夹具测的是「代码符合我对格式的理解」,这里测的是**那个理解对不对** ——
 * schema 是从真库抄的子集,真库里总有夹具想不到的形状(空 parts、没有 assistant 的
 * topic、active_node_id 指向已删消息)。
 *
 * 别人的机器上没有 Cherry Studio,所以条件跳过;只读,不写一个字节;
 * 路径一律走 defaultCherryStudioRoot(),不写字面量(公开仓库,gitleaks 拦真实 home 路径)。
 */
const DB_PATH = cherryStudioDbPath(defaultCherryStudioRoot());
const hasCherry = existsSync(DB_PATH);

describe.skipIf(!hasCherry)("Cherry Studio 真实数据对账", () => {
  it("每个 topic 都能取出会话,不抛也不返回 null", () => {
    const db = openCherryStudioDb(DB_PATH);
    try {
      const summaries = listTopics(db);
      expect(summaries.length).toBe(countTopics(db));
      expect(summaries.length).toBeGreaterThan(0);
      for (const s of summaries) {
        const session = loadTopic(db, s.id);
        expect(session, `topic ${s.id} 读不出来`).not.toBeNull();
      }
    } finally {
      db.close();
    }
  });

  it("列表里的消息数与详情里实际取到的条数一致", () => {
    const db = openCherryStudioDb(DB_PATH);
    try {
      // 列表数的是 topic 下全部未删消息,详情取的是激活路径 —— 有分支时详情会更少。
      // 真库当前 0 个分支,两者应当逐场相等;哪天不等了,说明出现了分支,
      // 那时这条会红,提醒我们去看列表的计数口径该不该跟着改。
      for (const s of listTopics(db)) {
        const session = loadTopic(db, s.id)!;
        expect(session.messages.length, `topic ${s.id} 计数对不上`).toBe(s.messageCount);
      }
    } finally {
      db.close();
    }
  });

  it("assistant 消息里确实带得出思考过程 —— 真库有 reasoning part", () => {
    const db = openCherryStudioDb(DB_PATH);
    try {
      const withThinking = listTopics(db)
        .flatMap((s) => loadTopic(db, s.id)!.messages)
        .filter((m) => m.thinking && m.thinking.trim() !== "");
      expect(withThinking.length).toBeGreaterThan(0);
      // 思考过程不能混进正文 —— 搜索口径只认 content
      for (const m of withThinking.slice(0, 20)) {
        expect(m.content.includes(m.thinking!)).toBe(false);
      }
    } finally {
      db.close();
    }
  });

  it("两字中文查询在真库上也能命中(FTS 走不通的那条回退)", () => {
    const db = openCherryStudioDb(DB_PATH);
    try {
      const first = listTopics(db)
        .map((s) => s.preview)
        .find((p) => [...p].length >= 6);
      if (!first) return; // 库里全是超短首句,这条没法测
      const needle = [...first].slice(2, 4).join("");
      expect(searchMessages(db, needle, { limit: 5, contextChars: 40 }).length).toBeGreaterThan(0);
    } finally {
      db.close();
    }
  });
});
