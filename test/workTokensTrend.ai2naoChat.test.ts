import type Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ADAPTERS } from "../src/workTokensTrend/adapters.js";
import { generateTrend } from "../src/workTokensTrend/service.js";
import {
  buildTokensTrendFixture,
  FIXTURE_NOW,
  FIXTURE_TZ,
} from "./fixtures/tokensTrendFixture.js";

/**
 * 趋势页的第六个源:ai2nao 自己的对话。
 *
 * 这个源与前五个有两处结构性不同,测试也就围着这两处转:
 *
 *   1. **数据不在专用表里**,而是 `llm_chat_messages` 里的服务端专有行 ——
 *      `role='activity'` + `ai2nao:call:` 前缀,用量埋在**两层** JSON 里。
 *   2. **费用由源自己出**,走 `queryPricedRows` 而不是 `queryCostRows`,
 *      框架不得拿当前价格表重算。
 *
 * 两处的失败模式都是**静默的**:少解一层 json 不报错,只是恒得 0;
 * 被框架重算也不报错,只是钱数变了。所以每条断言都挑了能证伪的具体数字。
 */

const adapter = ADAPTERS["ai2nao-chat"];

const PRIOR_TZ = process.env.TZ;
beforeAll(() => {
  process.env.TZ = FIXTURE_TZ;
});
afterAll(() => {
  process.env.TZ = PRIOR_TZ;
});

function withFixture<T>(fn: (db: Database.Database) => T): T {
  const db = buildTokensTrendFixture();
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

/**
 * 捕获 adapter **真正 prepare 的 SQL**,而不是在测试里另抄一份。
 *
 * 仓库里既有的 EXPLAIN 测试都是把 SQL 抄进测试。抄一份的问题是:adapter 改了、
 * 测试里那份不会跟着改,于是计划断言变成「测一段没人在跑的 SQL」——绿着,但没在
 * 守任何东西。这里劫持 `prepare` 取真货。
 */
function capturePreparedSql(db: Database.Database, run: () => void): string[] {
  const seen: string[] = [];
  const orig = db.prepare.bind(db);
  (db as unknown as { prepare: unknown }).prepare = (sql: string) => {
    seen.push(sql);
    return orig(sql);
  };
  try {
    run();
  } finally {
    (db as unknown as { prepare: unknown }).prepare = orig;
  }
  return seen;
}

const AUG = { month: "2026-08", now: FIXTURE_NOW } as const;
const JUN = { month: "2026-06", now: FIXTURE_NOW } as const;

/** 取某个月里本源的汇总。 */
function augSource(db: Database.Database, opts: typeof AUG | typeof JUN) {
  return generateTrend(db, opts).totals.sources["ai2nao-chat"];
}

describe("ai2nao 对话 —— 趋势页 adapter", () => {
  it("probePresence:有账目行才算存在", () => {
    withFixture((db) => {
      expect(adapter.probePresence(db)).toBe(true);
      // 把账目行删光 —— 对话表还在、会话还在,但这个源就该判成不存在。
      // (老库就是这个样子:有对话,一行账目都没有。)
      db.prepare(`DELETE FROM llm_chat_messages WHERE role = 'activity'`).run();
      expect(adapter.probePresence(db)).toBe(false);
    });
  });

  it("两层 json_extract 取到真实用量 —— 少解一层会让整列恒为 0", () => {
    const u = withFixture((db) => augSource(db, AUG));
    // chat-s1 三笔:priced(1200/3000/500/400/150)+unpriced(800/0/0/200/0)+pending(null)
    expect(u.freshInput).toBe(2000);
    expect(u.cacheReadInput).toBe(3000);
    // ⚠️ 账目的 cacheWrite ↔ 这里的 cacheCreationInput,只有这一对名字不同。
    expect(u.cacheCreationInput).toBe(500);
    expect(u.output).toBe(600);
    expect(u.reasoningOutput).toBe(150);
  });

  it("pending 的 usage 为 null 时当 0,不会把整桶变成 null", () => {
    const u = withFixture((db) => augSource(db, AUG));
    // 上一条的数字里已经含着那笔 pending。它没贡献 token,也没把别的抹掉。
    expect(Number.isFinite(u.freshInput)).toBe(true);
    expect(u.freshInput).toBe(2000);
  });

  it("费用原样带出,**不按当前价格表重算**", () => {
    const u = withFixture((db) => augSource(db, AUG));
    // 账目里存的是 0.0123。若框架拿 model_prices 重算同一笔
    // (1200×2e-6 + 3000×2e-7 + 500×2.5e-6 + 400×1e-5)会得到 0.00825 ——
    // 两个数不同,所以这条断言真的能证伪「被重算了」。
    expect(u.costUsd).toBeCloseTo(0.0123, 10);
  });

  it("priced / unpriced 分开计,才推得出 partial", () => {
    const { u, state } = withFixture((db) => {
      const res = generateTrend(db, AUG);
      return { u: res.totals.sources["ai2nao-chat"], state: res.totals.costState["ai2nao-chat"] };
    });
    expect(u.pricedTokens).toBe(5100); // 1200+3000+500+400
    expect(u.unpricedTokens).toBe(1000); // 800+200,pending 那笔是 0
    // 有定价的也有没定价的 → partial。把没定价的当 $0 就会谎报 full。
    expect(state).toBe("partial");
  });

  it("仍在继续用的会话:账目在 6 月、最后活动在 8 月,6 月窗口照样看得见", () => {
    const { u, state } = withFixture((db) => {
      const res = generateTrend(db, JUN);
      return { u: res.totals.sources["ai2nao-chat"], state: res.totals.costState["ai2nao-chat"] };
    });
    // chat-s2 的 last_message_at 是 2026-08-19。第一段过滤若写成
    // `BETWEEN from AND to`,这个会话在 6 月窗口里会被整个滤掉,下面全变 0。
    expect(u.freshInput).toBe(300);
    expect(u.cacheReadInput).toBe(900);
    expect(u.cacheCreationInput).toBe(100);
    expect(u.output).toBe(90);
    expect(u.costUsd).toBeCloseTo(0.004, 10);
    expect(state).toBe("full");
  });

  it("coverageUnit 为 null —— 三态计数对自写账目不适用", () => {
    expect(adapter.capabilities.coverageUnit).toBeNull();
    // 「不适用」不等于「恒为 0」:它根本不该参与 coverage 的分子分母。
    //
    // 汇总单位是 `mixed`,而且**在加这个源之前就是** —— kimi 的分母是 agent 文件数,
    // claude/codex 的是 session,两个单位并存本来就没法相加。这里钉住它,是为了
    // 证明新源没有往这个判断里掺东西:它若误报了 session_count,
    // `unitsPresent` 会多出一项,这条断言就会变。
    const totals = withFixture((db) => generateTrend(db, AUG).totals);
    expect(totals.coverageUnit).toBe("mixed");
  });

  it("两段式查询命中索引,不是全表扫 llm_chat_messages", () => {
    withFixture((db) => {
      const [sql, ...rest] = capturePreparedSql(db, () => {
        adapter.queryBuckets(db, new Date("2026-08-01T00:00:00Z"), FIXTURE_NOW, "day");
      });
      expect(rest).toHaveLength(0); // 一次查询就该只 prepare 一条
      const plan = (
        db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all("a", "a", "b") as { detail: string }[]
      )
        .map((r) => r.detail)
        .join(" | ");

      // 关键的是后半句:只断言「用到了某个索引」的话,一个「先全表扫再用索引」
      // 的计划照样能过。
      expect(plan).not.toMatch(/SCAN llm_chat_messages(?! USING)/);
      expect(plan).toContain("idx_llm_chat_messages_session_role");
    });
  });
});
