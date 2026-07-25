import { describe, expect, it } from "vitest";
import type { PersonalRecords, StreakRhythm } from "../src/aiRhythm/queries.js";
import type { AiToolView } from "../src/aiTools/types.js";
import type { WorkTokensTrendTotals } from "../src/workTokensTrend/types.js";
import { renderStatCard } from "../src/cards/statCard.js";
import {
  renderAiToolsCard,
  renderKimiQuotaCard,
  renderRecordsCard,
  renderStreakCard,
  renderTokenCard,
} from "../src/cards/statCards.js";

/** 合法 SVG + 无脏值。 */
function expectValidSvg(svg: string) {
  expect(svg.startsWith("<svg")).toBe(true);
  expect(svg.trim().endsWith("</svg>")).toBe(true);
  expect(svg).not.toContain("NaN");
  expect(svg).not.toContain("undefined");
}

describe("renderStatCard(原语)", () => {
  it("标题 / 大数字 / 小注 / stats / footer 都出现", () => {
    const svg = renderStatCard({
      title: "标题X",
      big: { value: "42", caption: "小注Y" },
      stats: [
        { label: "甲", value: "1 天" },
        { label: "乙", value: "2 天" },
      ],
      footer: "截至 2026-07-23",
    });
    expectValidSvg(svg);
    for (const s of ["标题X", "42", "小注Y", "甲", "1 天", "乙", "截至 2026-07-23"])
      expect(svg).toContain(s);
  });

  it("空 stats 不崩、无分隔线", () => {
    const svg = renderStatCard({
      title: "T",
      big: { value: "0" },
      stats: [],
      footer: "f",
    });
    expectValidSvg(svg);
    expect(svg).not.toContain("<line");
  });

  it("转义 & < > (防 SVG 注入)", () => {
    const svg = renderStatCard({
      title: "a & b",
      stats: [{ label: "<x>", value: "y & z" }],
      footer: "f",
    });
    expect(svg).toContain("a &amp; b");
    expect(svg).toContain("&lt;x&gt;");
    expect(svg).not.toContain("<x>");
  });
});

describe("renderStreakCard", () => {
  const base: StreakRhythm = {
    currentStreak: 7,
    longestStreak: 30,
    todayActive: true,
    lastActiveDay: "2026-07-23",
    totalActiveDays: 120,
    generatedAt: "2026-07-23T10:00:00.000Z",
  };
  it("当前/最长/累计/今天都在", () => {
    const svg = renderStreakCard(base);
    expectValidSvg(svg);
    expect(svg).toContain(">7<");
    expect(svg).toContain("30 天");
    expect(svg).toContain("120 天");
    expect(svg).toContain("已活跃");
  });
  it("断签(currentStreak 0)→ 灰色 accent", () => {
    const svg = renderStreakCard({ ...base, currentStreak: 0, todayActive: false });
    expect(svg).toContain("#8c959f");
    expect(svg).toContain("未活跃");
  });
});

describe("renderRecordsCard", () => {
  it("有数据:各极值出现", () => {
    const r: PersonalRecords = {
      busiestDay: { day: "2026-05-04", count: 88 },
      peakHour: { hour: "2026-05-04 14:00", count: 20 },
      total: 5000,
      firstDay: "2025-01-01",
      maxCharLen: 12000,
      generatedAt: "2026-07-23T00:00:00.000Z",
    };
    const svg = renderRecordsCard(r);
    expectValidSvg(svg);
    expect(svg).toContain("5000");
    expect(svg).toContain("05-04 · 88");
    expect(svg).toContain("20 条");
    expect(svg).toContain("2025-01-01");
    expect(svg).toContain("12000 字");
  });
  it("空库:null 字段显示 —,不出 NaN", () => {
    const svg = renderRecordsCard({
      busiestDay: null,
      peakHour: null,
      total: 0,
      firstDay: null,
      maxCharLen: 0,
      generatedAt: "2026-07-23T00:00:00.000Z",
    });
    expectValidSvg(svg);
    expect(svg).toContain("—");
  });
});

describe("renderAiToolsCard", () => {
  const mk = (toolKey: string, kind: AiToolView["kind"]): AiToolView => ({
    toolKey,
    name: toolKey,
    kind,
    vendor: null,
    detectSources: ["mac_apps"],
    version: null,
    installPath: null,
    firstSeenAt: "2026-01-01T00:00:00.000Z",
    lastSeenAt: "2026-07-01T00:00:00.000Z",
    missingSince: null,
  });
  it("按类型分组计数", () => {
    const views = [
      mk("claude-desktop", "desktop-app"),
      mk("cherry", "desktop-app"),
      mk("claude-code", "cli"),
      mk("ollama", "local-runtime"),
    ];
    const svg = renderAiToolsCard(views, "2026-07-23T00:00:00.000Z");
    expectValidSvg(svg);
    expect(svg).toContain(">4<"); // 大数字 = 工具总数
    expect(svg).toContain("桌面应用");
    expect(svg).toContain("2 个");
    expect(svg).toContain("命令行");
    expect(svg).toContain("本地运行时");
  });
  it("空:0 个、无类型行", () => {
    const svg = renderAiToolsCard([], "2026-07-23T00:00:00.000Z");
    expectValidSvg(svg);
    expect(svg).toContain(">0<");
  });
});

describe("renderKimiQuotaCard", () => {
  it("大数字 = 剩余最低的窗口,其余进 stats", () => {
    const svg = renderKimiQuotaCard(
      [
        { label: "套餐总额", remainingPercent: 90 },
        { label: "5 小时窗口", remainingPercent: 40 },
      ],
      "2026-07-24T00:00:00.000Z"
    );
    expectValidSvg(svg);
    expect(svg).toContain(">40%<"); // 最紧的那个当大数字
    expect(svg).toContain("5 小时窗口剩余"); // caption
    expect(svg).toContain("套餐总额"); // 另一个进 stats
    expect(svg).toContain(">90%<");
  });
  it("剩余 <15% → 橙红 accent", () => {
    const svg = renderKimiQuotaCard([{ label: "5 小时窗口", remainingPercent: 8 }], "2026-07-24T00:00:00.000Z");
    expect(svg).toContain("#cf222e");
  });
  it("传档位 → footer 带档位", () => {
    const svg = renderKimiQuotaCard(
      [{ label: "5 小时窗口", remainingPercent: 40 }],
      "2026-07-24T00:00:00.000Z",
      "试用"
    );
    expect(svg).toContain("试用 · 截至 2026-07-24");
  });
  it("空(未同步)→ 显 —,不出 NaN", () => {
    const svg = renderKimiQuotaCard([], "2026-07-24T00:00:00.000Z");
    expectValidSvg(svg);
    expect(svg).toContain("—");
  });
});

describe("renderTokenCard", () => {
  const totals = {
    totalTokens: 12_300_000,
    claudeTokens: 9_000_000,
    codexTokens: 3_300_000,
    minimaxTokens: 0,
    claudeCostUsd: 40,
    codexCostUsd: 5.5,
  } as unknown as WorkTokensTrendTotals;

  it("默认:总量(M)+ 各源,不露成本", () => {
    const svg = renderTokenCard(totals, { asOfIso: "2026-07-23T00:00:00.000Z" });
    expectValidSvg(svg);
    expect(svg).toContain("12.3M");
    expect(svg).toContain("Claude");
    expect(svg).toContain("Codex");
    expect(svg).not.toContain("MiniMax"); // 0 不显示
    expect(svg).not.toContain("$"); // 默认不露钱
  });
  it("--cost:附成本行", () => {
    const svg = renderTokenCard(totals, { cost: true, asOfIso: "2026-07-23T00:00:00.000Z" });
    expect(svg).toContain("$45.50");
  });
  it("十亿级(缓存重放)→ B 档,不显示 18610.1M", () => {
    const big = { ...totals, totalTokens: 18_610_000_000 } as WorkTokensTrendTotals;
    const svg = renderTokenCard(big, { asOfIso: "2026-07-23T00:00:00.000Z" });
    expect(svg).toContain("18.6B");
    expect(svg).not.toContain("18610"); // 不该落到 M 档的 18610.1M
  });
});
