// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanup, render, screen } from "@testing-library/react";
import React from "react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Message } from "@ag-ui/core";
import { threadSnapshot } from "../src/llmChat/copilotRuntime.js";
import {
  activateChatCompaction,
  ensureLlmChatSession,
  replaceLlmChatSessionMessages,
  revertChatCompaction,
} from "../src/llmChat/sessions.js";
import { openDatabase } from "../src/store/open.js";
import { compactionActivityRenderer } from "../web/src/aiChat/CompactionDivider";

/**
 * 压缩分隔线渲染器 × 后端真实载荷。
 *
 * **这条测试存在的全部理由**:CopilotKit 选中渲染器后会跑
 * `renderer.content.safeParse(message.content)`,失败就 `return null`、只留一句
 * `console.warn` —— 界面上什么都没有,也不报错。tsc 更看不见:那一行是
 * `JSON.stringify` 出去的,校验发生在运行期。
 *
 * 所以断言不能用我手写的假载荷,必须用 `threadSnapshot` 真正吐给前端的那一条。
 * 前后端分属两个 tsconfig、生产代码不能互相 import,只有测试能同时看见两边
 * (与 `home.links.test.ts` 同一个理由)。
 */

// 分隔线现在从 usageContext 取会话 id 与回调,而 usageContext 引了 CopilotKit 的 v2 入口 ——
// 那个入口会 import 一个 .css,vitest 把 node_modules 交给 Node 原生加载,Node 不认 .css。
// 与其它渲染对话页的测试同一做法:mock 掉 CopilotKit,只留这里用得到的 useAgent。
vi.mock("@copilotkit/react-core/v2", () => ({ useAgent: () => ({ agent: undefined }) }));

afterEach(() => cleanup());

const DB_PREFIX = "ai2nao-divider-";

async function withDb(run: (db: ReturnType<typeof openDatabase>) => void | Promise<void>) {
  const path = join(tmpdir(), `${DB_PREFIX}${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  const db = openDatabase(path);
  try {
    await run(db);
  } finally {
    db.close();
    if (existsSync(path)) unlinkSync(path);
  }
}

const history = (): Message[] => [
  { id: "u1", role: "user", content: "第一问" } as Message,
  { id: "a1", role: "assistant", content: "第一答" } as Message,
  { id: "u2", role: "user", content: "第二问" } as Message,
];

const SUMMARY = {
  decisions: ["用 SQLite 存账目"],
  constraints: ["SCHEMA_VERSION 钉在 60"],
  state: ["压缩已接前端"],
  nextSteps: ["做用量行"],
};

function seedAndSnapshot(db: ReturnType<typeof openDatabase>) {
  ensureLlmChatSession(db, "s1");
  replaceLlmChatSessionMessages(db, "s1", { messages: history() });
  activateChatCompaction(db, "s1", {
    id: "k1",
    trigger: "auto",
    excludedMessageIds: ["u1", "a1"],
    summary: SUMMARY,
    summaryCallIds: ["c:r1:compact:0:0"],
  });
  return threadSnapshot({ db }, "s1");
}

const contentOf = (m: unknown) => (m as { content: unknown }).content;

describe("压缩分隔线渲染器", () => {
  it("★ schema 必须吃得下后端真实产出的 content —— 吃不下就是界面静默空白", async () => {
    await withDb((db) => {
      const parsed = compactionActivityRenderer.content.safeParse(contentOf(seedAndSnapshot(db)[0]));
      // 失败时把 zod 的原因带出来,否则只看到 false,查不动。
      expect(parsed.success, JSON.stringify(parsed.error?.issues ?? null)).toBe(true);
    });
  });

  it("★ activityType 与后端字面量一字不差,否则 findRenderer 选不中", async () => {
    await withDb((db) => {
      expect((seedAndSnapshot(db)[0] as { activityType?: string }).activityType).toBe(
        compactionActivityRenderer.activityType
      );
    });
  });

  it("默认收起:只有标记行,摘要正文不在 DOM 里;自动触发要看得出来", async () => {
    await withDb((db) => {
      const parsed = compactionActivityRenderer.content.safeParse(contentOf(seedAndSnapshot(db)[0]));
      if (!parsed.success) throw new Error("载荷解析失败,前面那条会先红");
      const R = compactionActivityRenderer.render;
      render(<R content={parsed.data} />);
      expect(screen.queryByText("用 SQLite 存账目")).not.toBeInTheDocument();
      const btn = screen.getByRole("button", { name: /此处已压缩/ });
      expect(btn).toHaveTextContent("此处已压缩");
      // 「这是谁压的」是用户会问的问题 —— 自动/手动必须分得出来。
      expect(btn).toHaveTextContent("自动");
      expect(btn).toHaveTextContent("2 条消息");
    });
  });

  it("展开后四段摘要都在", async () => {
    await withDb(async (db) => {
      const parsed = compactionActivityRenderer.content.safeParse(contentOf(seedAndSnapshot(db)[0]));
      if (!parsed.success) throw new Error("载荷解析失败");
      const R = compactionActivityRenderer.render;
      render(<R content={parsed.data} />);
      await userEvent.click(screen.getByRole("button", { name: /此处已压缩/ }));
      for (const t of ["用 SQLite 存账目", "SCHEMA_VERSION 钉在 60", "压缩已接前端", "做用量行"]) {
        expect(screen.getByText(t)).toBeInTheDocument();
      }
    });
  });

  it("★ 撤销之后快照里没有分隔线 —— 渲染器根本不该被调到", async () => {
    await withDb((db) => {
      ensureLlmChatSession(db, "s1");
      replaceLlmChatSessionMessages(db, "s1", { messages: history() });
      activateChatCompaction(db, "s1", {
        id: "k1", trigger: "manual", excludedMessageIds: ["u1"],
        summary: SUMMARY, summaryCallIds: [],
      });
      expect(revertChatCompaction(db, "s1", "k1").ok).toBe(true);
      const ids = threadSnapshot({ db }, "s1").map((m) => String(m.id));
      expect(ids.filter((i) => i.startsWith("ai2nao:"))).toEqual([]);
    });
  });
});
