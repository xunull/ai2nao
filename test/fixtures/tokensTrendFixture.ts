import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { openDatabase } from "../../src/store/open.js";
import {
  MINIMAX_METHOD_CACHE_CREATE,
  MINIMAX_METHOD_CACHE_READ,
} from "../../src/minimaxTokenUsage/types.js";

/**
 * Token 趋势页归一重构的**黄金快照 fixture**。
 *
 * 为什么要有它:87 个现有测试全部写在旧的平铺 DTO 上,改 DTO 就得改测试 ——
 * 一个跟着你一起改的测试抓不住你。唯一能跨 DTO 存活的是重构前冻结的数值。
 *
 * 两层:
 *   层一  后端 `generateTrend()` 响应里的每一个数字。全部来自 SQL 聚合,
 *         **重构前后必须逐个相等**,差一个就是失败。
 *   层二  前端在「含/不含缓存」「成本模式」下算出来的派生显示值。
 *         5A / 4A / 1A 会**故意**改动它们,差异逐条列出核对,不是硬断言。
 *
 * ⚠️ 层一只能保护它**播种过的形状**。fixture 漏了某个组合(比如
 * `token_status='error'`),那条路径在重构中静默漂移而快照全绿 ——
 * 这比没有快照更危险,因为它给出虚假的安全感。
 * 所以 `assertFixtureCoverage()` 是这个模块的一等公民,不是附赠品。
 */

/** 分桶表达式用 `localtime`,所以时区必须钉死,否则快照在别的机器上换个值。 */
export const FIXTURE_TZ = "Asia/Shanghai";

/** 固定时钟。= 2026-08-20 12:00 Asia/Shanghai。 */
export const FIXTURE_NOW = new Date("2026-08-20T04:00:00.000Z");

/** 播种用的模型名。刻意不用真实模型名,免得被 vendored MODEL_PRICES 意外定价。 */
export const FX_MODEL_PRICED = "fx-priced-1";
export const FX_MODEL_UNPRICED = "fx-unpriced-1";

/** 固定的价格同步时间,让 `priceSnapshotDate` 也是确定值。 */
const FX_SYNCED_AT = "2026-08-01T00:00:00.000Z";

type ClaudeSeed = {
  id: string;
  updated: string;
  model: string | null;
  status: "full" | "unknown" | "error";
  /** 融合值:必须 ≥ cacheRead + cacheCreation(生产口径,见 normalize.ts)。 */
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
  missingSince?: string | null;
  projectKey?: string;
};

type CodexSeed = {
  id: string;
  updated: string;
  model: string | null;
  status: "full" | "unknown" | "error";
  /** 融合值:必须 ≥ cachedInput。 */
  input: number;
  output: number;
  cachedInput: number;
  reasoning: number;
  missingSince?: string | null;
  projectKey?: string;
};

type MinimaxSeed = {
  at: string;
  method: string;
  model: string;
  input: number;
  output: number;
};

function seedClaude(db: Database.Database, r: ClaudeSeed): void {
  const total = r.input + r.output;
  db.prepare(
    `INSERT INTO claude_session_token_usage
       (session_id, project_id, file_path, file_mtime_ms, file_size_bytes,
        cwd, project_key, project_path, identity_confidence, title,
        created_at, last_updated_at, input_tokens, output_tokens, total_tokens,
        token_status, parse_error, missing_since, source_seen_at, updated_at,
        cache_read_input_tokens, cache_creation_input_tokens, model, preview, message_count)
     VALUES (?, 'p', ?, 0, 0, '/p', ?, '/p', 'high', null,
             null, ?, ?, ?, ?, ?, null, ?, ?, ?, ?, ?, ?, null, 1)`
  ).run(
    r.id,
    `/p/${r.id}.jsonl`,
    r.projectKey ?? "/p",
    r.updated,
    r.input,
    r.output,
    total,
    r.status,
    r.missingSince ?? null,
    r.updated,
    r.updated,
    r.cacheRead,
    r.cacheCreation,
    r.model
  );
  // 事件行:趋势页的分桶走 event 表 JOIN session 表,两边都要有。
  db.prepare(
    `INSERT INTO claude_token_usage_event
       (session_id, message_id, event_at, input_tokens, output_tokens,
        cache_read_input_tokens, cache_creation_input_tokens)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(r.id, `${r.id}-m1`, r.updated, r.input, r.output, r.cacheRead, r.cacheCreation);
}

function seedCodex(db: Database.Database, r: CodexSeed): void {
  const total = r.input + r.output;
  db.prepare(
    `INSERT INTO codex_session_token_usage
       (session_id, rollout_path, rollout_mtime_ms, rollout_size_bytes,
        cwd, project_key, project_path, identity_confidence, title, model, git_branch,
        created_at, last_updated_at, input_tokens, output_tokens, total_tokens,
        token_status, parse_error, missing_since, source_seen_at, updated_at,
        reasoning_output_tokens, cached_input_tokens)
     VALUES (?, ?, 0, 0, '/p', ?, '/p', 'high', null, ?, null,
             null, ?, ?, ?, ?, ?, null, ?, ?, ?, ?, ?)`
  ).run(
    r.id,
    `/p/${r.id}.jsonl`,
    r.projectKey ?? "/p",
    r.model,
    r.updated,
    r.input,
    r.output,
    total,
    r.status,
    r.missingSince ?? null,
    r.updated,
    r.updated,
    r.reasoning,
    r.cachedInput
  );
  db.prepare(
    `INSERT INTO codex_token_usage_event
       (session_id, event_at, input_tokens, output_tokens,
        reasoning_output_tokens, cached_input_tokens)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(r.id, r.updated, r.input, r.output, r.reasoning, r.cachedInput);
}

function seedMinimax(db: Database.Database, r: MinimaxSeed): void {
  db.prepare(
    `INSERT INTO minimax_token_usage_event
       (event_at, method, model, api_token_name, input_tokens, output_tokens,
        consume_cash, raw_json)
     VALUES (?, ?, ?, 'fx-key', ?, ?, null, null)`
  ).run(r.at, r.method, r.model, r.input, r.output);
}

/**
 * 造一个确定性的 fixture 库。
 *
 * 时间跨度 2026-05-06 → 2026-08-19,覆盖 1d / 1w / 1m / 3m / 6m 全部窗口,
 * 跨 4 个自然月(月份选择器与 monthRange 都要有东西可选)。
 * 中间刻意留了空桶(08-16 一整天没有任何源的数据)。
 */
export function buildTokensTrendFixture(): Database.Database {
  const dir = mkdtempSync(join(tmpdir(), "ai2nao-trend-golden-"));
  const db = openDatabase(join(dir, "fixture.db"));

  // 价格表:只给 FX_MODEL_PRICED 定价。FX_MODEL_UNPRICED 与 null model 走 unpriced 路径。
  db.prepare(
    `INSERT INTO model_prices
       (provider, model_id, input, output, cache_read, cache_creation, source, synced_at)
     VALUES ('fixture', ?, 2e-6, 1e-5, 2e-7, 2.5e-6, 'fixture', ?)`
  ).run(FX_MODEL_PRICED, FX_SYNCED_AT);

  // ── claude ──────────────────────────────────────────────────────────────
  // full + 有价 + 两种 cache 都非零(主力形状)
  seedClaude(db, { id: "c-full-priced-1", updated: "2026-08-19T02:00:00.000Z", model: FX_MODEL_PRICED, status: "full", input: 10000, output: 300, cacheRead: 7000, cacheCreation: 2000 });
  seedClaude(db, { id: "c-full-priced-2", updated: "2026-08-18T06:30:00.000Z", model: FX_MODEL_PRICED, status: "full", input: 5000, output: 150, cacheRead: 4000, cacheCreation: 0 });
  // full + 有价 + 完全无 cache(守着「cache 全 0」这条分支)
  seedClaude(db, { id: "c-full-nocache", updated: "2026-08-17T09:00:00.000Z", model: FX_MODEL_PRICED, status: "full", input: 800, output: 90, cacheRead: 0, cacheCreation: 0 });
  // full + 无价模型 → 计入 unpricedTokenCount
  seedClaude(db, { id: "c-full-unpriced", updated: "2026-08-15T03:00:00.000Z", model: FX_MODEL_UNPRICED, status: "full", input: 3000, output: 120, cacheRead: 2500, cacheCreation: 100 });
  // full + model 为 null → 也是 unpriced(真库里 claude 有 18 个这样的 session)
  seedClaude(db, { id: "c-full-nullmodel", updated: "2026-08-14T11:00:00.000Z", model: null, status: "full", input: 1500, output: 60, cacheRead: 1000, cacheCreation: 200 });
  // unknown / error:进 session 计数,**不进 token SUM**(querySessionTableBuckets 的口径)
  seedClaude(db, { id: "c-unknown", updated: "2026-08-13T05:00:00.000Z", model: FX_MODEL_PRICED, status: "unknown", input: 999999, output: 999999, cacheRead: 0, cacheCreation: 0 });
  seedClaude(db, { id: "c-error", updated: "2026-08-12T05:00:00.000Z", model: FX_MODEL_PRICED, status: "error", input: 888888, output: 888888, cacheRead: 0, cacheCreation: 0 });
  // missing_since 非空 → 整行被排除(连 session 计数都不进)
  seedClaude(db, { id: "c-missing", updated: "2026-08-11T05:00:00.000Z", model: FX_MODEL_PRICED, status: "full", input: 777777, output: 777777, cacheRead: 0, cacheCreation: 0, missingSince: "2026-08-12T00:00:00.000Z" });
  // 跨月:6m 窗口与 monthRange 要能看到 5 / 6 / 7 月
  seedClaude(db, { id: "c-may", updated: "2026-05-06T02:00:00.000Z", model: FX_MODEL_PRICED, status: "full", input: 2000, output: 80, cacheRead: 1200, cacheCreation: 300 });
  seedClaude(db, { id: "c-jun", updated: "2026-06-10T02:00:00.000Z", model: FX_MODEL_PRICED, status: "full", input: 2200, output: 90, cacheRead: 1300, cacheCreation: 350 });
  seedClaude(db, { id: "c-jul", updated: "2026-07-15T02:00:00.000Z", model: FX_MODEL_PRICED, status: "full", input: 2400, output: 100, cacheRead: 1400, cacheCreation: 400 });

  // ── codex ───────────────────────────────────────────────────────────────
  // codex 没有 cache_creation 概念,只有 cached_input;有 reasoning。
  seedCodex(db, { id: "x-full-priced-1", updated: "2026-08-19T03:00:00.000Z", model: FX_MODEL_PRICED, status: "full", input: 8000, output: 400, cachedInput: 6000, reasoning: 250 });
  // reasoning 为 0 的分支
  seedCodex(db, { id: "x-full-noreason", updated: "2026-08-18T07:00:00.000Z", model: FX_MODEL_PRICED, status: "full", input: 3000, output: 200, cachedInput: 1000, reasoning: 0 });
  // cached_input 为 0 的分支
  seedCodex(db, { id: "x-full-nocache", updated: "2026-08-17T10:00:00.000Z", model: FX_MODEL_PRICED, status: "full", input: 700, output: 70, cachedInput: 0, reasoning: 30 });
  seedCodex(db, { id: "x-full-unpriced", updated: "2026-08-15T04:00:00.000Z", model: FX_MODEL_UNPRICED, status: "full", input: 2000, output: 130, cachedInput: 1500, reasoning: 40 });
  seedCodex(db, { id: "x-full-nullmodel", updated: "2026-08-14T12:00:00.000Z", model: null, status: "full", input: 1100, output: 55, cachedInput: 800, reasoning: 20 });
  seedCodex(db, { id: "x-unknown", updated: "2026-08-13T06:00:00.000Z", model: FX_MODEL_PRICED, status: "unknown", input: 999999, output: 999999, cachedInput: 0, reasoning: 0 });
  seedCodex(db, { id: "x-error", updated: "2026-08-12T06:00:00.000Z", model: FX_MODEL_PRICED, status: "error", input: 888888, output: 888888, cachedInput: 0, reasoning: 0 });
  seedCodex(db, { id: "x-missing", updated: "2026-08-11T06:00:00.000Z", model: FX_MODEL_PRICED, status: "full", input: 777777, output: 777777, cachedInput: 0, reasoning: 0, missingSince: "2026-08-12T00:00:00.000Z" });
  seedCodex(db, { id: "x-jun", updated: "2026-06-11T03:00:00.000Z", model: FX_MODEL_PRICED, status: "full", input: 1800, output: 75, cachedInput: 900, reasoning: 15 });

  // ── minimax ─────────────────────────────────────────────────────────────
  // 无 session 表 → 没有三态计数;cache 靠 method 分类。
  seedMinimax(db, { at: "2026-08-19T04:00:00.000Z", method: "Text API", model: "fx-mm", input: 900, output: 60 });
  seedMinimax(db, { at: "2026-08-19T05:00:00.000Z", method: MINIMAX_METHOD_CACHE_READ, model: "fx-mm", input: 700, output: 0 });
  seedMinimax(db, { at: "2026-08-18T08:00:00.000Z", method: MINIMAX_METHOD_CACHE_CREATE, model: "fx-mm", input: 400, output: 0 });
  seedMinimax(db, { at: "2026-07-16T04:00:00.000Z", method: "Text API", model: "fx-mm", input: 300, output: 20 });

  // 2026-08-16 整天没有任何源的数据 —— 空桶分支,zero-fill 必须补出这一格。
  return db;
}

/** 一个组合的标签。缺任何一个,黄金快照的层一就是「恒绿的虚假安全感」。 */
export type CoverageCombo = {
  key: string;
  /** 该组合在 fixture 里的行数;0 表示没播种到。 */
  count: number;
};

/**
 * fixture 组合覆盖度自检 —— 这是那个 critical gap 的修法。
 *
 * 层一断言只能保护它播种过的形状。这里把「必须存在」的组合列成清单并逐条数,
 * 缺任何一个就抛,让 T1 直接失败,而不是让快照静静地绿下去。
 */
export function assertFixtureCoverage(db: Database.Database): CoverageCombo[] {
  const one = (key: string, sql: string, ...params: unknown[]): CoverageCombo => ({
    key,
    count: (db.prepare(sql).get(...(params as [])) as { n: number }).n,
  });

  const combos: CoverageCombo[] = [
    // claude × 三态
    one("claude/status=full", `SELECT COUNT(*) n FROM claude_session_token_usage WHERE token_status='full' AND missing_since IS NULL`),
    one("claude/status=unknown", `SELECT COUNT(*) n FROM claude_session_token_usage WHERE token_status='unknown' AND missing_since IS NULL`),
    one("claude/status=error", `SELECT COUNT(*) n FROM claude_session_token_usage WHERE token_status='error' AND missing_since IS NULL`),
    one("claude/missing_since 非空", `SELECT COUNT(*) n FROM claude_session_token_usage WHERE missing_since IS NOT NULL`),
    // claude × 定价三态
    one("claude/model 有价", `SELECT COUNT(*) n FROM claude_session_token_usage WHERE model=? AND token_status='full'`, FX_MODEL_PRICED),
    one("claude/model 无价", `SELECT COUNT(*) n FROM claude_session_token_usage WHERE model=? AND token_status='full'`, FX_MODEL_UNPRICED),
    one("claude/model 为 null", `SELECT COUNT(*) n FROM claude_session_token_usage WHERE model IS NULL AND token_status='full'`),
    // claude × cache 分支
    one("claude/cacheRead 与 cacheCreation 都非零", `SELECT COUNT(*) n FROM claude_session_token_usage WHERE cache_read_input_tokens>0 AND cache_creation_input_tokens>0`),
    one("claude/cacheCreation 为零", `SELECT COUNT(*) n FROM claude_session_token_usage WHERE cache_read_input_tokens>0 AND cache_creation_input_tokens=0`),
    one("claude/两种 cache 都为零", `SELECT COUNT(*) n FROM claude_session_token_usage WHERE cache_read_input_tokens=0 AND cache_creation_input_tokens=0 AND token_status='full'`),
    // codex × 三态
    one("codex/status=full", `SELECT COUNT(*) n FROM codex_session_token_usage WHERE token_status='full' AND missing_since IS NULL`),
    one("codex/status=unknown", `SELECT COUNT(*) n FROM codex_session_token_usage WHERE token_status='unknown' AND missing_since IS NULL`),
    one("codex/status=error", `SELECT COUNT(*) n FROM codex_session_token_usage WHERE token_status='error' AND missing_since IS NULL`),
    one("codex/missing_since 非空", `SELECT COUNT(*) n FROM codex_session_token_usage WHERE missing_since IS NOT NULL`),
    // codex × 定价三态
    one("codex/model 有价", `SELECT COUNT(*) n FROM codex_session_token_usage WHERE model=? AND token_status='full'`, FX_MODEL_PRICED),
    one("codex/model 无价", `SELECT COUNT(*) n FROM codex_session_token_usage WHERE model=? AND token_status='full'`, FX_MODEL_UNPRICED),
    one("codex/model 为 null", `SELECT COUNT(*) n FROM codex_session_token_usage WHERE model IS NULL AND token_status='full'`),
    // codex 独有维度
    one("codex/reasoning 非零", `SELECT COUNT(*) n FROM codex_session_token_usage WHERE reasoning_output_tokens>0`),
    one("codex/reasoning 为零", `SELECT COUNT(*) n FROM codex_session_token_usage WHERE reasoning_output_tokens=0 AND token_status='full'`),
    one("codex/cachedInput 非零", `SELECT COUNT(*) n FROM codex_session_token_usage WHERE cached_input_tokens>0`),
    one("codex/cachedInput 为零", `SELECT COUNT(*) n FROM codex_session_token_usage WHERE cached_input_tokens=0 AND token_status='full'`),
    // minimax × method 三类
    one("minimax/普通 method", `SELECT COUNT(*) n FROM minimax_token_usage_event WHERE method NOT IN (?, ?)`, MINIMAX_METHOD_CACHE_READ, MINIMAX_METHOD_CACHE_CREATE),
    one("minimax/cache-read", `SELECT COUNT(*) n FROM minimax_token_usage_event WHERE method=?`, MINIMAX_METHOD_CACHE_READ),
    one("minimax/cache-create", `SELECT COUNT(*) n FROM minimax_token_usage_event WHERE method=?`, MINIMAX_METHOD_CACHE_CREATE),
    // 跨月:monthRange 与月模式要有多个月可选
    one("跨月/至少 4 个不同的自然月", `
      SELECT COUNT(*) n FROM (
        SELECT DISTINCT strftime('%Y-%m', last_updated_at, 'localtime') m FROM claude_session_token_usage
        UNION SELECT DISTINCT strftime('%Y-%m', last_updated_at, 'localtime') FROM codex_session_token_usage
        UNION SELECT DISTINCT strftime('%Y-%m', event_at, 'localtime') FROM minimax_token_usage_event
      ) WHERE m IS NOT NULL`),
    // 价格表本身
    one("price/model_prices 有行", `SELECT COUNT(*) n FROM model_prices`),
  ];

  const missing = combos.filter((c) => c.count === 0);
  if (missing.length > 0) {
    throw new Error(
      `黄金快照 fixture 覆盖度不足,以下组合一行都没有 —— 层一断言会在这些路径上恒绿:\n` +
        missing.map((m) => `  · ${m.key}`).join("\n")
    );
  }
  // 跨月这条要 ≥ 4,不是 ≥ 1。
  const months = combos.find((c) => c.key.startsWith("跨月/"))!;
  if (months.count < 4) {
    throw new Error(`黄金快照 fixture 只覆盖了 ${months.count} 个自然月,需要至少 4 个(月模式与 monthRange 才有意义)`);
  }
  return combos;
}
