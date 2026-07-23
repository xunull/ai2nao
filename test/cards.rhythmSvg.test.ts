import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RhythmHeatmap } from "../src/aiRhythm/queries.js";
import { colorLevel } from "../src/cards/colorScale.js";
import { renderRhythmSvg } from "../src/cards/rhythmSvg.js";
import { createApp } from "../src/serve/app.js";
import { openDatabase } from "../src/store/open.js";

const HM = (over: Partial<RhythmHeatmap>): RhythmHeatmap => ({
  cells: [],
  maxCount: 0,
  total: 0,
  peak: null,
  generatedAt: "2026-07-22T00:00:00.000Z",
  ...over,
});

const rectCount = (svg: string) => (svg.match(/<rect/g) ?? []).length;

describe("colorLevel 分桶", () => {
  it("空 / maxCount 为 0 → 0(防除零)", () => {
    expect(colorLevel(0, 10)).toBe(0);
    expect(colorLevel(5, 0)).toBe(0);
    expect(colorLevel(0, 0)).toBe(0);
  });
  it("按 maxCount 四分位分 1..4", () => {
    expect(colorLevel(2, 10)).toBe(1); // 0.2
    expect(colorLevel(5, 10)).toBe(2); // 0.5
    expect(colorLevel(7, 10)).toBe(3); // 0.7
    expect(colorLevel(10, 10)).toBe(4); // 1.0
  });
});

describe("renderRhythmSvg", () => {
  it("已知 heatmap → 合法 SVG、7×24 格全渲染、peak 最深、footer 正确", () => {
    const hm = HM({
      cells: [
        { weekday: 1, hour: 9, count: 10 }, // 周一 09
        { weekday: 5, hour: 14, count: 4 }, // 周五 14
      ],
      maxCount: 10,
      total: 14,
      peak: { weekday: 1, hour: 9, count: 10 },
    });
    const svg = renderRhythmSvg(hm);

    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg.trim().endsWith("</svg>")).toBe(true);
    expect(rectCount(svg)).toBe(7 * 24 + 1); // 168 格 + 1 背景
    expect(svg).toContain("#216e39"); // 峰值格用最深档
    expect(svg).toContain("共 14 次");
    expect(svg).toContain("峰值 周一 09:00");
    expect(svg).toContain("截至 2026-07-22");
    expect(svg).not.toContain("NaN");
    expect(svg).not.toContain("undefined");
  });

  it("确定性:同输入 → 同输出", () => {
    const hm = HM({ cells: [{ weekday: 3, hour: 22, count: 7 }], maxCount: 7, total: 7, peak: { weekday: 3, hour: 22, count: 7 } });
    expect(renderRhythmSvg(hm)).toBe(renderRhythmSvg(hm));
  });

  it("空库 → 合法 SVG、无 NaN、footer 暂无数据、无深色格", () => {
    const svg = renderRhythmSvg(HM({}));
    expect(rectCount(svg)).toBe(7 * 24 + 1);
    expect(svg).toContain("共 0 次");
    expect(svg).toContain("暂无数据");
    expect(svg).not.toContain("NaN");
    expect(svg).not.toContain("undefined");
    expect(svg).not.toContain("#216e39"); // 无峰值格
  });

  it("zero-fill:稀疏 cells 也渲染满 7×24", () => {
    const svg = renderRhythmSvg(HM({ cells: [{ weekday: 0, hour: 0, count: 3 }], maxCount: 3, total: 3, peak: { weekday: 0, hour: 0, count: 3 } }));
    expect(rectCount(svg)).toBe(7 * 24 + 1);
    expect(svg).toContain("峰值 周日 00:00"); // weekday 0 = 周日
  });
});

describe("GET /api/cards/rhythm.svg", () => {
  let dir: string;
  let db: ReturnType<typeof openDatabase>;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ai2nao-card-"));
    db = openDatabase(join(dir, "index.db"));
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("返回 image/svg+xml,body 是 SVG(空库也不报错)", async () => {
    const app = createApp({ db });
    const res = await app.request("http://x/api/cards/rhythm.svg");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("image/svg+xml");
    const body = await res.text();
    expect(body.startsWith("<svg")).toBe(true);
    expect(body).toContain("共 0 次");
  });
});
