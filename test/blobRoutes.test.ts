import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Hono } from "hono";
import type Database from "better-sqlite3";
import { createApp } from "../src/serve/app.js";
import { openDatabase } from "../src/store/open.js";
import { blobStoreDir, putBlob } from "../src/blobStore.js";

/**
 * `GET /api/blobs/:sha256` 是 blob 仓的唯一读出口,而 serve 层所有路由无鉴权
 * (`app.ts` 只有 CORS)。所以「不返回不该返回的字节」不是附加项,是这组测试的主题。
 */

let base: string;
let db: Database.Database;
let app: Hono;
let savedBlobs: string | undefined;

/** 四种白名单格式的最小合法头(只需前 12 字节能被认出)。 */
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10, 0, 0, 0, 13, 1, 2, 3]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 1, 9, 9]);
const WEBP = Buffer.from([0x52, 0x49, 0x46, 0x46, 4, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 7]);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "ai2nao-blobroutes-"));
  db = openDatabase(join(base, "idx.db"));
  savedBlobs = process.env.AI2NAO_BLOBS;
  process.env.AI2NAO_BLOBS = join(base, "blobs");
  app = createApp({ db });
});
afterEach(() => {
  db.close();
  rmSync(base, { recursive: true, force: true });
  if (savedBlobs === undefined) delete process.env.AI2NAO_BLOBS;
  else process.env.AI2NAO_BLOBS = savedBlobs;
});

const get = (sha: string) => app.request(`http://x/api/blobs/${sha}`);

describe("安全约束", () => {
  it("★ 穿越路径拿不到任何字节 —— 且这条断言不是空网", async () => {
    // 先在仓外放一个**真实存在**的文件,并证明路径确实能拼到它。
    // 没有这一步,「404」可能只是因为目标不存在,而不是因为校验拦住了。
    const outside = join(blobStoreDir(), "..", "..", "secret.txt");
    writeFileSync(outside, "不该被读到的内容");
    const escape = ["..", "..", "secret.txt"].join("/");
    expect(existsSync(join(blobStoreDir(), escape))).toBe(true);

    const res = await get(encodeURIComponent(escape));
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain("不该被读到");
  });

  it("形状不合法的 sha 一律 404,与「文件不存在」同一个响应(不做探测器)", async () => {
    for (const bad of ["a".repeat(63), "A".repeat(64), "g".repeat(64), "x"]) {
      expect((await get(bad)).status, bad).toBe(404);
    }
    // 合法形状但没这个文件 —— 同样 404,外部区分不出两者。
    expect((await get("b".repeat(64))).status).toBe(404);
  });

  it("★ SVG 不以 image/svg+xml 返回 —— 同源脚本执行", async () => {
    const ref = putBlob(SVG, "image/svg+xml"); // 声明是 svg,但声明不作数
    const res = await get(ref!.sha256);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
    expect(res.headers.get("content-disposition")).toBe("attachment");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("★ Content-Type 只来自字节,不来自调用方声明的 mime", async () => {
    // 存一段 HTML 却声称是 png —— 仍然只能当附件下载。
    const ref = putBlob(Buffer.from("<!doctype html><script>alert(1)</script>"), "image/png");
    const res = await get(ref!.sha256);
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
    expect(res.headers.get("content-disposition")).toBe("attachment");
  });
});

describe("正常读取", () => {
  it("四种白名单格式回各自的 Content-Type,且不带 attachment", async () => {
    const cases: [Buffer, string][] = [
      [PNG, "image/png"],
      [JPEG, "image/jpeg"],
      [WEBP, "image/webp"],
    ];
    for (const [bytes, mime] of cases) {
      const ref = putBlob(bytes, null);
      const res = await get(ref!.sha256);
      expect(res.status, mime).toBe(200);
      expect(res.headers.get("content-type"), mime).toBe(mime);
      expect(res.headers.get("content-disposition"), mime).toBeNull();
    }
  });

  it("字节逐一原样返回", async () => {
    const ref = putBlob(PNG, null);
    const res = await get(ref!.sha256);
    expect(Buffer.from(await res.arrayBuffer()).equals(PNG)).toBe(true);
  });

  it("★ 内容寻址 ⇒ immutable 缓存 —— 同一 URL 的字节永不改变", async () => {
    const ref = putBlob(PNG, null);
    const res = await get(ref!.sha256);
    expect(res.headers.get("cache-control")).toContain("immutable");
    expect(res.headers.get("cache-control")).toContain("max-age=31536000");
  });

  it("nosniff 在两条路径上都有 —— 图片路径也不能让浏览器自己猜类型", async () => {
    const img = putBlob(PNG, null);
    expect((await get(img!.sha256)).headers.get("x-content-type-options")).toBe("nosniff");
    const other = putBlob(SVG, null);
    expect((await get(other!.sha256)).headers.get("x-content-type-options")).toBe("nosniff");
  });
});
