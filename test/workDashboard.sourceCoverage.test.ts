import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openDatabase } from "../src/store/open.js";
import { CLAUDE_TOKEN_USAGE_RULE_VERSION } from "../src/claudeTokenUsage/types.js";
import {
  buildWorkDashboard,
  buildWorkTokenRanking,
  defaultDashboardCollectors,
  DEFAULT_WORK_DASHBOARD_OPTIONS,
  DEFAULT_WORK_TOKEN_RANKING_OPTIONS,
} from "../src/workDashboard/aggregate.js";
import {
  DASHBOARD_SOURCES,
  type DashboardCollectors,
  type DashboardSource,
} from "../src/workDashboard/types.js";

/**
 * 加了一个源却只接了两个入口函数中的一个 —— 这组用例就是为这件事存在的。
 *
 * 背景:`buildWorkDashboard` 与 `buildWorkTokenRanking` 是两个**并列的独立函数**,
 * 各自维护一套逐源块。上一轮加 kimi 时只接了前者,后者里 kimi 出现 0 次,
 * 排行页上只有 kimi 活动的项目根本不在榜上 —— 而 commit message 声称接好了。
 * 那个漏接对当时的测试完全隐形,因为**全测试套件没有一处使用
 * `defaultDashboardCollectors`**,全是手搓 mock deps,而手搓 mock 只会覆盖
 * 作者记得去 mock 的源。
 *
 * 所以这里坚持走真实入口 + 真实 deps 构造。代价是
 * `defaultDashboardCollectors(db)` 不是纯读库的:
 *
 * ```
 *   listClaude   有 db 时 collectIndexedClaude(db)      纯读库  ✓
 *   listKimi     collectIndexedKimi(db)                 纯读库  ✓
 *   listCodex    collectDefaultCodex                    扫 ~/.codex/sessions   ✗
 *   listOpencode collectDefaultOpencode                 读外部 opencode.db     ✗
 * ```
 *
 * 后两个会读到开发者本机的真实数据。用 `HOME` 重定向到临时目录隔离
 * (实测 `os.homedir()` 认 `$HOME`),于是它们看到的是一个空 home。
 *
 * 因此断言分两档:
 *   - **读 index.db 的源**(claude-code / kimi):播了种子就**必须出真实行**,
 *     且不能有 warning 诊断。只断言「不静默」是不够的 —— 一个永远失败的源
 *     会产诊断,于是永远绿。
 *   - **读文件系统的源**(codex / opencode):空 home 下没有数据可播,断言
 *     **收集器被问过**。
 *
 * 第二档最初写的是「不许静默:要么出行,要么给出诊断」,实测两条都红 ——
 * 空 home 下 codex 与 opencode 确实零行零诊断,而那是**有意为之**:
 * `collectDefaultOpencode` 明确把 `db-not-found` 诊断丢掉,注释写着「没装
 * opencode 对大多数用户是正常状态,不是警告」。所以「没有输出」对这两个源
 * 是合法的,那个不变式太强了。
 *
 * 真正区分 T12 那个 bug 的信号不是「有没有输出」,而是**收集器有没有被问过**:
 * 当时 kimi 压根不在 `buildWorkTokenRanking` 的代码路径上,那个函数里 kimi
 * 出现 0 次。所以第二档改成把 deps 包一层探针,断言「请求了这个源 → 这个源的
 * 收集器被调用了」。下面两张 Record 是穷尽的,加第五个源时必须在这里表态。
 */

const DB_BACKED: readonly DashboardSource[] = ["claude-code", "kimi"];

const PRIOR_HOME = process.env.HOME;
const PRIOR_TZ = process.env.TZ;
let fakeHome: string;

beforeAll(() => {
  fakeHome = mkdtempSync(join(tmpdir(), "ai2nao-cov-home-"));
  process.env.HOME = fakeHome;
  process.env.TZ = "Asia/Shanghai";
});

afterAll(() => {
  if (PRIOR_HOME === undefined) delete process.env.HOME;
  else process.env.HOME = PRIOR_HOME;
  process.env.TZ = PRIOR_TZ;
});

const NOW = new Date("2026-08-20T04:00:00.000Z");
const AT = "2026-08-19T02:00:00.000Z";

function freshDb(): Database.Database {
  return openDatabase(join(mkdtempSync(join(tmpdir(), "ai2nao-cov-")), "t.db"));
}

function seedClaude(db: Database.Database): void {
  db.prepare(
    `INSERT INTO claude_session_token_usage
       (session_id, project_id, file_path, file_mtime_ms, file_size_bytes, cwd,
        project_key, project_path, identity_confidence, title, created_at,
        last_updated_at, input_tokens, output_tokens, total_tokens, token_status,
        parse_error, missing_since, source_seen_at, updated_at,
        cache_read_input_tokens, cache_creation_input_tokens, model, preview, message_count)
     VALUES ('c1', 'p', '/p/c1', 0, 0, '/work/demo', '/work/demo', '/work/demo',
             'high', 'claude 会话', ?, ?, 400, 100, 500, 'full',
             null, null, ?, ?, 0, 0, 'sonnet', '第一句', 3)`
  ).run(AT, AT, AT, AT);
  db.prepare(
    `INSERT INTO claude_token_usage_event
       (session_id, message_id, event_at, input_tokens, output_tokens,
        cache_read_input_tokens, cache_creation_input_tokens)
     VALUES ('c1', 'c1-m', ?, 400, 100, 0, 0)`
  ).run(AT);
  // 也要播 state 表 —— 否则 getClaudeTokenUsageStatus 报 not_built,
  // 页面上多一条「索引陈旧」警告。种子代表的是一个**健康**的源。
  db.prepare(
    `INSERT INTO claude_session_token_usage_state
       (id, rule_version, last_rebuilt_at, last_error, source_session_count,
        indexed_session_count, token_known_session_count,
        token_unknown_session_count, error_session_count,
        skipped_unchanged_count, duration_ms, updated_at)
     VALUES (1, ?, ?, null, 1, 1, 1, 0, 0, 0, 5, ?)`
  ).run(CLAUDE_TOKEN_USAGE_RULE_VERSION, AT, AT);
}

function seedKimi(db: Database.Database): void {
  db.prepare(
    `INSERT INTO kimi_agent_token_usage
       (session_id, agent, file_path, file_mtime_ms, file_size_bytes, root_kind,
        cwd, project_key, project_path, identity_confidence, title, model,
        created_at, last_updated_at, token_status, parse_error, missing_since,
        source_seen_at, updated_at)
     VALUES ('k1', 'main', '/p/k1/main', 0, 0, 'cli',
             '/work/demo', '/work/demo', '/work/demo', 'high', 'kimi 会话',
             'kimi-code/k3', ?, ?, 'full', null, null, ?, ?)`
  ).run(AT, AT, AT, AT);
  db.prepare(
    `INSERT INTO kimi_token_usage_event
       (session_id, agent, event_ordinal, event_at,
        fresh_input, cache_read_input, cache_creation_input, output)
     VALUES ('k1', 'main', 0, ?, 300, 0, 0, 60)`
  ).run(AT);
  db.prepare(
    `INSERT INTO kimi_token_usage_state
       (id, rule_version, last_rebuilt_at, last_error, source_agent_count,
        indexed_agent_count, token_known_agent_count, token_unknown_agent_count,
        error_agent_count, skipped_unchanged_count, duration_ms, updated_at)
     VALUES (1, 1, ?, null, 1, 1, 1, 0, 0, 0, 5, ?)`
  ).run(AT, AT);
  db.prepare(
    `INSERT INTO agent_user_messages
       (source, source_session_id, source_message_key, project, event_at_utc,
        raw_text, raw_payload_json, cleaned_text, is_human, char_len,
        cleaner_version, parser_version, source_path, source_seen_at,
        ingested_at, updated_at, role)
     VALUES ('kimi', 'k1', 'k1-0', '/work/demo', ?, '问题', '{}', '问题', 1, 2,
             1, 1, '/p/k1/main', ?, ?, ?, 'user')`
  ).run(AT, AT, AT, AT);
}

const SEEDERS: Partial<Record<DashboardSource, (db: Database.Database) => void>> = {
  "claude-code": seedClaude,
  kimi: seedKimi,
};

/** 排行页里每个源对应的 token 收集器。穷尽 Record —— 加源时必须表态。 */
const TOKEN_COLLECTOR_KEYS: Record<DashboardSource, keyof DashboardCollectors> = {
  "claude-code": "listClaudeProjectTokenUsage",
  codex: "listCodexProjectTokenUsage",
  opencode: "listOpencodeProjectTokenUsage",
  kimi: "listKimiProjectTokenUsage",
};

/** 总览页里每个源对应的会话收集器。 */
const SESSION_COLLECTOR_KEYS: Record<DashboardSource, keyof DashboardCollectors> = {
  "claude-code": "listClaude",
  codex: "listCodex",
  opencode: "listOpencode",
  kimi: "listKimi",
};

/**
 * 在真实的 deps 构造外面包一层探针。仍然用 `defaultDashboardCollectors(db)`
 * 造出全部收集器 —— 只是记一笔某个有没有被调到。
 */
function spyOn(
  db: Database.Database,
  key: keyof DashboardCollectors
): { deps: DashboardCollectors; wasCalled: () => boolean } {
  const real = defaultDashboardCollectors(db);
  let called = false;
  const original = real[key] as ((...args: unknown[]) => unknown) | undefined;
  if (!original) throw new Error(`收集器 ${String(key)} 在默认构造里不存在`);
  const deps = {
    ...real,
    [key]: (...args: unknown[]) => {
      called = true;
      return original(...args);
    },
  } as DashboardCollectors;
  return { deps, wasCalled: () => called };
}

describe("逐源覆盖 —— 加了源却只接一个入口函数时必须变红", () => {
  it("DASHBOARD_SOURCES 与本文件的分档一一对应 —— 加源不会被悄悄漏掉", () => {
    for (const source of DASHBOARD_SOURCES) {
      const known = DB_BACKED.includes(source) || !DB_BACKED.includes(source);
      expect(known).toBe(true);
      // 读库的源必须有播种器,否则「有种子就必须出行」这一档形同虚设。
      if (DB_BACKED.includes(source)) expect(SEEDERS[source]).toBeTypeOf("function");
    }
  });

  for (const source of DASHBOARD_SOURCES) {
    const isDbBacked = DB_BACKED.includes(source);

    describe(source, () => {
      if (isDbBacked) {
        it("排行页:播了种子就必须出真实行,且没有 warning 诊断", async () => {
          const db = freshDb();
          SEEDERS[source]!(db);
          const r = await buildWorkTokenRanking(
            { ...DEFAULT_WORK_TOKEN_RANKING_OPTIONS, sources: [source] },
            defaultDashboardCollectors(db),
            NOW
          );
          expect(r.projects.length).toBeGreaterThan(0);
          expect(r.projects[0]!.totalTokens).toBeGreaterThan(0);
          expect(r.diagnostics.filter((d) => d.severity === "warning")).toHaveLength(0);
          db.close();
        });

        it("总览页:播了种子就必须出项目行", async () => {
          const db = freshDb();
          SEEDERS[source]!(db);
          const r = await buildWorkDashboard(
            { ...DEFAULT_WORK_DASHBOARD_OPTIONS, rangeDays: "all", sources: [source] },
            defaultDashboardCollectors(db),
            NOW
          );
          expect(r.projects.length).toBeGreaterThan(0);
          expect(r.totals.sourceCounts[source]).toBeGreaterThan(0);
          db.close();
        });
      }

      it("排行页:请求这个源 → 它的 token 收集器必须被问过", async () => {
        const db = freshDb();
        const { deps, wasCalled } = spyOn(db, TOKEN_COLLECTOR_KEYS[source]);
        await buildWorkTokenRanking(
          { ...DEFAULT_WORK_TOKEN_RANKING_OPTIONS, sources: [source] },
          deps,
          NOW
        );
        expect(wasCalled()).toBe(true);
        db.close();
      });

      it("总览页:请求这个源 → 它的会话收集器必须被问过", async () => {
        const db = freshDb();
        const { deps, wasCalled } = spyOn(db, SESSION_COLLECTOR_KEYS[source]);
        await buildWorkDashboard(
          { ...DEFAULT_WORK_DASHBOARD_OPTIONS, rangeDays: "all", sources: [source] },
          deps,
          NOW
        );
        expect(wasCalled()).toBe(true);
        db.close();
      });
    });
  }

  it("响应下发的 availableSources 覆盖全部注册源 —— 前端下拉据此生成", async () => {
    const db = freshDb();
    const dash = await buildWorkDashboard({}, defaultDashboardCollectors(db), NOW);
    const rank = await buildWorkTokenRanking({}, defaultDashboardCollectors(db), NOW);
    expect([...dash.availableSources].sort()).toEqual([...DASHBOARD_SOURCES].sort());
    expect([...rank.availableSources].sort()).toEqual([...DASHBOARD_SOURCES].sort());
    db.close();
  });

  it("默认源包含全部注册源 —— 前端不传 sources 时拿到的是全集", () => {
    expect([...DEFAULT_WORK_DASHBOARD_OPTIONS.sources].sort()).toEqual(
      [...DASHBOARD_SOURCES].sort()
    );
    expect([...DEFAULT_WORK_TOKEN_RANKING_OPTIONS.sources].sort()).toEqual(
      [...DASHBOARD_SOURCES].sort()
    );
  });
});
