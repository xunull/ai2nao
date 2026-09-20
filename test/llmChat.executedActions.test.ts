import { existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Message } from "@ag-ui/core";
import {
  executedActionsBefore,
  imagePlaceholdersBefore,
} from "../src/llmChat/copilotRuntime.js";
import {
  claimChatRun,
  ensureLlmChatSession,
  finishChatToolExec,
  replaceLlmChatSessionMessages,
  startChatToolExec,
} from "../src/llmChat/sessions.js";
import { openDatabase } from "../src/store/open.js";

/**
 * 「已执行动作清单」(粗 T7 第 2 片)。
 *
 * 这份清单存在的**全部理由**是:摘要模型会把「已经做过的事」当成可省略的细节省掉,
 * 于是压缩后模型重复执行、重复提问。所以下面每条断言针对的都是**静默错**——
 * 错了输出照样像模像样,只是内容不对。
 */

function withDb(run: (db: ReturnType<typeof openDatabase>) => void): void {
  const path = join(
    tmpdir(),
    `ai2nao-actions-${Date.now()}-${Math.random().toString(36).slice(2)}.db`
  );
  const db = openDatabase(path);
  try {
    run(db);
  } finally {
    db.close();
    if (existsSync(path)) unlinkSync(path);
  }
}

/**
 * 下标 → id 集合。生成器现在收的是**排除集合**,不是下标上界 ——
 * 事件里存 id 是因为 `replaceLlmChatSessionMessages` 会重排下标(见 compaction 测试)。
 */
const upTo = (ms: Message[], n: number) => new Set(ms.slice(0, n).map((m) => String(m.id)));

const call = (id: string, name: string, args: unknown) => ({
  id,
  type: "function",
  function: { name, arguments: JSON.stringify(args) },
});

/** 下标 0..5。`upTo(history(), 4)` = {u1,a1,t1,a2} 已折叠,u2/a3 还在上下文里。 */
function history(): Message[] {
  return [
    { id: "u1", role: "user", content: "跑一下测试" } as Message,
    { id: "a1", role: "assistant", content: "", toolCalls: [call("call-1", "ai2nao_run_shell", { command: "npm test" })] } as unknown as Message,
    { id: "t1", role: "tool", toolCallId: "call-1", content: '{"ok":true}' } as unknown as Message,
    { id: "a2", role: "assistant", content: "", toolCalls: [call("call-2", "ai2nao_web_search", { query: "上海天气" })] } as unknown as Message,
    { id: "u2", role: "user", content: "之后的一轮" } as Message,
    { id: "a3", role: "assistant", content: "", toolCalls: [call("call-3", "ai2nao_run_code", { code: "print(1)" })] } as unknown as Message,
  ];
}

/** 种一行 bash 执行记录。**夹具本身要断言** —— fence 不对时它只会静默返回 ok:false。 */
function seedBash(
  db: ReturnType<typeof openDatabase>,
  sid: string,
  toolCallId: string,
  command: string,
  exitCode: number | null
): void {
  const claim = claimChatRun(db, sid, `u-${toolCallId}`);
  if (!claim.ok) throw new Error("claim failed");
  const started = startChatToolExec(db, sid, {
    toolCallId,
    runId: claim.run.runId,
    fence: claim.run.fence,
    toolName: "ai2nao_run_shell",
    command,
    cwd: null,
  });
  // 这一条不是形式:fence 不是当前的就返回 superseded 且一行都不写,
  // 随后「bash 应当带命令」的断言会红,而真凶是夹具从没种上。
  expect(started.ok).toBe(true);
  if (exitCode !== null) finishChatToolExec(db, sid, toolCallId, "completed", exitCode);
}

describe("已执行动作清单", () => {
  it("★ bash 用 tool-exec 补出命令与退出码,而不是原始入参 JSON", () => {
    withDb((db) => {
      ensureLlmChatSession(db, "s1");
      seedBash(db, "s1", "call-1", "npm test", 0);
      replaceLlmChatSessionMessages(db, "s1", { messages: history() });

      const lines = executedActionsBefore(db, "s1", upTo(history(), 4));
      const bash = lines.find((l) => l.startsWith("ai2nao_run_shell"));
      // exec 行与 assistant 的 toolCall **靠 toolCallId 对上**。对不上的话这里会
      // 退化成入参 JSON + 结果未知 —— 那正是本条要证伪的。
      expect(bash).toContain("npm test");
      expect(bash).toContain("成功");
      expect(bash).not.toContain('"command"');
    });
  });

  it("★ 没有 exec 行的工具也在清单里 —— tool-exec 只为 bash 而写", () => {
    withDb((db) => {
      ensureLlmChatSession(db, "s1");
      replaceLlmChatSessionMessages(db, "s1", { messages: history() });
      const lines = executedActionsBefore(db, "s1", upTo(history(), 4));
      // RAG / 网页搜索 / 会话记忆 / 代码执行都没有 recorder。只读 tool-exec 的话
      // 它们会整段消失,而压缩后模型就会把它们再做一遍。
      expect(lines.some((l) => l.startsWith("ai2nao_web_search"))).toBe(true);
      expect(lines.find((l) => l.startsWith("ai2nao_web_search"))).toContain("上海天气");
    });
  });

  it("★ 只算排除集合里的消息:不在集合里的动作不进清单", () => {
    withDb((db) => {
      ensureLlmChatSession(db, "s1");
      replaceLlmChatSessionMessages(db, "s1", { messages: history() });
      // a3 带着 call-3,不在前 4 条里,不该进来;差一条就是「压缩之后的动作漏进摘要」。
      expect(
        executedActionsBefore(db, "s1", upTo(history(), 4)).some((l) => l.includes("ai2nao_run_code"))
      ).toBe(false);
      expect(
        executedActionsBefore(db, "s1", upTo(history(), 6)).some((l) => l.includes("ai2nao_run_code"))
      ).toBe(true);
    });
  });

  it("结果状态三分支:ok:false → 失败;非 JSON → 成功;无结果行 → 结果未知", () => {
    withDb((db) => {
      ensureLlmChatSession(db, "s1");
      const msgs: Message[] = [
        { id: "a1", role: "assistant", content: "", toolCalls: [call("c-fail", "t_fail", {})] } as unknown as Message,
        { id: "r1", role: "tool", toolCallId: "c-fail", content: '{"ok":false}' } as unknown as Message,
        { id: "a2", role: "assistant", content: "", toolCalls: [call("c-text", "t_text", {})] } as unknown as Message,
        { id: "r2", role: "tool", toolCallId: "c-text", content: "纯文本输出" } as unknown as Message,
        { id: "a3", role: "assistant", content: "", toolCalls: [call("c-none", "t_none", {})] } as unknown as Message,
      ];
      replaceLlmChatSessionMessages(db, "s1", { messages: msgs });
      const lines = executedActionsBefore(db, "s1", upTo(msgs, 5));
      expect(lines.find((l) => l.startsWith("t_fail"))).toContain("失败");
      expect(lines.find((l) => l.startsWith("t_text"))).toContain("成功");
      // 「没有结果行」不能算成功 —— 那会让模型以为做完了。
      expect(lines.find((l) => l.startsWith("t_none"))).toContain("结果未知");
    });
  });

  it("没有压缩区间时返回空数组,不抛", () => {
    withDb((db) => {
      ensureLlmChatSession(db, "s1");
      replaceLlmChatSessionMessages(db, "s1", { messages: history() });
      expect(executedActionsBefore(db, "s1", new Set())).toEqual([]);
      expect(executedActionsBefore(db, "不存在的会话", upTo(history(), 6))).toEqual([]);
    });
  });
});

/** 图片 part。**用 url 源**:`extractInlineImages` 对 `/api/blobs/` 前缀是原样返回,
 *  这条路我完整读过;内联 base64 那一支的尾部没读完,测试不依赖它。 */
const imagePart = (sha: string) => ({
  type: "image",
  source: { type: "url", value: `/api/blobs/${sha}`, mimeType: "image/png" },
});

describe("图片轮次占位", () => {
  /** 下标 0..4;user 在 0/1/3/4 → 轮号 1/2/3/4。 */
  function withImages(): Message[] {
    return [
      { id: "u1", role: "user", content: [{ type: "text", text: "第一轮,没有图" }] } as unknown as Message,
      { id: "u2", role: "user", content: [{ type: "text", text: "两张" }, imagePart("a".repeat(64)), imagePart("b".repeat(64))] } as unknown as Message,
      { id: "a1", role: "assistant", content: "好的" } as Message,
      { id: "u3", role: "user", content: [imagePart("c".repeat(64))] } as unknown as Message,
      { id: "u4", role: "user", content: [imagePart("d".repeat(64))] } as unknown as Message,
    ];
  }

  it("★ 轮号按会话开头数起,且开区间之外的轮不出条目但**不重排轮号**", () => {
    withDb((db) => {
      ensureLlmChatSession(db, "s1");
      replaceLlmChatSessionMessages(db, "s1", { messages: withImages() });

      // 前 4 条 → u1/u2/u3 进入;u4(第 4 轮)不在集合里。
      const out = imagePlaceholdersBefore(db, "s1", upTo(withImages(), 4));
      expect(out).toEqual([
        "第 2 轮:用户贴了 2 张图,已不在上下文",
        "第 3 轮:用户贴了 1 张图,已不在上下文",
      ]);
      // 轮号是**会话内的位置**,不是清单里的序号 —— 若实现改成对入选项重新编号,
      // 上面就会变成「第 1 轮 / 第 2 轮」,模型看到的轮次与真实对话对不上。
    });
  });

  it("没贴图的轮不出条目", () => {
    withDb((db) => {
      ensureLlmChatSession(db, "s1");
      replaceLlmChatSessionMessages(db, "s1", { messages: withImages() });
      expect(
        imagePlaceholdersBefore(db, "s1", upTo(withImages(), 5)).some((l) => l.startsWith("第 1 轮"))
      ).toBe(false);
    });
  });

  it("落库往返后仍认得出图 —— imageSourceOf 对持久化的形状还成立", () => {
    withDb((db) => {
      ensureLlmChatSession(db, "s1");
      replaceLlmChatSessionMessages(db, "s1", { messages: withImages() });
      // 若落库把 image part 改写成了别的形状,这里会全部数成 0 张 —— 静默失效。
      expect(imagePlaceholdersBefore(db, "s1", upTo(withImages(), 5))).toHaveLength(3);
    });
  });

  it("空区间与不存在的会话返回空数组,不抛", () => {
    withDb((db) => {
      ensureLlmChatSession(db, "s1");
      replaceLlmChatSessionMessages(db, "s1", { messages: withImages() });
      expect(imagePlaceholdersBefore(db, "s1", new Set())).toEqual([]);
      expect(imagePlaceholdersBefore(db, "不存在", upTo(withImages(), 5))).toEqual([]);
    });
  });
});
