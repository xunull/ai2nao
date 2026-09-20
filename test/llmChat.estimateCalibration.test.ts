import { describe, expect, it } from "vitest";
import { imageDimensions } from "../src/blobStore.js";
import { estimateImageTokens, estimateTextTokens } from "../src/llmChat/copilotRuntime.js";

/**
 * 估算系数的校准回归(2026-09-19 真实请求实测,DeepSeek V4 flash 与 MiniMax-M3 各一遍)。
 *
 * 期望值是**两家实测 input token 取大**(扣掉「一个字」的基线开销)。验收口径:全量估算
 * **从不少估**(少估 = 该拦的没拦,请求打到厂商才被拒),多估不超过 30%。
 * 样本与校准脚本逐字相同;改样本就得重新实测,不能只改这里的数字。
 * (代码样本取自 node_modules 里的 hono 源码,依赖一升级就对不上,所以不在这里固化。)
 */

const zhPara =
  "本地优先的工具把数据留在用户自己的机器上。索引、压缩与记账都在后端完成,前端只负责展示。当会话变长时,系统会估算下一轮要发给模型的上下文大小,接近窗口上限就提示用户压缩;压缩不会删除原文,只是不再发送,随时可以撤销。每一次调用模型都会记下一笔账,包括重试与补答,费用按当时的价格快照计算,以后价格变了也不会回头重算。";
const enPara =
  "Local-first tools keep data on the user's own machine. Indexing, compaction and accounting all happen on the backend, while the frontend only renders. When a conversation grows long, the system estimates how much context the next turn will send and suggests compacting as it approaches the window limit; compaction never deletes the original messages, it only stops sending them, and it can be undone at any time. ";
const mixed =
  "我把 `persistGenerated` 改成了增量 upsert,原来的 `replaceLlmChatSessionMessages` 会删了重建。另外 SQLite 开了 WAL 模式(journal_mode=WAL),busy_timeout 设成 5000ms。下一步要跑 `npx vitest run --no-file-parallelism` 确认 2765 条测试全绿,然后看 EXPLAIN QUERY PLAN 有没有用上 (session_id, role) 索引。";
const json = JSON.stringify(
  {
    ok: true,
    runtime: "pyodide",
    stdout: "a.txt\nb.txt\n",
    files: Array.from({ length: 30 }, (_, i) => ({
      path: `src/module${i}/index.ts`,
      size: 1000 + i * 37,
      modified: `2026-09-19T10:${String(i).padStart(2, "0")}:00Z`,
    })),
  },
  null,
  2
).slice(0, 3000);
const to3000 = (s: string) => s.repeat(Math.ceil(3000 / s.length)).slice(0, 3000);

const MEASURED: Array<[string, string, number]> = [
  ["中文", to3000(zhPara), 1803],
  ["英文", to3000(enPara), 595],
  ["JSON", json, 1148],
  ["中英混排", to3000(mixed), 1244],
];

describe("文本估算 × 实测", () => {
  it.each(MEASURED)("★ %s:不少估,多估不超过 30%%", (_kind, text, real) => {
    const est = estimateTextTokens(text);
    expect(est).toBeGreaterThanOrEqual(real);
    expect(est / real).toBeLessThanOrEqual(1.3);
  });

  it("空白不计 —— BPE 把空格并进相邻的词", () => {
    expect(estimateTextTokens("   \n\t")).toBe(0);
  });
});

function png(width: number, height: number): Buffer {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write("IHDR", 12, "ascii");
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return b;
}

describe("图片尺寸与估算", () => {
  it("PNG / GIF / JPEG / WebP 四种都读得出宽高", () => {
    expect(imageDimensions(png(1600, 1000))).toEqual({ width: 1600, height: 1000 });

    const gif = Buffer.alloc(16);
    gif.write("GIF89a", 0, "ascii");
    gif.writeUInt16LE(320, 6);
    gif.writeUInt16LE(240, 8);
    expect(imageDimensions(gif)).toEqual({ width: 320, height: 240 });

    // SOI → 一个 APP0 段(要跳过)→ SOF0(高在宽前面)。
    const jpeg = Buffer.from([
      0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00,
      0xff, 0xc0, 0x00, 0x11, 0x08, 0x02, 0xd0, 0x05, 0x00, 0x03, 0x01, 0x22, 0x00,
    ]);
    expect(imageDimensions(jpeg)).toEqual({ width: 1280, height: 720 });

    const webpX = Buffer.alloc(30);
    webpX.write("RIFF", 0, "ascii");
    webpX.write("WEBP", 8, "ascii");
    webpX.write("VP8X", 12, "ascii");
    webpX.writeUIntLE(2879, 24, 3);
    webpX.writeUIntLE(1799, 27, 3);
    expect(imageDimensions(webpX)).toEqual({ width: 2880, height: 1800 });
  });

  it("★ 按像素估:两张实测图都不少估;读不出尺寸时退回固定值", () => {
    // 512×512 实测 DeepSeek 184 / MiniMax 326;1600×1000 实测 962 / 2054。
    expect(estimateImageTokens(png(512, 512))).toBeGreaterThanOrEqual(326);
    expect(estimateImageTokens(png(1600, 1000))).toBeGreaterThanOrEqual(2054);
    // 大图不能被一个固定值封顶 —— Retina 截图在 MiniMax 上约 6600 token。
    expect(estimateImageTokens(png(2880, 1800))).toBeGreaterThan(6000);
    expect(estimateImageTokens(Buffer.from("not an image at all"))).toBe(1500);
  });
});
