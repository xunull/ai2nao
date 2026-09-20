import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type Database from "better-sqlite3";
import type { Message } from "@ag-ui/client";
import { openDatabase } from "../src/store/open.js";
import {
  createLlmChatSession,
  getLlmChatSession,
  replaceLlmChatSessionMessages,
  LlmChatSessionError,
} from "../src/llmChat/sessions.js";
import { agUiMessagesToModelMessages, assertCanSendImages } from "../src/llmChat/copilotRuntime.js";
import { PROVIDER_ADAPTER_CAPABILITIES } from "../src/llmChat/document.js";
import { putBlob } from "../src/blobStore.js";

/**
 * 贴图链路的两端:
 *
 * - **落库前**(`sessions.normalizeAgUiMessage`)把内联 base64 抽成 blob 引用。
 *   服务端自己守这条,不信任前端的 onUpload —— 它缺席时 CopilotKit 直接
 *   base64 内联(默认上限 20 MB),而 1.5 MB 那道闸在模型答完之后才判。
 *
 * - **发给模型前**(`agUiMessagesToModelMessages`)把引用解回字节。
 *   注意模型调用**先于**持久化(copilotRuntime :300 vs :356),
 *   所以这一路要同时认「内联 data」与「url 引用」两种形状。
 */

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10, 0, 0, 0, 13, 1, 2, 3, 4]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 1, 9, 9, 9]);

let base: string;
let db: Database.Database;
let savedBlobs: string | undefined;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "ai2nao-img-"));
  db = openDatabase(join(base, "idx.db"));
  savedBlobs = process.env.AI2NAO_BLOBS;
  process.env.AI2NAO_BLOBS = join(base, "blobs");
});
afterEach(() => {
  db.close();
  rmSync(base, { recursive: true, force: true });
  if (savedBlobs === undefined) delete process.env.AI2NAO_BLOBS;
  else process.env.AI2NAO_BLOBS = savedBlobs;
});

const dataPart = (bytes: Buffer, mime = "image/png") => ({
  type: "image",
  source: { type: "data", value: bytes.toString("base64"), mimeType: mime },
});
const urlPart = (sha: string, mime = "image/png") => ({
  type: "image",
  source: { type: "url", value: `/api/blobs/${sha}`, mimeType: mime },
});
const userMsg = (id: string, content: unknown): Message =>
  ({ id, role: "user", content }) as unknown as Message;

// ---------------------------------------------------------------- 落库前抽取

describe("落库前抽取(T5)", () => {
  const persist = (messages: Message[]) => {
    const s = createLlmChatSession(db, "t");
    replaceLlmChatSessionMessages(db, s.id, { messages });
    return getLlmChatSession(db, s.id)!;
  };

  it("★ 内联 base64 落库时变成 url 引用,像素不进 raw_json", () => {
    const d = persist([userMsg("m1", [{ type: "text", text: "看这个" }, dataPart(PNG)])]);
    const raw = d.messages[0]!.raw_json;
    expect(raw).not.toContain(PNG.toString("base64")); // 像素没了
    expect(raw).toContain("/api/blobs/");              // 换成了引用
    const src = JSON.parse(raw).content[1].source;
    expect(src.type).toBe("url");
    expect(JSON.parse(raw).content[1].metadata.sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("★ 不走 parseDataUri —— CopilotKit 给的是裸 base64,没有 data: 前缀", () => {
    // parseDataUri 的第一行是 startsWith("data:"),用它抽这个形状会静默什么都不做。
    const b64 = PNG.toString("base64");
    expect(b64.startsWith("data:")).toBe(false);
    const d = persist([userMsg("m1", [dataPart(PNG)])]);
    expect(d.messages[0]!.raw_json).toContain("/api/blobs/");
  });

  it("★ 抽取让 1.5 MB 那道闸看到的是短引用 —— 顺序:normalize 先跑,上限后算", () => {
    // 单张 600 KB,三条消息各一张。不抽取的话 base64 膨胀到约 2.4 MB,必然 413。
    const big = Buffer.concat([PNG, Buffer.alloc(600_000, 7)]);
    const msgs = [1, 2, 3].map((i) => userMsg(`m${i}`, [dataPart(big)]));
    expect(() => persist(msgs)).not.toThrow();
  });

  it("已经是 url 引用的不再动", () => {
    const ref = putBlob(PNG, "image/png")!;
    const d = persist([userMsg("m1", [urlPart(ref.sha256)])]);
    expect(JSON.parse(d.messages[0]!.raw_json).content[0].source.value).toBe(
      `/api/blobs/${ref.sha256}`
    );
  });

  it("★ 纯图消息计入 message_count,并能当会话标题 —— 不再是空字符串", () => {
    const s = createLlmChatSession(db, "旧标题");
    replaceLlmChatSessionMessages(db, s.id, { messages: [userMsg("m1", [dataPart(PNG)])] });
    const d = getLlmChatSession(db, s.id)!;
    expect(d.message_count).toBe(1);       // isHumanVisibleMessage 认它
    expect(d.messages[0]!.plain_text).toBe("[图片]");
    expect(d.title).toBe("[图片]");         // autoTitle 认它
  });

  it("文字+图的 plain_text 两者都有", () => {
    const d = persist([userMsg("m1", [{ type: "text", text: "看这个" }, dataPart(PNG)])]);
    expect(d.messages[0]!.plain_text).toBe("看这个[图片]");
  });
});

describe("落库前校验(D12)", () => {
  const persist = (messages: Message[]) => {
    const s = createLlmChatSession(db, "t");
    replaceLlmChatSessionMessages(db, s.id, { messages });
  };

  it("★ 外部 URL 被拒 —— 本机应用能看见内网,替调用方取就是 SSRF", () => {
    for (const evil of [
      "https://attacker.invalid/x.png",
      "http://127.0.0.1:9200/_cat/indices",
      "file:///etc/passwd",
      "//attacker.invalid/x.png",
    ]) {
      expect(() =>
        persist([userMsg("m1", [{ type: "image", source: { type: "url", value: evil } }])])
      , evil).toThrow(/只能引用本机附件仓/);
    }
  });

  it("★ 魔术字节与声明的 mime 不符 → 拒,不白花一次钱", () => {
    expect(() => persist([userMsg("m1", [dataPart(JPEG, "image/png")])])).toThrow(/与声明的/);
  });

  it("不是图片的字节 → 拒", () => {
    expect(() =>
      persist([userMsg("m1", [dataPart(Buffer.from("<!doctype html>"), "image/png")])])
    ).toThrow(/只支持 PNG/);
  });

  it("超过单条张数上限 → 拒", () => {
    const parts = Array.from({ length: 7 }, (_, i) =>
      dataPart(Buffer.concat([PNG, Buffer.from([i])]))
    );
    expect(() => persist([userMsg("m1", parts)])).toThrow(/最多 6 张图/);
  });

  it("单张超过 5 MB → 413", () => {
    const huge = Buffer.concat([PNG, Buffer.alloc(6 * 1024 * 1024)]);
    try {
      persist([userMsg("m1", [dataPart(huge)])]);
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(LlmChatSessionError);
      expect((e as LlmChatSessionError).status).toBe(413);
    }
  });

  it("音频/视频/文档附件明确拒绝,不静默留在载荷里", () => {
    for (const kind of ["audio", "video", "document"]) {
      expect(() =>
        persist([userMsg("m1", [{ type: kind, source: { type: "data", value: "AAA" } }])])
      , kind).toThrow(/只支持图片/);
    }
  });
});

// ------------------------------------------------------------ 发给模型前解引用

describe("发给模型(T4)", () => {
  it("★ 纯图消息不再被整条丢弃 —— 这是贴图最常见的用法", () => {
    const ref = putBlob(PNG, "image/png")!;
    const out = agUiMessagesToModelMessages([userMsg("m1", [urlPart(ref.sha256)])]);
    expect(out).toHaveLength(1);
    const content = out[0]!.content as Array<{ type: string; image?: Buffer }>;
    expect(content[0]!.type).toBe("image");
    expect(Buffer.from(content[0]!.image!).equals(PNG)).toBe(true);
  });

  it("文字+图 → 文字在前的混合 content", () => {
    const ref = putBlob(PNG, "image/png")!;
    const out = agUiMessagesToModelMessages([
      userMsg("m1", [{ type: "text", text: "看这个" }, urlPart(ref.sha256)]),
    ]);
    const c = out[0]!.content as Array<{ type: string; text?: string }>;
    expect(c[0]).toEqual({ type: "text", text: "看这个" });
    expect(c[1]!.type).toBe("image");
  });

  it("★ 当前消息的图一张都不少 —— K 只约束历史", () => {
    const refs = [1, 2, 3].map((i) => putBlob(Buffer.concat([PNG, Buffer.from([i])]), "image/png")!);
    const out = agUiMessagesToModelMessages([
      userMsg("m1", refs.map((r) => urlPart(r.sha256))),
    ]);
    const imgs = (out[0]!.content as Array<{ type: string }>).filter((p) => p.type === "image");
    expect(imgs).toHaveLength(3); // 横向对比场景,丢一张就答错
  });

  it("★ 历史只带最近 2 张,更早的换文字占位(不是凭空消失)", () => {
    const refs = [1, 2, 3, 4].map((i) =>
      putBlob(Buffer.concat([PNG, Buffer.from([i])]), "image/png")!
    );
    const out = agUiMessagesToModelMessages([
      userMsg("h1", [urlPart(refs[0]!.sha256)]),
      userMsg("h2", [urlPart(refs[1]!.sha256)]),
      userMsg("h3", [urlPart(refs[2]!.sha256)]),
      { id: "a1", role: "assistant", content: "好的" } as unknown as Message,
      userMsg("now", [{ type: "text", text: "继续" }, urlPart(refs[3]!.sha256)]),
    ]);
    const flat = out.flatMap((m) => (Array.isArray(m.content) ? m.content : [m.content]));
    const imgCount = flat.filter((p) => typeof p === "object" && p?.type === "image").length;
    // 当前那条 1 张 + 历史窗口 2 张 = 3;最早的 h1 变成占位。
    expect(imgCount).toBe(3);
    const texts = JSON.stringify(flat);
    expect(texts).toContain("贴过一张");
    expect(texts).toContain("未重复发送");
  });

  it("★ blob 被手工删掉时明说,不静默少一张图", () => {
    // 引用一个从没写进仓里的 sha —— 等价于文件被手工删了。
    const out = agUiMessagesToModelMessages([userMsg("m1", [urlPart("a".repeat(64))])]);
    expect(JSON.stringify(out)).toContain("已不在本机附件仓");
  });

  it("★ 内联 data 形状也认 —— 模型调用先于持久化,本轮新消息还没变成引用", () => {
    const out = agUiMessagesToModelMessages([userMsg("m1", [dataPart(PNG)])]);
    const c = out[0]!.content as Array<{ type: string; image?: Buffer }>;
    expect(c[0]!.type).toBe("image");
    expect(Buffer.from(c[0]!.image!).equals(PNG)).toBe(true);
  });

  it("纯文本消息仍发字符串,不换成单元素数组(不回归)", () => {
    const out = agUiMessagesToModelMessages([userMsg("m1", [{ type: "text", text: "只有文字" }])]);
    expect(out[0]!.content).toBe("只有文字");
  });

  it("空消息仍然跳过", () => {
    expect(agUiMessagesToModelMessages([userMsg("m1", [])])).toHaveLength(0);
  });
});

/**
 * 后端视觉闸(T4b)。前端置灰是第一道,这是第二道 —— 前端的值不可信,
 * 而 picker 与库里的配置有一瞬不同步时,图会被真的发出去、真的计费。
 */
describe("后端视觉闸(T4b)", () => {
  // 升到 @ai-sdk/deepseek 2.0.64 后,全部适配器都发得出图(每一格的真相由
  // llmChat.adapterSendsImages.test.ts 按真实请求体核对),闸暂时没有真实的拦截对象。
  // 这里用改表模拟「一家发不出图的适配器」,守的是闸本身的行为。
  const adapterTable = PROVIDER_ADAPTER_CAPABILITIES as Record<string, { sendsImages: boolean }>;
  // 存标量而不是整格对象:存引用的话,改的和还原的是同一个对象,还原会失效。
  let savedDeepseek: boolean;
  beforeEach(() => {
    savedDeepseek = adapterTable.deepseek!.sendsImages;
    adapterTable.deepseek!.sendsImages = false;
  });
  afterEach(() => {
    adapterTable.deepseek!.sendsImages = savedDeepseek;
  });

  const withImage = () => {
    const ref = putBlob(PNG, "image/png")!;
    return agUiMessagesToModelMessages([userMsg("m1", [urlPart(ref.sha256)])]);
  };

  it("★ 适配器发不出图 + 带图 → 抛,一个字节不发", () => {
    expect(() => assertCanSendImages(withImage(), "deepseek")).toThrow(/发不出图片/);
  });

  it("★ 这一条没有后门 —— 错误信息要说清「发出去图也会被丢、费用照扣」", () => {
    // 「仍要发送」后门是给「目录可能过期」留的;适配器发不出去是确定事实。
    try {
      assertCanSendImages(withImage(), "deepseek");
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as Error).message).toContain("费用照扣");
    }
  });

  it("发不出图的适配器,纯文本照常通过 —— 闸只拦带图的轮次", () => {
    const out = agUiMessagesToModelMessages([userMsg("m1", [{ type: "text", text: "你好" }])]);
    expect(() => assertCanSendImages(out, "deepseek")).not.toThrow();
  });

  it("能发图的 provider 一律放行", () => {
    for (const p of ["minimax", "volcengine", "moonshotai", "alibaba", "openai", "openai-compatible"] as const) {
      expect(() => assertCanSendImages(withImage(), p), p).not.toThrow();
    }
  });

  it("★ 适配器能力表覆盖全部 provider —— 加一家厂商忘了填,这里会红", () => {
    // 漏填整格的话 PROVIDER_ADAPTER_CAPABILITIES[新provider] 是 undefined,
    // `.sendsImages` 取不到 → 被当成「发不出图」而静默拦住所有贴图。
    // **两个字段都要查**:只查 sendsImages 的话,漏填 reasoningReplay 会静默通过,
    // 而思考回传恰恰按它分档 —— 漏填等于那家厂商的思考永远不回传,且没人发现。
    // (每一格填得对不对,由 llmChat.adapterSendsImages.test.ts 按真实请求体核对。)
    const full = PROVIDER_ADAPTER_CAPABILITIES as Record<
      string,
      { sendsImages: boolean; reasoningReplay: string }
    >;
    for (const p of ["alibaba", "deepseek", "minimax", "moonshotai", "openai", "openai-compatible", "volcengine"]) {
      expect(typeof full[p]?.sendsImages, p).toBe("boolean");
      expect(["reasoning-part", "protocol-content", "none"], p).toContain(full[p]?.reasoningReplay);
    }
  });
});
