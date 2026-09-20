/**
 * 协议原文的 blob 溢出。
 *
 * 三条分支各有各的失败方式,分开测:小于阈值留在行里;超过阈值移进 blob 且
 * 取回来逐字节相同;blob **写不成**时原样留着 —— 最后这条最要紧,
 * 「原文剥了、blob 没写成」是不可逆的丢数据,而协议原文丢了就再也拼不回来。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Message } from "@ag-ui/client";
import { getBlob } from "../src/blobStore.js";
import { ensureLlmChatSession, persistGenerated } from "../src/llmChat/sessions.js";
import { openDatabase } from "../src/store/open.js";

let base: string;
let db: ReturnType<typeof openDatabase>;
let savedBlobs: string | undefined;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "ai2nao-spill-"));
  db = openDatabase(join(base, "idx.db"));
  // 照抄既有约定:不改这个变量,测试会写进开发者真实的 ~/.ai2nao/blobs。
  savedBlobs = process.env.AI2NAO_BLOBS;
  process.env.AI2NAO_BLOBS = join(base, "blobs");
});
afterEach(() => {
  db.close();
  rmSync(base, { recursive: true, force: true });
  if (savedBlobs === undefined) delete process.env.AI2NAO_BLOBS;
  else process.env.AI2NAO_BLOBS = savedBlobs;
});

function assistantWithProtocol(sessionId: string, raw: string): void {
  ensureLlmChatSession(db, sessionId);
  persistGenerated(db, sessionId, [
    {
      id: "a:run-1:answer:0",
      role: "assistant",
      content: "展示文本",
      ai2naoProtocol: { v: 1, content: raw },
    } as unknown as Message,
  ]);
}

function protocolOf(sessionId: string): { v?: number; content?: string; blobSha256?: string } {
  const row = db
    .prepare("SELECT raw_json FROM llm_chat_messages WHERE session_id = ? AND role = 'assistant'")
    .get(sessionId) as { raw_json: string };
  return (JSON.parse(row.raw_json) as { ai2naoProtocol: Record<string, never> }).ai2naoProtocol;
}

describe("协议原文的 blob 溢出", () => {
  it("小于阈值:原样留在行里,不产生 blob", () => {
    const raw = "<think>短</think>答案";
    assistantWithProtocol("s-small", raw);

    const p = protocolOf("s-small");
    expect(p.content).toBe(raw);
    expect(p.blobSha256).toBeUndefined();
  });

  it("超过阈值:行里只留 sha,blob 里取回来逐字节相同", () => {
    // 64_000 是阈值,这里明确超过它。用可辨识的内容,便于确认不是取错了文件。
    const raw = `<think>${"想".repeat(70_000)}</think>答案`;
    expect(raw.length).toBeGreaterThan(64_000);
    assistantWithProtocol("s-big", raw);

    const p = protocolOf("s-big");
    // 非空转之一:行里不再有整段原文。
    expect(p.content).toBeUndefined();
    expect(typeof p.blobSha256).toBe("string");

    // 非空转之二:取回来必须与原文**逐字节**相同 —— 回传就靠它,差一个字节都不算数。
    const back = getBlob(p.blobSha256!)!.toString("utf8");
    expect(back).toBe(raw);
  });

  it("blob 写不成:原样留着,绝不出现「原文剥了、blob 没写成」", () => {
    // 指向一个不可能建出来的路径,putBlob 必然失败(手法照抄 blobStore.test.ts)。
    process.env.AI2NAO_BLOBS = "/dev/null/nope";
    const raw = `<think>${"想".repeat(70_000)}</think>答案`;
    assistantWithProtocol("s-fail", raw);

    const p = protocolOf("s-fail");
    // 退化成「留在行里」,而不是两头落空。
    expect(p.blobSha256).toBeUndefined();
    expect(p.content).toBe(raw);
  });
});
