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
 * 层二:复刻前端 `WorkTokensTrend.tsx` 的「不含缓存」公式。
 *
 * **T6 起四个源统一**:不含缓存 = fresh + output(两种 cache 都不算真实新增)。
 * 归一之前 claude / codex 只减 cache-read、minimax 减 read + create ——
 * 同一个开关三种含义。
 *
 * T6 落地时层二的实测差异(改之前预先算出来核对过,逐条命中):
 *   claude   19 个值变化,每一个都恰好减少该桶的 cacheCreationInput,合计 15300
 *   codex    0 个变化(它没有 cache 写入概念,cacheCreation 恒 0)
 *   minimax  0 个变化(它本来就是两种都减)
 */
function derivedForBucket(b: LegacyBucket, includeCache: boolean) {
  const excl = (total: number, read: number, creation: number) =>
    includeCache ? total : Math.max(0, total - read - creation);
  return {
    claudeFullTokens: excl(
      b.claudeTokens,
      b.claudeCacheReadInputTokens,
      b.claudeCacheCreationInputTokens
    ),
    // codex 没有 cache 写入概念 → creation 传 0
    codexFullTokens: excl(b.codexTokens, b.codexCachedInputTokens, 0),
    minimaxFullTokens: excl(
      b.minimaxTokens,
      b.minimaxCacheReadInputTokens,
      b.minimaxCacheCreationInputTokens
    ),
    claudeCostUsd: b.claudeCostUsd,
    codexCostUsd: b.codexCostUsd,
    // MiniMax 无定价 —— T7 会把它从成本柱里拿掉并标注,这里先保留 0 以隔离改动。
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

/**
 * 稳定序列化 —— 递归排序对象键。
 *
 * 快照的职责是钉**数值**,不是键序。不排序的话,重构改了对象构造顺序就会产生
 * 上千行「什么都没变」的 diff(T6 实测:层一 1204 行变化、0 处语义差异),
 * 而真出问题时那个 diff 里没人看得出来。
 */
function stableStringify(v: unknown): string {
  const sortKeys = (x: unknown): unknown => {
    if (Array.isArray(x)) return x.map(sortKeys);
    if (x === null || typeof x !== "object") return x;
    const o = x as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(o)
        .sort()
        .map((k) => [k, sortKeys(o[k])])
    );
  };
  return `${JSON.stringify(sortKeys(v), null, 2)}\n`;
}

function loadOrWrite(path: string, build: () => Record<string, unknown>): {
  actual: Record<string, unknown>;
  expected: Record<string, unknown> | null;
} {
  const actual = build();
  if (UPDATING || !existsSync(path)) {
    writeFileSync(path, stableStringify(actual));
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
    expect(stableStringify(buildLayer1())).toBe(stableStringify(buildLayer1()));
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
