import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { generateCardBundle } from "../src/cards/bundle.js";
import { CARD_REGISTRY } from "../src/cards/registry.js";
import { createApp } from "../src/serve/app.js";
import { openDatabase } from "../src/store/open.js";

const NOW = new Date("2026-07-23T12:00:00.000Z");

describe("CARD_REGISTRY", () => {
  it("name 唯一", () => {
    const names = CARD_REGISTRY.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("每张卡在空库上都能渲出合法 SVG(不抛)", () => {
    const dir = mkdtempSync(join(tmpdir(), "ai2nao-reg-"));
    const db = openDatabase(join(dir, "index.db"));
    try {
      for (const card of CARD_REGISTRY) {
        const svg = card.render(db, { now: NOW });
        expect(svg.startsWith("<svg"), card.name).toBe(true);
        expect(svg).not.toContain("NaN");
        expect(svg).not.toContain("undefined");
      }
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("generateCardBundle", () => {
  let dir: string;
  let db: ReturnType<typeof openDatabase>;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ai2nao-bundle-"));
    db = openDatabase(join(dir, "index.db"));
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("写出每张卡的 svg + 一个 README(空库不报错)", () => {
    const outDir = join(dir, "cards");
    const { files } = generateCardBundle(db, outDir, { now: NOW });

    // N 张卡 + README
    expect(files.length).toBe(CARD_REGISTRY.length + 1);
    for (const card of CARD_REGISTRY) {
      expect(existsSync(join(outDir, `${card.name}.svg`)), card.name).toBe(true);
    }
    expect(existsSync(join(outDir, "README.md"))).toBe(true);
  });

  it("README 引用每张卡(整行 markdown 或表格 <img>)+ 生成日期", () => {
    const outDir = join(dir, "cards");
    generateCardBundle(db, outDir, { now: NOW });
    const readme = readFileSync(join(outDir, "README.md"), "utf8");
    for (const card of CARD_REGISTRY) {
      const referenced =
        readme.includes(`![${card.name}](${card.name}.svg)`) ||
        readme.includes(`src="${card.name}.svg"`);
      expect(referenced, card.name).toBe(true);
      expect(readme).toContain(card.title); // 标题:## 或 <h3>
    }
    // 宽卡整行(markdown),窄卡并排:三对合进同一张表 → 列对齐。
    expect(readme).toContain("![rhythm](rhythm.svg)");
    expect(readme).toContain("<table");
    expect((readme.match(/<table/g) ?? []).length).toBe(1); // 单表,列共享才对齐
    expect(readme).toContain(`src="streak.svg"`);
    expect(readme).toContain("更新于 2026-07-23");
    expect(readme).toContain("github.com/xunull/ai2nao");
  });
});

describe("GET /api/cards/:name.svg", () => {
  let dir: string;
  let db: ReturnType<typeof openDatabase>;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ai2nao-cardapi-"));
    db = openDatabase(join(dir, "index.db"));
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("已知卡返回 image/svg+xml", async () => {
    const app = createApp({ db });
    const res = await app.request("http://x/api/cards/streak.svg");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("image/svg+xml");
    expect((await res.text()).startsWith("<svg")).toBe(true);
  });

  it("未知卡 → 404", async () => {
    const app = createApp({ db });
    const res = await app.request("http://x/api/cards/nope.svg");
    expect(res.status).toBe(404);
  });
});
