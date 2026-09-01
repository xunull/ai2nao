import { describe, expect, it } from "vitest";
import type { CommandLeaderboard, SourceTrend } from "../src/aiRhythm/queries.js";
import { renderLeaderboardSvg } from "../src/cards/leaderboardSvg.js";
import { renderSourceTrendSvg, SERIES } from "../src/cards/sourceTrendSvg.js";

function expectValidSvg(svg: string) {
  expect(svg.startsWith("<svg")).toBe(true);
  expect(svg.trim().endsWith("</svg>")).toBe(true);
  expect(svg).not.toContain("NaN");
  expect(svg).not.toContain("undefined");
}
const rectCount = (svg: string) => (svg.match(/<rect/g) ?? []).length;

describe("renderSourceTrendSvg", () => {
  it("每周每个非零源一段;三色 + 图例 + footer", () => {
    const trend: SourceTrend = {
      weeks: [
        { week: "2026-W20", claude: 10, codex: 4, opencode: 2, total: 16 },
        { week: "2026-W21", claude: 8, codex: 0, opencode: 6, total: 14 },
      ],
      generatedAt: "2026-07-23T00:00:00.000Z",
    };
    const svg = renderSourceTrendSvg(trend);
    expectValidSvg(svg);
    // 背景 1 + 段(3+2=5)+ 每源一个图例块 —— 从 SERIES 派生,
    // 否则每加一个源这条就假红一次(它守的是柱子分段,不是源数)。
    expect(rectCount(svg)).toBe(1 + 5 + SERIES.length);
    expect(svg).toContain("#8250df"); // claude
    expect(svg).toContain("#1f6feb"); // codex
    expect(svg).toContain("#2da44e"); // opencode
    expect(svg).toContain("共 30 次");
    expect(svg).toContain("近 2 周");
  });

  it("图例带上每一个已接入的源 —— 写死标签名,少一个源会红", () => {
    const trend: SourceTrend = { weeks: [], generatedAt: "2026-07-23T00:00:00.000Z" };
    const svg = renderSourceTrendSvg(trend);
    // 计数断言从 SERIES 派生 → 对「SERIES 少一项」恒真无判别力。
    // 这一条写死标签,才是真正守住「加源没漏这张卡」的东西。
    for (const label of ["Claude", "Codex", "opencode", "Kimi", "Hermes"]) {
      expect(svg, `图例缺少 ${label}`).toContain(`>${label}</text>`);
    }
  });

  it("后端少给一个源的 key 时不吐 NaN —— 少画一段,不产生非法 SVG", () => {
    // 这正是这张卡历史上的病:后端 weeklySourceMix 与 SERIES 不同步。
    // 之前 `w[s.key]` 是 undefined → y/height 算出 NaN → SVG 非法。
    const trend = {
      weeks: [{ week: "2026-W29", claude: 3, codex: 2, opencode: 1, total: 6 }],
      generatedAt: "2026-07-23T00:00:00.000Z",
    } as unknown as SourceTrend; // 故意缺 kimi
    const svg = renderSourceTrendSvg(trend);
    expectValidSvg(svg);
    expect(svg).not.toContain("NaN");
    // 三段柱子 + 背景 + 每源图例;kimi 那段被跳过而不是画坏
    expect(rectCount(svg)).toBe(1 + 3 + SERIES.length);
  });

  it("只取最近 16 周", () => {
    const weeks = Array.from({ length: 30 }, (_, i) => ({
      week: `2026-W${String(i).padStart(2, "0")}`,
      claude: 1,
      codex: 0,
      opencode: 0,
      total: 1,
    }));
    const svg = renderSourceTrendSvg({ weeks, generatedAt: "2026-07-23T00:00:00.000Z" });
    expect(svg).toContain("近 16 周"); // 截断
    // 背景 1 + 16 段(每周仅 claude)+ 每源一个图例块
    expect(rectCount(svg)).toBe(1 + 16 + SERIES.length);
  });

  it("空数据:合法、近 0 周、无段(仅背景+图例)", () => {
    const svg = renderSourceTrendSvg({ weeks: [], generatedAt: "2026-07-23T00:00:00.000Z" });
    expectValidSvg(svg);
    expect(svg).toContain("共 0 次");
    expect(svg).toContain("近 0 周");
    expect(rectCount(svg)).toBe(1 + SERIES.length); // 背景 + 图例
  });
});

describe("renderLeaderboardSvg", () => {
  const mk = (commands: { name: string; count: number }[]): CommandLeaderboard => ({
    commands,
    maxCount: commands.length ? commands[0].count : 0,
    totalCommands: commands.reduce((s, c) => s + c.count, 0),
    distinctCommands: commands.length,
    generatedAt: "2026-07-23T00:00:00.000Z",
  });

  it("Top 8、命令名带 / 前缀、次数、footer", () => {
    const board = mk([
      { name: "graphify", count: 50 },
      { name: "ship", count: 20 },
    ]);
    const svg = renderLeaderboardSvg(board);
    expectValidSvg(svg);
    expect(svg).toContain("/graphify");
    expect(svg).toContain(">50<");
    expect(svg).toContain("共 70 次调用");
    expect(svg).toContain("2 个命令");
  });

  it("超过 8 条只画 8", () => {
    const board = mk(
      Array.from({ length: 12 }, (_, i) => ({ name: `cmd${i}`, count: 12 - i }))
    );
    const svg = renderLeaderboardSvg(board);
    // 背景 1 + 8 横条
    expect(rectCount(svg)).toBe(1 + 8);
  });

  it("命令名转义 & < >", () => {
    const svg = renderLeaderboardSvg(mk([{ name: "a&b", count: 3 }]));
    expect(svg).toContain("/a&amp;b");
  });

  it("空:合法、共 0 次调用", () => {
    const svg = renderLeaderboardSvg(mk([]));
    expectValidSvg(svg);
    expect(svg).toContain("共 0 次调用");
    expect(rectCount(svg)).toBe(1); // 仅背景
  });
});
