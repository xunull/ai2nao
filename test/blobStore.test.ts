import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  blobStoreDir,
  getBlob,
  hasBlob,
  isValidSha256,
  parseDataUri,
  putBlob,
  sniffImageMime,
} from "../src/blobStore.js";
import { slimPartData } from "../src/opencodeHistory/myMessages.js";
import { recleanOpencodeFromPayload } from "../src/opencodeHistory/myMessages.js";

/**
 * 内联附件抽进 blob 仓（O4）。
 *
 * 真库实测：opencode 的 user 消息里有 129 段 `data:` URI 内联附件，共 53.2 MB
 * （96 张 PNG、15 webp、15 jpeg），平均每张 422 KB。它们原样进了
 * `raw_payload_json`，让 1934 行消息占掉 65.8 MB，而正文只有 12 MB。
 *
 * 这组用例盯住三件事：桩必须是**字符串**（载荷是字符串数组，塞对象进去
 * `String(x)` 会变成 `"[object Object]"`，往返就断了）；写不成 blob 时
 * **原样保留**（绝不出现「正文剥了、blob 没写成」）；以及 round-trip
 * 在**含 file part** 的载荷上仍然成立 —— 此前的 round-trip 测试只有
 * textPart() fixture，而 cleaner 本来就跳过非 text，那个测试结构上不可能失败。
 */

const PRIOR = process.env.AI2NAO_BLOBS;
beforeEach(() => {
  process.env.AI2NAO_BLOBS = mkdtempSync(join(tmpdir(), "ai2nao-blobs-"));
});
afterEach(() => {
  if (PRIOR === undefined) delete process.env.AI2NAO_BLOBS;
  else process.env.AI2NAO_BLOBS = PRIOR;
});

// 1x1 PNG
const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const PNG_URI = `data:image/png;base64,${PNG_B64}`;

describe("blobStore", () => {
  it("环境变量能把 blob 仓挪走 —— 否则测试会写进开发者真实的 ~/.ai2nao/blobs", () => {
    expect(blobStoreDir()).toBe(process.env.AI2NAO_BLOBS);
    expect(blobStoreDir()).not.toContain(".ai2nao/blobs");
  });

  it("解 data: URI，拿到字节与 mime", () => {
    const d = parseDataUri(PNG_URI)!;
    expect(d.mime).toBe("image/png");
    expect(d.bytes.length).toBeGreaterThan(50);
    expect(d.bytes.subarray(1, 4).toString("ascii")).toBe("PNG");
  });

  it("非 data: URI 返回 null（file:// 引用本身就几个字节，不该动）", () => {
    expect(parseDataUri("file:///work/app/a.py")).toBeNull();
    expect(parseDataUri("https://example.com/x.png")).toBeNull();
  });

  it("内容寻址：同内容写两次只存一份，路径相同", () => {
    const a = putBlob(Buffer.from("同样的内容"), "text/plain")!;
    const b = putBlob(Buffer.from("同样的内容"), "text/plain")!;
    expect(a.sha256).toBe(b.sha256);
    expect(hasBlob(a.sha256)).toBe(true);
    expect(getBlob(a.sha256)!.toString()).toBe("同样的内容");
  });

  it("落盘权限 0600 —— 附件里可能有截图,不该组内可读", () => {
    const ref = putBlob(Buffer.from("secret"), null)!;
    const p = join(blobStoreDir(), ref.sha256.slice(0, 2), ref.sha256);
    expect(statSync(p).mode & 0o777).toBe(0o600);
    expect(readFileSync(p).toString()).toBe("secret");
  });
});

describe("slimPartData", () => {
  it("data: 附件被抽走，桩里留 sha256 且能取回原文", () => {
    const original = JSON.stringify({ type: "file", mime: "image/png", filename: "shot.png", url: PNG_URI });
    const slim = slimPartData(original);
    expect(slim.length).toBeLessThan(original.length);

    const parsed = JSON.parse(slim) as { url?: string; blob?: { sha256: string; bytes: number; mime: string } };
    expect(parsed.url).toBeUndefined();
    expect(parsed.blob!.mime).toBe("image/png");
    expect(getBlob(parsed.blob!.sha256)!.length).toBe(parsed.blob!.bytes);
  });

  it("返回的是**字符串**，不是对象 —— 载荷是字符串数组", () => {
    const slim = slimPartData(JSON.stringify({ type: "file", url: PNG_URI }));
    expect(typeof slim).toBe("string");
    // 塞对象进载荷数组的话,String(x) 会变成这个 —— 往返当场断掉。
    expect(String(slim)).not.toBe("[object Object]");
    expect(() => JSON.parse(slim)).not.toThrow();
  });

  it("file:// 引用与 text part 原样不动", () => {
    const ref = JSON.stringify({ type: "file", mime: "text/plain", url: "file:///work/app/a.py" });
    expect(slimPartData(ref)).toBe(ref);
    const text = JSON.stringify({ type: "text", text: "帮我加个功能" });
    expect(slimPartData(text)).toBe(text);
  });

  it("坏 JSON 原样留底，不崩", () => {
    expect(slimPartData("{不是 json")).toBe("{不是 json");
  });

  it("blob 写不成时原样保留 —— 绝不出现「正文剥了、blob 没写成」", () => {
    // 指向一个不可能建出来的路径,putBlob 会失败
    process.env.AI2NAO_BLOBS = "/dev/null/nope";
    const original = JSON.stringify({ type: "file", url: PNG_URI });
    expect(slimPartData(original)).toBe(original);
  });
});

describe("round-trip：含 file part 的载荷", () => {
  it("抽走附件之后，重清洗仍拿到同样的正文", () => {
    // 此前的 round-trip 测试只有 textPart() fixture,而 cleaner 跳过非 text ——
    // 那个测试结构上不可能观察到 file part 的变化。这条补上。
    const parts = [
      JSON.stringify({ type: "text", text: "看看这张图" }),
      JSON.stringify({ type: "file", mime: "image/png", url: PNG_URI }),
    ];
    const before = recleanOpencodeFromPayload(JSON.stringify(parts));
    const after = recleanOpencodeFromPayload(JSON.stringify(parts.map(slimPartData)));
    expect(after).toEqual(before);
    expect(after.cleanedText).toBe("看看这张图");
    expect(after.isHuman).toBe(true);
  });
});

/**
 * sha 形状校验(T1b)。在 `GET /api/blobs/:sha256` 上线之前这条路不可达 ——
 * getBlob 零消费者。有了 HTTP 出口,外部输入就能走到 blobPath 的
 * `sha256.slice(0, 2)`,而 "../" 的前两位正是 ".."。
 */
describe("sha 形状校验", () => {
  it("★ 穿越路径拿不到任何字节 —— 分片目录取前两位,「..」是合法前两位", () => {
    // **先证明这条断言不是空网**:构造一个真实存在的穿越目标。没有这一步的话,
    // 「返回 null」可能只是因为目标文件恰好不存在,而不是因为校验拦住了。
    const outside = join(blobStoreDir(), "..", "..", "outside.txt");
    writeFileSync(outside, "仓外的内容");
    const escape = join("..", "..", "outside.txt");
    expect(existsSync(join(blobStoreDir(), escape))).toBe(true); // 路径真能拼到它
    expect(getBlob(escape)).toBeNull();                          // 但取不到

    for (const evil of [
      "../../../../etc/passwd",
      "..",
      "../" + "a".repeat(61),
      "/etc/passwd",
    ]) {
      expect(getBlob(evil), evil).toBeNull();
      expect(hasBlob(evil), evil).toBe(false);
    }
  });

  it("形状不对的一律当没有:长度、大小写、非十六进制", () => {
    const ok = "a".repeat(64);
    expect(isValidSha256(ok)).toBe(true);
    for (const bad of [
      "a".repeat(63),
      "a".repeat(65),
      "A".repeat(64), // 大写 —— digest("hex") 只产小写
      "g".repeat(64), // 非十六进制
      "",
    ]) {
      expect(isValidSha256(bad), bad).toBe(false);
      expect(getBlob(bad), bad).toBeNull();
    }
  });

  it("★ 合法 sha 仍然取得回来 —— 校验不能把正常路径一起挡了", () => {
    const ref = putBlob(Buffer.from("正常内容"), "text/plain");
    expect(ref).not.toBeNull();
    expect(isValidSha256(ref!.sha256)).toBe(true);
    expect(getBlob(ref!.sha256)?.toString()).toBe("正常内容");
  });
});

/**
 * 魔术字节嗅探(T1)。落盘的是裸字节、无扩展名,`putBlob` 从不把 mime 存下来 ——
 * 所以读路由没有任何依据定 Content-Type,只能从字节本身认。
 */
describe("sniffImageMime", () => {
  it("认得四种白名单格式", () => {
    expect(sniffImageMime(Buffer.from([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10, 0, 0, 0, 13]))).toBe("image/png");
    expect(sniffImageMime(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 1]))).toBe("image/jpeg");
    expect(sniffImageMime(Buffer.from([0x47, 0x49, 0x46, 0x38, 57, 97, 1, 0, 1, 0, 0, 0]))).toBe("image/gif");
    expect(
      sniffImageMime(Buffer.from([0x52, 0x49, 0x46, 0x46, 4, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]))
    ).toBe("image/webp");
  });

  it("★ SVG 不在白名单 —— 同源端点按 image/svg+xml 吐出去就是脚本执行", () => {
    expect(sniffImageMime(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>'))).toBeNull();
  });

  it("★ 声明什么都不影响判定 —— 类型只来自字节本身", () => {
    // 一段 HTML,不管调用方说它是什么,都不该被当成图片
    expect(sniffImageMime(Buffer.from("<!doctype html><html><body>x</body></html>"))).toBeNull();
    // RIFF 但不是 WEBP(比如 wav)
    expect(sniffImageMime(Buffer.from([0x52, 0x49, 0x46, 0x46, 4, 0, 0, 0, 0x57, 0x41, 0x56, 0x45]))).toBeNull();
  });

  it("太短的输入不越界读", () => {
    expect(sniffImageMime(Buffer.from([0x89, 0x50]))).toBeNull();
    expect(sniffImageMime(Buffer.alloc(0))).toBeNull();
  });
});
