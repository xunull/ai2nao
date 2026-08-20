import type Database from "better-sqlite3";
import { bucketExpr } from "./bucket.js";
import {
  MINIMAX_METHOD_CACHE_CREATE,
  MINIMAX_METHOD_CACHE_READ,
} from "../minimaxTokenUsage/types.js";
import type { BucketGranularity, SourceCapabilities, TokenSourceKey } from "./types.js";

/**
 * 每个 token 源一个 adapter。**加第五个源 = 新建一个 adapter + 在 `ADAPTERS` 里注册。**
 *
 * 上一版把「这个源有没有 cache 写入」写成 `querySessionTableBuckets` 里的 SQL 三元
 * (`source === "claude" ? "SUM(cache_creation…)" : "0"`)。那本来就是「能力」概念,
 * 只是表达成了字符串拼接。留着它就等于 capabilities 存两处,两边漂移时没人发现。
 * 现在每个 adapter 自己写完整 SQL,三元消失。
 */

/** 一个源在一个桶里的原子分量。派生量一律不进这里。 */
export type SourceBucketRow = {
  bucket_key: string;
  fresh_input: number;
  cache_read_input: number;
  cache_creation_input: number;
  output: number;
  reasoning_output: number;
  session_count: number;
  full_count: number;
  unknown_count: number;
  error_count: number;
};

/** 一个源在上一个等长窗口里的原子分量。 */
export type SourcePrevWindowRow = {
  fresh_input: number;
  cache_read_input: number;
  cache_creation_input: number;
  output: number;
};

/** 定价用的分量,按 (桶, 模型) 切。 */
export type SourceCostRow = {
  bucket_key: string;
  model: string;
  fresh: number;
  cache_hit: number;
  cache_creation: number;
  output: number;
};

export type TokenSourceAdapter = {
  key: TokenSourceKey;
  capabilities: SourceCapabilities;
  /**
   * 这台机器上有没有这个源。
   *
   * **不能看本次查询结果是不是空** —— 空有四种含义:没装 / 装了但没会话 /
   * 同步还没跑 / 扫描失败留下空表。判据是「这个源在这台机器上存在过吗」。
   */
  probePresence(db: Database.Database): boolean;
  queryBuckets(
    db: Database.Database,
    from: Date,
    to: Date,
    granularity: BucketGranularity
  ): SourceBucketRow[];
  queryPrevWindow(db: Database.Database, from: Date, to: Date): SourcePrevWindowRow;
  /** 该源的自然月范围;没有任何数据时 null。 */
  queryMonthRange(db: Database.Database): { earliest: string; latest: string } | null;
  /** 有价格概念的源才实现。没有的源全部 token 计入 unpriced。 */
  queryCostRows?(
    db: Database.Database,
    from: Date,
    to: Date,
    granularity: BucketGranularity
  ): SourceCostRow[];
};

const ZERO_PREV: SourcePrevWindowRow = {
  fresh_input: 0,
  cache_read_input: 0,
  cache_creation_input: 0,
  output: 0,
};

/**
 * 这个源在这台机器上存在过吗。
 *
 * **析取**:同步状态表有行 **或** 数据表有行。
 * 只看状态表是不够的 —— 数据是从别处导入/恢复的库会没有状态行,
 * 那样会被判成 absent 而整片归零,比旧行为更糟(黄金快照在 T3 抓到过这个)。
 * 只看数据表也不够 —— 同步跑过但这台机器确实没用过这个源时,
 * 「装了没用」与「没装」要分得开。
 */
function everPresent(db: Database.Database, stateTable: string, dataTable: string): boolean {
  // ⚠️ **不吞异常。** migration 会给所有源建表,所以「表不存在 / schema 漂移」
  // 永远意味着**损坏**,不可能是「这台机器没装」。吞掉的话,一张被删的表会被
  // 报成 absent(「你不用 claude」),而真相是 failed(「claude 的表坏了」)——
  // 那正是 1A 要分开的两件事,做反了比不做更糟。
  // 调用方(service)捕获这里抛出的异常并置为 state="failed" + 一条 diagnostic。
  const any = (sql: string) => Boolean(db.prepare(sql).get());
  return (
    any(`SELECT 1 FROM ${stateTable} WHERE id = 1`) || any(`SELECT 1 FROM ${dataTable} LIMIT 1`)
  );
}

function monthRangeOf(
  db: Database.Database,
  sql: string,
  ...params: unknown[]
): { earliest: string; latest: string } | null {
  const row = db.prepare(sql).get(...(params as [])) as {
    earliest: string | null;
    latest: string | null;
  };
  if (!row?.earliest || !row?.latest) return null;
  return { earliest: row.earliest, latest: row.latest };
}

/**
 * session 表的三态计数(按 `last_updated_at` 分桶)。claude 与 codex 共用 ——
 * 这部分两家的列名与语义完全相同,不存在能力差异,所以留作公共函数不算「三元」。
 *
 * **口径**:token 只算 `token_status='full'`,但 session 计数三态都算。
 * 这是 ai2nao「只用真实 token、绝不估算」的约定。
 */
function sessionCounts(
  db: Database.Database,
  table: "claude_session_token_usage" | "codex_session_token_usage",
  from: Date,
  to: Date,
  granularity: BucketGranularity
): Map<string, { session_count: number; full_count: number; unknown_count: number; error_count: number }> {
  const rows = db
    .prepare(
      `SELECT ${bucketExpr(granularity)} AS bucket_key,
              COUNT(*) AS session_count,
              SUM(CASE WHEN token_status = 'full' THEN 1 ELSE 0 END) AS full_count,
              SUM(CASE WHEN token_status = 'unknown' THEN 1 ELSE 0 END) AS unknown_count,
              SUM(CASE WHEN token_status = 'error' THEN 1 ELSE 0 END) AS error_count
         FROM ${table}
        WHERE last_updated_at >= ? AND last_updated_at < ? AND missing_since IS NULL
        GROUP BY bucket_key`
    )
    .all(from.toISOString(), to.toISOString()) as {
    bucket_key: string;
    session_count: number;
    full_count: number;
    unknown_count: number;
    error_count: number;
  }[];
  return new Map(rows.map((r) => [r.bucket_key, r]));
}

/** 把「token 分量(来自 event 表)」与「三态计数(来自 session 表)」并成一行。 */
function mergeTokensAndCounts(
  tokenRows: Omit<SourceBucketRow, "session_count" | "full_count" | "unknown_count" | "error_count">[],
  counts: Map<string, { session_count: number; full_count: number; unknown_count: number; error_count: number }>
): SourceBucketRow[] {
  const byKey = new Map<string, SourceBucketRow>();
  for (const t of tokenRows) {
    byKey.set(t.bucket_key, {
      ...t,
      session_count: 0,
      full_count: 0,
      unknown_count: 0,
      error_count: 0,
    });
  }
  for (const [key, c] of counts) {
    const cur = byKey.get(key);
    if (cur) {
      cur.session_count = c.session_count;
      cur.full_count = c.full_count;
      cur.unknown_count = c.unknown_count;
      cur.error_count = c.error_count;
    } else {
      byKey.set(key, {
        bucket_key: key,
        fresh_input: 0,
        cache_read_input: 0,
        cache_creation_input: 0,
        output: 0,
        reasoning_output: 0,
        ...c,
      });
    }
  }
  return [...byKey.values()].sort((a, b) => a.bucket_key.localeCompare(b.bucket_key));
}

// ── claude ───────────────────────────────────────────────────────────────────

const claudeAdapter: TokenSourceAdapter = {
  key: "claude",
  capabilities: {
    cacheRead: true,
    cacheCreation: true,
    reasoningOutput: false,
    sessionCounts: true,
  },
  probePresence: (db) =>
    everPresent(db, "claude_session_token_usage_state", "claude_session_token_usage"),

  queryBuckets(db, from, to, granularity) {
    // token 分量走 event 表(按 token 实际消耗的那天分桶);三态计数走 session 表。
    // 一个桶可以有 token 而 session_count=0 —— 续接的会话在那天烧了 token,
    // 但最后一次「被碰」是更晚的日子。诚实,不修饰。
    const tokenRows = db
      .prepare(
        `SELECT ${bucketExpr(granularity, "e.event_at")} AS bucket_key,
                COALESCE(SUM(e.input_tokens - e.cache_read_input_tokens
                             - e.cache_creation_input_tokens), 0) AS fresh_input,
                COALESCE(SUM(e.cache_read_input_tokens), 0) AS cache_read_input,
                COALESCE(SUM(e.cache_creation_input_tokens), 0) AS cache_creation_input,
                COALESCE(SUM(e.output_tokens), 0) AS output,
                0 AS reasoning_output
           FROM claude_token_usage_event e
           JOIN claude_session_token_usage s ON s.session_id = e.session_id
          WHERE e.event_at >= ? AND e.event_at < ?
            AND s.missing_since IS NULL AND s.token_status = 'full'
          GROUP BY bucket_key
          ORDER BY bucket_key ASC`
      )
      .all(from.toISOString(), to.toISOString()) as SourceBucketRow[];
    return mergeTokensAndCounts(
      tokenRows,
      sessionCounts(db, "claude_session_token_usage", from, to, granularity)
    );
  },

  queryPrevWindow(db, from, to) {
    // ⚠️ 历史口径:claude 的环比走 **session 表**(按 last_updated_at),
    // 而分桶走 event 表。codex / minimax 的环比走 event 表。
    // 这个不一致是归一之前就有的,本次原样保留 —— 改它会动到已上线的数字,
    // 属于独立的一件事。
    const row = db
      .prepare(
        `SELECT COALESCE(SUM(input_tokens - cache_read_input_tokens
                             - cache_creation_input_tokens), 0) AS fresh_input,
                COALESCE(SUM(cache_read_input_tokens), 0) AS cache_read_input,
                COALESCE(SUM(cache_creation_input_tokens), 0) AS cache_creation_input,
                COALESCE(SUM(output_tokens), 0) AS output
           FROM claude_session_token_usage
          WHERE last_updated_at >= ? AND last_updated_at < ?
            AND missing_since IS NULL AND token_status = 'full'`
      )
      .get(from.toISOString(), to.toISOString()) as SourcePrevWindowRow;
    return row ?? ZERO_PREV;
  },

  queryMonthRange(db) {
    return monthRangeOf(
      db,
      `SELECT MIN(strftime('%Y-%m', last_updated_at, 'localtime')) AS earliest,
              MAX(strftime('%Y-%m', last_updated_at, 'localtime')) AS latest
         FROM claude_session_token_usage
        WHERE missing_since IS NULL`
    );
  },

  queryCostRows(db, from, to, granularity) {
    return db
      .prepare(
        `SELECT ${bucketExpr(granularity, "e.event_at")} AS bucket_key,
                COALESCE(s.model, '') AS model,
                COALESCE(SUM(e.input_tokens - e.cache_read_input_tokens
                             - e.cache_creation_input_tokens), 0) AS fresh,
                COALESCE(SUM(e.cache_read_input_tokens), 0) AS cache_hit,
                COALESCE(SUM(e.cache_creation_input_tokens), 0) AS cache_creation,
                COALESCE(SUM(e.output_tokens), 0) AS output
           FROM claude_token_usage_event e
           JOIN claude_session_token_usage s ON s.session_id = e.session_id
          WHERE e.event_at >= ? AND e.event_at < ?
            AND s.missing_since IS NULL AND s.token_status = 'full'
          GROUP BY bucket_key, model`
      )
      .all(from.toISOString(), to.toISOString()) as SourceCostRow[];
  },
};

// ── codex ────────────────────────────────────────────────────────────────────

const codexAdapter: TokenSourceAdapter = {
  key: "codex",
  capabilities: {
    cacheRead: true,
    // codex 没有 cache 写入这个概念 —— 不是「恒为 0」,是不适用。
    cacheCreation: false,
    reasoningOutput: true,
    sessionCounts: true,
  },
  probePresence: (db) =>
    everPresent(db, "codex_token_usage_state", "codex_session_token_usage"),

  queryBuckets(db, from, to, granularity) {
    const tokenRows = db
      .prepare(
        `SELECT ${bucketExpr(granularity, "e.event_at")} AS bucket_key,
                COALESCE(SUM(e.input_tokens - e.cached_input_tokens), 0) AS fresh_input,
                COALESCE(SUM(e.cached_input_tokens), 0) AS cache_read_input,
                0 AS cache_creation_input,
                COALESCE(SUM(e.output_tokens), 0) AS output,
                COALESCE(SUM(e.reasoning_output_tokens), 0) AS reasoning_output
           FROM codex_token_usage_event e
           JOIN codex_session_token_usage s ON s.session_id = e.session_id
          WHERE e.event_at >= ? AND e.event_at < ?
            AND s.missing_since IS NULL AND s.token_status = 'full'
          GROUP BY bucket_key
          ORDER BY bucket_key ASC`
      )
      .all(from.toISOString(), to.toISOString()) as SourceBucketRow[];
    return mergeTokensAndCounts(
      tokenRows,
      sessionCounts(db, "codex_session_token_usage", from, to, granularity)
    );
  },

  queryPrevWindow(db, from, to) {
    const row = db
      .prepare(
        `SELECT COALESCE(SUM(e.input_tokens - e.cached_input_tokens), 0) AS fresh_input,
                COALESCE(SUM(e.cached_input_tokens), 0) AS cache_read_input,
                0 AS cache_creation_input,
                COALESCE(SUM(e.output_tokens), 0) AS output
           FROM codex_token_usage_event e
           JOIN codex_session_token_usage s ON s.session_id = e.session_id
          WHERE e.event_at >= ? AND e.event_at < ?
            AND s.missing_since IS NULL AND s.token_status = 'full'`
      )
      .get(from.toISOString(), to.toISOString()) as SourcePrevWindowRow;
    return row ?? ZERO_PREV;
  },

  queryMonthRange(db) {
    return monthRangeOf(
      db,
      `SELECT MIN(strftime('%Y-%m', last_updated_at, 'localtime')) AS earliest,
              MAX(strftime('%Y-%m', last_updated_at, 'localtime')) AS latest
         FROM codex_session_token_usage
        WHERE missing_since IS NULL`
    );
  },

  queryCostRows(db, from, to, granularity) {
    return db
      .prepare(
        `SELECT ${bucketExpr(granularity, "e.event_at")} AS bucket_key,
                COALESCE(s.model, '') AS model,
                COALESCE(SUM(e.input_tokens - e.cached_input_tokens), 0) AS fresh,
                COALESCE(SUM(e.cached_input_tokens), 0) AS cache_hit,
                0 AS cache_creation,
                COALESCE(SUM(e.output_tokens), 0) AS output
           FROM codex_token_usage_event e
           JOIN codex_session_token_usage s ON s.session_id = e.session_id
          WHERE e.event_at >= ? AND e.event_at < ?
            AND s.missing_since IS NULL AND s.token_status = 'full'
          GROUP BY bucket_key, model`
      )
      .all(from.toISOString(), to.toISOString()) as SourceCostRow[];
  },
};

// ── minimax ──────────────────────────────────────────────────────────────────

const minimaxAdapter: TokenSourceAdapter = {
  key: "minimax",
  capabilities: {
    cacheRead: true,
    cacheCreation: true,
    reasoningOutput: false,
    // 逐小时账单事件,没有 session 概念 —— 三态计数不适用,不是「恒为 0」。
    sessionCounts: false,
  },
  /**
   * MiniMax 是远程账单源,没有本地同步状态表。
   * ⚠️ 诚实的局限:这里「从没有过事件」与「没配置凭据」区分不开,
   * 两者都会判成 absent。真要分开需要读 provider 凭据配置,那是另一件事。
   */
  probePresence: (db) =>
    Boolean(db.prepare(`SELECT 1 FROM minimax_token_usage_event LIMIT 1`).get()),

  queryBuckets(db, from, to, granularity) {
    return db
      .prepare(
        `SELECT ${bucketExpr(granularity, "event_at")} AS bucket_key,
                COALESCE(SUM(CASE WHEN method NOT IN (?, ?) THEN input_tokens ELSE 0 END), 0) AS fresh_input,
                COALESCE(SUM(CASE WHEN method = ? THEN input_tokens ELSE 0 END), 0) AS cache_read_input,
                COALESCE(SUM(CASE WHEN method = ? THEN input_tokens ELSE 0 END), 0) AS cache_creation_input,
                COALESCE(SUM(output_tokens), 0) AS output,
                0 AS reasoning_output,
                0 AS session_count, 0 AS full_count, 0 AS unknown_count, 0 AS error_count
           FROM minimax_token_usage_event
          WHERE event_at >= ? AND event_at < ?
          GROUP BY bucket_key
          ORDER BY bucket_key ASC`
      )
      .all(
        MINIMAX_METHOD_CACHE_READ,
        MINIMAX_METHOD_CACHE_CREATE,
        MINIMAX_METHOD_CACHE_READ,
        MINIMAX_METHOD_CACHE_CREATE,
        from.toISOString(),
        to.toISOString()
      ) as SourceBucketRow[];
  },

  queryPrevWindow(db, from, to) {
    const row = db
      .prepare(
        `SELECT COALESCE(SUM(CASE WHEN method NOT IN (?, ?) THEN input_tokens ELSE 0 END), 0) AS fresh_input,
                COALESCE(SUM(CASE WHEN method = ? THEN input_tokens ELSE 0 END), 0) AS cache_read_input,
                COALESCE(SUM(CASE WHEN method = ? THEN input_tokens ELSE 0 END), 0) AS cache_creation_input,
                COALESCE(SUM(output_tokens), 0) AS output
           FROM minimax_token_usage_event
          WHERE event_at >= ? AND event_at < ?`
      )
      .get(
        MINIMAX_METHOD_CACHE_READ,
        MINIMAX_METHOD_CACHE_CREATE,
        MINIMAX_METHOD_CACHE_READ,
        MINIMAX_METHOD_CACHE_CREATE,
        from.toISOString(),
        to.toISOString()
      ) as SourcePrevWindowRow;
    return row ?? ZERO_PREV;
  },

  queryMonthRange(db) {
    return monthRangeOf(
      db,
      `SELECT MIN(strftime('%Y-%m', event_at, 'localtime')) AS earliest,
              MAX(strftime('%Y-%m', event_at, 'localtime')) AS latest
         FROM minimax_token_usage_event`
    );
  },
  // 没有 queryCostRows —— MiniMax 的 token 全部计入 unpriced,而不是当成 $0。
};

/** 注册表。**顺序 = 前端柱子的堆叠顺序,也是 `TOKEN_SOURCES` 的顺序。** */
export const ADAPTERS: Record<TokenSourceKey, TokenSourceAdapter> = {
  claude: claudeAdapter,
  codex: codexAdapter,
  minimax: minimaxAdapter,
};
