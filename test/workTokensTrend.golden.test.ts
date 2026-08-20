import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generateTrendLegacy as generateTrend } from "../src/workTokensTrend/legacyShape.js";
import { WINDOW_KEYS } from "../src/workTokensTrend/types.js";
import type { LegacyBucket } from "../src/workTokensTrend/legacyShape.js";
import {
  assertFixtureCoverage,
  buildTokensTrendFixture,
  FIXTURE_NOW,
  FIXTURE_TZ,
} from "./fixtures/tokensTrendFixture.js";

/**
 * **黄金快照 —— 归一重构的唯一安全网。**
 *
 * 87 个现有测试全部写在旧的平铺 DTO 上。改 DTO 就得改测试,而一个跟着你一起改的
 * 测试抓不住你。这份快照在重构**之前**冻结数值,重构之后逐个比对。
 * 单一 PR 意味着 `git bisect` 也帮不上忙,这层网更是唯一的。
 *
 * 两层,分文件存放,断言强度不同:
 *
 *   层一 `golden-layer1.json`  后端 `generateTrend()` 的全部数字,来自 SQL 聚合。
 *                              **硬断言,逐个相等**。差一个数就是重构搞砸了。
 *
 *   层二 `golden-layer2.json`  前端在「含/不含缓存」下算出的派生显示值。
 *                              5A(统一减 read + creation)会**故意**改动 claude 与 codex 的值,
 *                              所以这一层是「列出差异供核对」,改动时连同预期差异一起更新。
 *
 * 重新生成:`UPDATE_GOLDEN=1 npx vitest run test/workTokensTrend.golden.test.ts`
 * —— 只在你**打算**改数值时用,并且必须在 commit message 里说明改了哪些、为什么。
 */

const GOLDEN_DIR = join(__dirname, "fixtures");
const LAYER1 = join(GOLDEN_DIR, "golden-layer1.json");
const LAYER2 = join(GOLDEN_DIR, "golden-layer2.json");
const UPDATING = process.env.UPDATE_GOLDEN === "1";

/** 覆盖到的窗口 + 月模式。月份取 fixture 里真实有数据的四个月。 */
const MONTHS = ["2026-05", "2026-06", "2026-07", "2026-08"] as const;

const PRIOR_TZ = process.env.TZ;
beforeAll(() => {
  process.env.TZ = FIXTURE_TZ;
});
afterAll(() => {
  process.env.TZ = PRIOR_TZ;
});

/** `generatedAt` 是墙钟,不能进快照。其余全部来自 SQL 或固定的 now。 */
function stripVolatile<T>(res: T): T {
  const { generatedAt: _drop, ...rest } = res as T & { generatedAt?: string };
  return rest as T;
}

function buildLayer1(): Record<string, unknown> {
  const db = buildTokensTrendFixture();
  try {
    const out: Record<string, unknown> = {};
    for (const w of WINDOW_KEYS) {
      out[`window:${w}`] = stripVolatile(generateTrend(db, { window: w, now: FIXTURE_NOW }));
    }
    for (const m of MONTHS) {
      out[`month:${m}`] = stripVolatile(generateTrend(db, { month: m, now: FIXTURE_NOW }));
    }
    return out;
  } finally {
    db.close();
  }
}

/**
 * 层二:复刻前端 `WorkTokensTrend.tsx:780-794` 当前的「不含缓存」公式。
 *
 * ⚠️ 三个源现在**三种含义**:claude 与 codex 只减 cache-read,minimax 减 read + creation。
 * 这正是 5A 要统一掉的不一致。T6 改完之后这里的公式与 golden-layer2.json 一起更新,
 * 差异必须与设计文档里列出的清单逐条吻合。
 */
function derivedForBucket(b: LegacyBucket, includeCache: boolean) {
  return {
    claudeFullTokens: includeCache
      ? b.claudeTokens
      : Math.max(0, b.claudeTokens - b.claudeCacheReadInputTokens),
    codexFullTokens: includeCache
      ? b.codexTokens
      : Math.max(0, b.codexTokens - b.codexCachedInputTokens),
    minimaxFullTokens: includeCache
      ? b.minimaxTokens
      : Math.max(
          0,
          b.minimaxTokens - b.minimaxCacheReadInputTokens - b.minimaxCacheCreationInputTokens
        ),
    // 前端把 MiniMax 成本硬编码成 0 并照样堆进成本柱 —— 页面在说
    // 「MiniMax 不花钱」,真相是「不知道」。4A 要修的就是它。
    claudeCostUsd: b.claudeCostUsd,
    codexCostUsd: b.codexCostUsd,
    minimaxCostUsd: 0,
  };
}

function buildLayer2(): Record<string, unknown> {
  const db = buildTokensTrendFixture();
  try {
    const out: Record<string, unknown> = {};
    for (const w of WINDOW_KEYS) {
      const res = generateTrend(db, { window: w, now: FIXTURE_NOW });
      for (const includeCache of [true, false]) {
        out[`window:${w}/includeCache=${includeCache}`] = res.buckets.map((b) => ({
          bucketStart: b.bucketStart,
          ...derivedForBucket(b, includeCache),
        }));
      }
    }
    return out;
  } finally {
    db.close();
  }
}

function loadOrWrite(path: string, build: () => Record<string, unknown>): {
  actual: Record<string, unknown>;
  expected: Record<string, unknown> | null;
} {
  const actual = build();
  if (UPDATING || !existsSync(path)) {
    writeFileSync(path, `${JSON.stringify(actual, null, 2)}\n`);
    return { actual, expected: null };
  }
  return { actual, expected: JSON.parse(readFileSync(path, "utf-8")) };
}

describe("token 趋势页黄金快照", () => {
  it("fixture 组合覆盖度自检 —— 缺任何一个组合,层一就是恒绿的虚假安全感", () => {
    const db = buildTokensTrendFixture();
    try {
      const combos = assertFixtureCoverage(db);
      // 自检本身也要有拌线:确认它真的在数东西,而不是返回空数组然后「通过」。
      expect(combos.length).toBeGreaterThanOrEqual(25);
      expect(combos.every((c) => c.count > 0)).toBe(true);
    } finally {
      db.close();
    }
  });

  it("fixture 是确定性的 —— 连造两次,层一逐字节一致", () => {
    expect(JSON.stringify(buildLayer1())).toBe(JSON.stringify(buildLayer1()));
  });

  it("层一:后端全部数字与快照逐个相等(硬断言)", () => {
    const { actual, expected } = loadOrWrite(LAYER1, buildLayer1);
    if (expected === null) {
      expect(UPDATING || true).toBe(true); // 首次生成
      return;
    }
    expect(actual).toEqual(expected);
  });

  it("层二:派生显示值与快照一致(5A/4A 会故意改动这一层)", () => {
    const { actual, expected } = loadOrWrite(LAYER2, buildLayer2);
    if (expected === null) return;
    expect(actual).toEqual(expected);
  });

  it("层一确实覆盖了全部 7 个窗口与 4 个月", () => {
    const { actual } = loadOrWrite(LAYER1, buildLayer1);
    for (const w of WINDOW_KEYS) expect(actual).toHaveProperty(`window:${w}`);
    for (const m of MONTHS) expect(actual).toHaveProperty(`month:${m}`);
  });
});
