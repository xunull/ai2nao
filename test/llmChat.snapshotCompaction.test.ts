import { existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Message } from "@ag-ui/core";
import { ActivityMessageSchema } from "@ag-ui/core";
import { threadSnapshot } from "../src/llmChat/copilotRuntime.js";
import {
  activateChatCompaction,
  ensureLlmChatSession,
  replaceLlmChatSessionMessages,
  revertChatCompaction,
} from "../src/llmChat/sessions.js";
import { openDatabase } from "../src/store/open.js";

/**
 * 重连快照按生效压缩裁剪(粗 T7)。
 *
 * **前端没有 activityType 渲染器**,分隔线在界面上本来就看不见 —— 它有没有被放行、
 * 排在哪里,只有这里看得见。下面每条针对的都是静默错。
 */

function withDb(run: (db: ReturnType<typeof openDatabase>) => void): void {
  const path = join(
    tmpdir(),
    `ai2nao-snap-${Date.now()}-${Math.random().toString(36).slice(2)}.db`
  );
  const db = openDatabase(path);
  try {
    run(db);
  } finally {
    db.close();
    if (existsSync(path)) unlinkSync(path);
  }
}

/** 下标 0..3。 */
const history = (): Message[] => [
  { id: "u1", role: "user", content: "第一问" } as Message,
  { id: "a1", role: "assistant", content: "第一答" } as Message,
  { id: "u2", role: "user", content: "第二问" } as Message,
  { id: "a2", role: "assistant", content: "第二答" } as Message,
];

const seedCompaction = (
  db: ReturnType<typeof openDatabase>,
  sid: string,
  id: string,
  excluded: string[]
) =>
  activateChatCompaction(db, sid, {
    id,
    trigger: "manual",
    excludedMessageIds: excluded,
    summary: { decisions: [], constraints: [], state: [], nextSteps: [] },
    summaryCallIds: [],
  });

const ids = (ms: Message[]) => ms.map((m) => m.id);

describe("重连快照 × 压缩", () => {
  it("★ 没有压缩时与改动前一致:全部普通消息,零服务端专有行", () => {
    withDb((db) => {
      ensureLlmChatSession(db, "s1");
      replaceLlmChatSessionMessages(db, "s1", { messages: history() });
      // 这条是回归闸:绝大多数会话没有压缩,它们的快照一个字都不该变。
      expect(ids(threadSnapshot({ db }, "s1"))).toEqual(["u1", "a1", "u2", "a2"]);
    });
  });

  it("★ 排除集合里的消息被裁掉,别的一条不少", () => {
    withDb((db) => {
      ensureLlmChatSession(db, "s1");
      replaceLlmChatSessionMessages(db, "s1", { messages: history() });
      seedCompaction(db, "s1", "k1", ["u1", "a1"]);
      const out = threadSnapshot({ db }, "s1");
      expect(ids(out).filter((i) => i !== "ai2nao:compaction:k1")).toEqual(["u2", "a2"]);
    });
  });

  it("★ 分隔线被放行,而且排在最前 —— 它的行在 4e6 段,自然排序会排到最后", () => {
    withDb((db) => {
      ensureLlmChatSession(db, "s1");
      replaceLlmChatSessionMessages(db, "s1", { messages: history() });
      seedCompaction(db, "s1", "k1", ["u1", "a1"]);
      const out = threadSnapshot({ db }, "s1");
      expect(out[0]?.id).toBe("ai2nao:compaction:k1");
      expect((out[0] as { role?: string }).role).toBe("activity");
    });
  });

  it("★ 撤销之后分隔线消失,被折叠的消息回来", () => {
    withDb((db) => {
      ensureLlmChatSession(db, "s1");
      replaceLlmChatSessionMessages(db, "s1", { messages: history() });
      seedCompaction(db, "s1", "k1", ["u1", "a1"]);
      expect(revertChatCompaction(db, "s1", "k1").ok).toBe(true);
      // 事件都还在库里(逐层回退要用),但回放出的栈是空的 —— 快照里不该出现分隔线。
      expect(ids(threadSnapshot({ db }, "s1"))).toEqual(["u1", "a1", "u2", "a2"]);
    });
  });

  it("★ 撤销行本身也是服务端专有行,绝不能漏给前端", () => {
    withDb((db) => {
      ensureLlmChatSession(db, "s1");
      replaceLlmChatSessionMessages(db, "s1", { messages: history() });
      seedCompaction(db, "s1", "k1", ["u1"]);
      revertChatCompaction(db, "s1", "k1");
      // `ai2nao:compaction-revert:*` 与分隔线前缀只差一个字符,放行判据写松一点
      // 就会把它当成分隔线送出去 —— 前端没有渲染器,表现是「多了一条看不见的空消息」。
      expect(ids(threadSnapshot({ db }, "s1")).filter((i) => i.startsWith("ai2nao:"))).toEqual([]);
    });
  });

  it("★ 叠加压缩:只放行当前生效的那条分隔线", () => {
    withDb((db) => {
      ensureLlmChatSession(db, "s1");
      replaceLlmChatSessionMessages(db, "s1", { messages: history() });
      seedCompaction(db, "s1", "A", ["u1"]);
      seedCompaction(db, "s1", "B", ["u1", "a1", "u2"]);
      const out = ids(threadSnapshot({ db }, "s1"));
      expect(out).toContain("ai2nao:compaction:B");
      // A 的行还在库里,但它已不是栈顶 —— 两条分隔线同时出现会让前端看到
      // 两个「此处已压缩」,而真相只有一个。
      expect(out).not.toContain("ai2nao:compaction:A");
      expect(out.filter((i) => !i.startsWith("ai2nao:"))).toEqual(["a2"]);
    });
  });

  it("★ 分隔线必须符合 AG-UI 的 ActivityMessageSchema", () => {
    withDb((db) => {
      ensureLlmChatSession(db, "s1");
      replaceLlmChatSessionMessages(db, "s1", { messages: history() });
      seedCompaction(db, "s1", "k1", ["u1", "a1"]);
      const divider = threadSnapshot({ db }, "s1")[0]!;

      // **用库自己的 schema 校验,不复述契约。** schema 写的是
      // `content: Record<string, any>`;我们曾经写成 JSON 字符串,tsc 与全部
      // 测试都不会红 —— 因为当时没有任何一条测试看过这一行的形状。
      expect(ActivityMessageSchema.safeParse(divider).success).toBe(true);

      expect((divider as { activityType?: string }).activityType).toBe("ai2nao.compaction");
      // 渲染器组件直接读字段,不必自己 JSON.parse。
      const content = (divider as unknown as { content: Record<string, unknown> }).content;
      expect(content.kind).toBe("compaction");
      expect(content.id).toBe("k1");
      expect(content.excludedMessageIds).toEqual(["u1", "a1"]);
    });
  });

  it("例外只开给分隔线:其它服务端专有行仍然不给前端", () => {
    withDb((db) => {
      ensureLlmChatSession(db, "s1");
      replaceLlmChatSessionMessages(db, "s1", { messages: history() });
      seedCompaction(db, "s1", "k1", []);
      const out = ids(threadSnapshot({ db }, "s1"));
      expect(out.filter((i) => i.startsWith("ai2nao:"))).toEqual(["ai2nao:compaction:k1"]);
    });
  });
});
