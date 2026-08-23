import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { migrate } from "../src/store/migrations.js";
import {
  getOpencodeTokenUsageStatus,
  listOpencodeProjectTokenUsage,
  SOURCE_TOKEN_FUSION,
} from "../src/opencodeTokenUsage/queries.js";
import { OPENCODE_TOKEN_RULE_VERSION } from "../src/opencodeTokenUsage/events.js";

/**
 * opencode 的 token 聚合改读 index.db（O5）。
 *
 * 旧实现读 `opencode.db` 的 `session` 表聚合列，而 `TOKEN_COLS` 只有
 * `tokens_input`/`tokens_output` —— **不含 cache**。真库实测因此少算 89%：
 * 排行页报 128.1M，实际 1170.4M（`cache_read` 1042.0M 被整个丢掉）。
 *
 * 而同一张榜上 claude 的 `input_tokens` 是**融合值**（本身含 cache）、
 * kimi 是三分量显式相加 —— 三把尺子量同一个东西。根因不是「列名写少了」，
 * 是**没有一处地方写下每个源的融合口径**。所以下面有一条 pin 测试钉着它。
 */

const T0 = "2026-05-01T00:00:00.000Z";

/**
 * 造一个含 opencode.db 的临时目录。
 *
 * status 的用例**必须**传它。不传的话 `resolveOpencodeDataDir(undefined)` 会解析到
 * 真实的 `~/.local/share/opencode` —— 在装了 opencode 的开发机上恰好存在,于是测试
 * 「绿」得莫名其妙;换一台没装的机器(或 CI)就会全部走进「absent → fresh」而红。
 * 这是隐式环境依赖,`src/config.ts:53` 的注释记着同一个教训。
 */
function dirWithOpencodeDb(): string {
  const dir = mkdtempSync(join(tmpdir(), "ai2nao-oc-src-"));
  const src = new Database(join(dir, "opencode.db"));
  src.exec("CREATE TABLE session (id TEXT PRIMARY KEY);");
  src.close();
  return dir;
}

function freshDb(): Database.Database {
  const db = new Database(join(mkdtempSync(join(tmpdir(), "ai2nao-oc-idx-")), "t.db"));
  migrate(db);
  return db;
}

function seedSession(
  db: Database.Database,
  o: { id: string; projectKey: string; archived?: boolean; updatedAt?: string }
): void {
  db.prepare(
    `INSERT INTO opencode_session
       (session_id, directory, project_key, project_path, title, created_at,
        last_updated_at, archived_at, human_message_count, total_message_count, updated_at)
     VALUES (?, ?, ?, ?, '会话', ?, ?, ?, 0, 0, ?)`
  ).run(
    o.id,
    o.projectKey,
    o.projectKey,
    o.projectKey,
    T0,
    o.updatedAt ?? T0,
    o.archived ? T0 : null,
    T0
  );
}

function seedEvent(
  db: Database.Database,
  o: {
    session: string;
    message: string;
    at?: string;
    fresh?: number;
    read?: number;
    write?: number;
    output?: number;
    reasoning?: number;
  }
): void {
  db.prepare(
    `INSERT INTO opencode_token_usage_event
       (session_id, message_id, event_at, fresh_input, cache_read_input,
        cache_creation_input, output, reasoning_output)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    o.session,
    o.message,
    o.at ?? T0,
    o.fresh ?? 0,
    o.read ?? 0,
    o.write ?? 0,
    o.output ?? 0,
    o.reasoning ?? 0
  );
}

describe("listOpencodeProjectTokenUsage —— 读 index.db", () => {
  it("输入是三个原子分量之和 —— 旧实现漏掉 cache 两项，少算 89%", () => {
    const db = freshDb();
    seedSession(db, { id: "s1", projectKey: "/work/app" });
    seedEvent(db, { session: "s1", message: "m1", fresh: 100, read: 900, write: 143, output: 20 });

    const r = listOpencodeProjectTokenUsage(db, {}).get("/work/app")!;
    // 旧口径只会给出 100 + 20 = 120。
    expect(r.inputTokens).toBe(1143);
    expect(r.outputTokens).toBe(20);
    expect(r.totalTokens).toBe(1163);
    db.close();
  });

  it("同项目多会话多事件合并", () => {
    const db = freshDb();
    seedSession(db, { id: "s1", projectKey: "/work/app" });
    seedSession(db, { id: "s2", projectKey: "/work/app" });
    seedSession(db, { id: "s3", projectKey: "/work/other" });
    seedEvent(db, { session: "s1", message: "m1", fresh: 100, output: 10 });
    seedEvent(db, { session: "s1", message: "m2", fresh: 200, output: 20 });
    seedEvent(db, { session: "s2", message: "m3", fresh: 300, output: 30 });
    seedEvent(db, { session: "s3", message: "m4", fresh: 999, output: 99 });

    const m = listOpencodeProjectTokenUsage(db, {});
    expect(m.get("/work/app")!.totalTokens).toBe(660);
    expect(m.get("/work/app")!.totalSessions).toBe(2);
    expect(m.get("/work/other")!.totalTokens).toBe(1098);
    db.close();
  });

  it("已归档的会话整个排除 —— 与 opencode 自己的列表口径一致", () => {
    const db = freshDb();
    seedSession(db, { id: "live", projectKey: "/work/app" });
    seedSession(db, { id: "gone", projectKey: "/work/app", archived: true });
    seedEvent(db, { session: "live", message: "m1", fresh: 100, output: 10 });
    seedEvent(db, { session: "gone", message: "m2", fresh: 999, output: 99 });

    const r = listOpencodeProjectTokenUsage(db, {}).get("/work/app")!;
    expect(r.totalTokens).toBe(110);
    expect(r.totalSessions).toBe(1);
    db.close();
  });

  it("projectKeys 过滤与 from 时间过滤都生效", () => {
    const db = freshDb();
    seedSession(db, { id: "s1", projectKey: "/work/app" });
    seedSession(db, { id: "s2", projectKey: "/work/other" });
    seedEvent(db, { session: "s1", message: "m1", at: "2026-05-01T00:00:00.000Z", fresh: 100, output: 10 });
    seedEvent(db, { session: "s1", message: "m2", at: "2026-01-01T00:00:00.000Z", fresh: 999, output: 99 });
    seedEvent(db, { session: "s2", message: "m3", fresh: 500, output: 50 });

    expect([...listOpencodeProjectTokenUsage(db, { projectKeys: ["/work/app"] }).keys()]).toEqual([
      "/work/app",
    ]);
    const recent = listOpencodeProjectTokenUsage(db, {
      projectKeys: ["/work/app"],
      from: new Date("2026-04-01T00:00:00.000Z"),
    }).get("/work/app")!;
    expect(recent.totalTokens).toBe(110); // 一月那条被时间过滤掉
    db.close();
  });

  it("没有事件的会话不出现（JOIN 而非 LEFT JOIN —— 没量就不该占榜位）", () => {
    const db = freshDb();
    seedSession(db, { id: "empty", projectKey: "/work/quiet" });
    expect(listOpencodeProjectTokenUsage(db, {}).size).toBe(0);
    db.close();
  });

  it("表不在（旧库）→ 空 Map，不抛 —— 不能拖垮别的源", () => {
    const db = freshDb();
    db.exec("DROP TABLE opencode_token_usage_event");
    expect(() => listOpencodeProjectTokenUsage(db, {})).not.toThrow();
    expect(listOpencodeProjectTokenUsage(db, {}).size).toBe(0);
    db.close();
  });

  it("没有 db → 空 Map", () => {
    expect(listOpencodeProjectTokenUsage(undefined, {}).size).toBe(0);
  });
});

describe("getOpencodeTokenUsageStatus", () => {
  // 每条都传 dataDir —— 见 dirWithOpencodeDb 的注释。
  const DIR = dirWithOpencodeDb();

  function setState(db: Database.Database, ruleVersion: number, lastError: string | null): void {
    db.prepare(
      `INSERT INTO opencode_token_usage_state
         (id, rule_version, last_rebuilt_at, last_error, source_message_count,
          indexed_event_count, duration_ms, updated_at)
       VALUES (1, ?, ?, ?, 0, 0, 1, ?)`
    ).run(ruleVersion, T0, lastError, T0);
  }

  it("state 表空 → not_built", () => {
    const db = freshDb();
    expect(getOpencodeTokenUsageStatus(db, DIR)).toEqual({ fresh: false, staleReasons: ["not_built"] });
    db.close();
  });

  it("规则版本不符 → rule_version_mismatch", () => {
    const db = freshDb();
    setState(db, OPENCODE_TOKEN_RULE_VERSION + 1, null);
    expect(getOpencodeTokenUsageStatus(db, DIR).staleReasons).toContain("rule_version_mismatch");
    db.close();
  });

  it("上次刷新报错 → last_refresh_error", () => {
    const db = freshDb();
    setState(db, OPENCODE_TOKEN_RULE_VERSION, "读不了 opencode.db");
    expect(getOpencodeTokenUsageStatus(db, DIR).staleReasons).toContain("last_refresh_error");
    db.close();
  });

  it("一切正常 → fresh", () => {
    const db = freshDb();
    setState(db, OPENCODE_TOKEN_RULE_VERSION, null);
    expect(getOpencodeTokenUsageStatus(db, DIR)).toEqual({ fresh: true, staleReasons: [] });
    db.close();
  });

  it("表被删 → 报出来，不静默当 fresh", () => {
    const db = freshDb();
    db.exec("DROP TABLE opencode_token_usage_state");
    const st = getOpencodeTokenUsageStatus(db, DIR);
    expect(st.fresh).toBe(false);
    expect(st.staleReasons[0]).toContain("opencode_token_usage_state");
    db.close();
  });
});

describe("逐源 token 融合口径（pin）", () => {
  /**
   * P5 的根因是「三种做法、没有一处写下来」。这条 pin 测试就是那「一处」——
   * 改任何一个源的融合口径都必须先改这里，改这里就会看到这段说明。
   *
   * `fused-column`   源自己给的列已经含 cache，查询侧**不能**再加。
   * `summed-in-query` 源给的是分离分量，查询侧**必须**显式相加。
   * 搞反任何一个方向：前者双倍虚高，后者少算约 89%（opencode 就是后者，
   * 真库 128.1M vs 1170.4M）。
   */
  it("四个源的口径与实现一致", () => {
    expect(SOURCE_TOKEN_FUSION).toEqual({
      "claude-code": "fused-column",
      codex: "fused-column",
      kimi: "summed-in-query",
      opencode: "summed-in-query",
    });
  });

  it("opencode 是 summed-in-query —— 查询里必须出现三分量相加", () => {
    const db = freshDb();
    seedSession(db, { id: "s1", projectKey: "/work/app" });
    // 只有 cache，没有 fresh。fused 口径会算成 0，summed 口径算成 1042。
    seedEvent(db, { session: "s1", message: "m1", fresh: 0, read: 1042, write: 0, output: 0 });
    expect(listOpencodeProjectTokenUsage(db, {}).get("/work/app")!.inputTokens).toBe(1042);
    db.close();
  });
});

describe("absent ≠ stale", () => {
  /**
   * 从旧测试承接的一条**语义**（不是实现细节）：没有 `opencode.db` 意味着
   * 这台机器不用 opencode，那是缺席不是陈旧，看板不该弹警告。
   *
   * 改数据源时差点弄丢：新的 state 表对「从没用过 opencode」的人同样是空的，
   * 不单独判一下就会把「没有」误报成「索引坏了」。
   */
  it("没有 opencode.db → fresh，不弹警告", () => {
    const db = freshDb();
    const emptyDir = mkdtempSync(join(tmpdir(), "ai2nao-no-oc-"));
    expect(getOpencodeTokenUsageStatus(db, emptyDir)).toEqual({ fresh: true, staleReasons: [] });
    db.close();
  });
});
