import { describe, expect, it } from "vitest";
import {
  extractCodexMessages,
  extractCodexUserMessages,
} from "../src/codexHistory/myMessages.js";
import type { Message } from "../src/cursorHistory/types.js";

/**
 * codex 的 AI 正文入库(2026-08-18)。
 *
 * 取代了原来那个「programmatic 就整场跳过」的布尔门。全量实测 349 个会话证明它把三种
 * 性质完全不同的会话压成了一类:
 *
 *   normal    126 会话  AI 正文 13.24 MB  user 清洗后 5933/5933 非空  → 两侧全收
 *   subagent  137 会话  AI 正文  2.57 MB  user 清洗后 1087/1884 非空  → 只收 assistant
 *   exec       86 会话  AI 正文  0.37 MB  user 清洗后   12/83 非空    → 两侧都跳
 *
 * **user 侧一条都不该变** —— normal 照收、另两类照跳,与 2026-08-18 之前逐条一致。
 * 真实语料验证:改动前后跑 ingest 都是 2204 条 is_human=1。
 */

let seq = 0;
const msg = (
  role: "user" | "assistant",
  content: string,
  metadata: Record<string, unknown> = {}
): Message =>
  ({
    id: `m-${++seq}`,
    role,
    content,
    timestamp: "2026-08-18T00:00:00.000Z",
    metadata,
  }) as unknown as Message;

/** event_msg 型 user —— 真人说的话走这条。 */
const userMsg = (content: string) => msg("user", content, { codexSource: "event_msg" });
/** agent_message 型 assistant —— AI 正文。 */
const aiMsg = (content: string) =>
  msg("assistant", content, { codexEventType: "agent_message" });
/** response_item 副本 —— normalize 已标 duplicate。 */
const dupMsg = (role: "user" | "assistant", content: string) =>
  msg(role, content, { codexSource: "response_item", readingHidden: "duplicate" });
/** 工具事件 —— normalize 已标 tool-only。 */
const toolMsg = (name: string) =>
  msg("assistant", `Tool call: ${name}`, {
    codexEventType: "function_call",
    codexToolEvent: true,
    readingHidden: "tool-only",
  });

/**
 * 每次调用都重置 id 计数器 —— 多处断言要跨两次调用比较结果(filter 视图等价、
 * 新旧门等价),id 不稳定的话比较必然失败,而那是测试自身的 bug 不是实现的。
 */
const conversation = (): Message[] => {
  seq = 0;
  return [
    userMsg("帮我看下 watermark 的问题"),
    aiMsg("水位是已经处理干净的时间点"),
    dupMsg("assistant", "水位是已经处理干净的时间点"),
    toolMsg("read_file"),
    aiMsg("另一段解释"),
    userMsg("继续"),
    aiMsg("好的"),
  ];
};

describe("extractCodexMessages —— 三态分流", () => {
  describe("normal(正常会话):两侧全收", () => {
    const out = () => extractCodexMessages(conversation(), { sessionKind: "normal" });

    it("user 与 assistant 都抽出来", () => {
      const r = out();
      expect(r.filter((m) => m.role === "user")).toHaveLength(2);
      expect(r.filter((m) => m.role === "assistant")).toHaveLength(3);
    });

    it("AI 消息带上它在回答的那条提问", () => {
      const ai = out().filter((m) => m.role === "assistant");
      const users = out().filter((m) => m.role === "user");
      expect(ai[0].answeringUserKey).toBe(users[0].messageKey);
      expect(ai[1].answeringUserKey).toBe(users[0].messageKey);
      // 第二个提问之后的 AI 回答,锚点跟着换
      expect(ai[2].answeringUserKey).toBe(users[1].messageKey);
    });

    it("user 行自己没有锚点", () => {
      expect(out().filter((m) => m.role === "user").every((m) => m.answeringUserKey === null)).toBe(true);
    });
  });

  describe("subagent:只收 assistant", () => {
    const out = () => extractCodexMessages(conversation(), { sessionKind: "subagent" });

    it("user 一条都不收 —— 它的 user 侧是派活的 prompt", () => {
      expect(out().filter((m) => m.role === "user")).toHaveLength(0);
    });

    it("assistant 照收 —— 那是 codex 写回来的内容,有价值", () => {
      expect(out().filter((m) => m.role === "assistant")).toHaveLength(3);
    });

    it("没有 user 就没有锚点,这是已知代价", () => {
      expect(out().every((m) => m.answeringUserKey === null)).toBe(true);
    });
  });

  describe("exec:两侧都跳", () => {
    it("整场返回空,与 2026-08-18 之前的 programmatic 行为一致", () => {
      expect(extractCodexMessages(conversation(), { sessionKind: "exec" })).toHaveLength(0);
    });

    it("旧调用方只传 programmatic:true 时按 exec 处理(向后兼容)", () => {
      expect(extractCodexMessages(conversation(), { programmatic: true })).toHaveLength(0);
    });

    it("旧调用方传 programmatic:false 时按 normal 处理", () => {
      const r = extractCodexMessages(conversation(), { programmatic: false });
      expect(r.filter((m) => m.role === "user")).toHaveLength(2);
    });
  });
});

describe("extractCodexMessages —— 被 readingHidden 标记的都不入库", () => {
  it("duplicate(response_item 副本)不收 —— 否则 AI 的话会多存 33.6%", () => {
    const r = extractCodexMessages(conversation(), { sessionKind: "normal" });
    // 那条 dup 与前一条 AI 内容完全相同,只应出现一次
    expect(r.filter((m) => m.cleanedText === "水位是已经处理干净的时间点")).toHaveLength(1);
  });

  it("tool-only(工具事件占位符)不收", () => {
    const r = extractCodexMessages(conversation(), { sessionKind: "normal" });
    expect(r.some((m) => m.cleanedText.startsWith("Tool call:"))).toBe(false);
  });

  it("user 侧的 response_item 副本也不收(双重记录两侧都有)", () => {
    const r = extractCodexMessages(
      [userMsg("真的提问"), dupMsg("user", "真的提问")],
      { sessionKind: "normal" }
    );
    expect(r).toHaveLength(1);
  });
});

describe("extractCodexMessages —— 会话内按内容去重", () => {
  it("同一会话里两条一模一样的 AI 消息只留一条", () => {
    // readingHidden 的 duplicate 是按**来源**判的(response_item),挡不住
    // 同一内容在两条 agent_message 里出现,所以还需要内容去重。
    const r = extractCodexMessages(
      [userMsg("问"), aiMsg("同样的回答"), aiMsg("同样的回答")],
      { sessionKind: "normal" }
    );
    expect(r.filter((m) => m.role === "assistant")).toHaveLength(1);
  });

  it("空内容的 assistant 不入库(不往 FTS 写空串)", () => {
    const r = extractCodexMessages([userMsg("问"), aiMsg("   ")], {
      sessionKind: "normal",
    });
    expect(r.filter((m) => m.role === "assistant")).toHaveLength(0);
  });
});

describe("extractCodexUserMessages —— filter 视图", () => {
  it("输出逐条等于 extractCodexMessages 的 user 子集", () => {
    for (const kind of ["normal", "subagent", "exec"] as const) {
      const viaFilter = extractCodexMessages(conversation(), { sessionKind: kind }).filter(
        (m) => m.role === "user"
      );
      expect(extractCodexUserMessages(conversation(), { sessionKind: kind })).toEqual(
        viaFilter
      );
    }
  });

  it("IRON RULE:三态下的 user 集合与旧布尔门逐条一致", () => {
    // 旧行为:programmatic=false 收 user、true 整场跳。
    // 新行为:normal 收 user、subagent 与 exec 都不收 user。
    // 两者在 user 侧完全等价 —— 这正是「改动前后 ingest 都是 2204 条」的原因。
    const asNormal = extractCodexUserMessages(conversation(), { sessionKind: "normal" });
    const asOldFalse = extractCodexUserMessages(conversation(), { programmatic: false });
    expect(asNormal).toEqual(asOldFalse);

    for (const kind of ["subagent", "exec"] as const) {
      expect(extractCodexUserMessages(conversation(), { sessionKind: kind })).toHaveLength(0);
    }
  });

  it("user 行的 isHuman 由清洗结果决定,与角色无关", () => {
    const r = extractCodexUserMessages(
      [userMsg("真的提问"), userMsg("   ")],
      { sessionKind: "normal" }
    );
    expect(r.map((m) => m.isHuman)).toEqual([true, false]);
  });
});
