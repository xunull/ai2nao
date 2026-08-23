import type Database from "better-sqlite3";
import { existsSync } from "node:fs";
import { opencodeDbPath, resolveOpencodeDataDir } from "../opencodeHistory/paths.js";
import { OPENCODE_TOKEN_RULE_VERSION } from "./events.js";
import type { OpencodeProjectTokenUsage, OpencodeTokenUsageStatus } from "./types.js";

/**
 * 按项目聚合 opencode 的 token —— **从 index.db 读**,不再打开那个 3.2 GB 的外部库。
 *
 * 旧实现读 `opencode.db` 的 `session` 表聚合列,而且 `TOKEN_COLS` 只有
 * `tokens_input`/`tokens_output` —— **不含 cache**。真库实测因此少算 89%:
 * 排行页报 128.1M,实际 1170.4M(cache_read 1042.0M 被整个丢掉)。
 *
 * 而同一张榜上 claude 的 `input_tokens` 是**融合值**(含 cache)、kimi 是三分量
 * 显式相加(也含 cache)—— 三把尺子。逐源口径见下方 SOURCE_TOKEN_FUSION,
 * 有 pin 测试钉着。
 *
 * 数据来自 V57 的逐消息事件表 join V58 的会话表。事件表只有 session_id,
 * 项目在会话表上(`project_key` 已在 ingest 里 canonicalize 好,那要 realpathSync,
 * 进不了 SQL)。
 */
export function listOpencodeProjectTokenUsage(
  db: Database.Database | undefined,
  args: { projectKeys?: string[]; from?: Date | null }
): Map<string, OpencodeProjectTokenUsage> {
  const out = new Map<string, OpencodeProjectTokenUsage>();
  if (!db) return out;

  const clauses = ["s.archived_at IS NULL"];
  const params: unknown[] = [];
  if (args.from) {
    clauses.push("e.event_at >= ?");
    params.push(args.from.toISOString());
  }
  if (args.projectKeys && args.projectKeys.length > 0) {
    clauses.push(`s.project_key IN (${args.projectKeys.map(() => "?").join(",")})`);
    params.push(...args.projectKeys);
  }

  let rows: Array<{
    projectKey: string;
    projectPath: string;
    inputTokens: number;
    outputTokens: number;
    totalSessions: number;
  }>;
  try {
    rows = db
      .prepare(
        `SELECT s.project_key AS projectKey,
                MAX(s.project_path) AS projectPath,
                -- 输入 = 三个原子分量之和。旧实现漏掉 cache 两项,少算 89%。
                COALESCE(SUM(e.fresh_input + e.cache_read_input + e.cache_creation_input), 0) AS inputTokens,
                COALESCE(SUM(e.output), 0) AS outputTokens,
                COUNT(DISTINCT s.session_id) AS totalSessions
         FROM opencode_token_usage_event e
         JOIN opencode_session s ON s.session_id = e.session_id
         WHERE ${clauses.join(" AND ")}
         GROUP BY s.project_key`
      )
      .all(...params) as typeof rows;
  } catch {
    return out; // 表不在(旧库) → 空。诊断走 getOpencodeTokenUsageStatus。
  }

  for (const row of rows) {
    if (!row.projectKey) continue;
    out.set(row.projectKey, {
      projectKey: row.projectKey,
      projectPath: row.projectPath || row.projectKey,
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
      totalTokens: row.inputTokens + row.outputTokens,
      // 事件表里的每条都是实测量,没有「解析失败」这一档 —— opencode 的 token
      // 由它自己算好写在 message.data 里,我们只是搬运。
      coveredSessions: row.totalSessions,
      totalSessions: row.totalSessions,
      errorSessions: 0,
      coverage: "full",
    });
  }
  return out;
}

/**
 * 每个源把 cache 算进 `inputTokens` 的口径。**这张表是 pin 测试的对象** ——
 * P5 的根因就是「三种做法、没有一处写下来」。
 */
export const SOURCE_TOKEN_FUSION = {
  /** `claude_session_token_usage.input_tokens` 本身就是 fresh+cache_read+cache_creation。 */
  "claude-code": "fused-column",
  /** 同上,另有 cached_input_tokens 作诊断列。 */
  codex: "fused-column",
  /** 事件表存原子分量,查询侧显式相加。 */
  kimi: "summed-in-query",
  /** 同 kimi —— V57 起。此前是 `tokens_input` 单列,少算 89%。 */
  opencode: "summed-in-query",
} as const;

/**
 * opencode token 索引的新鲜度。**读 index.db 的 state 表**,与另外三家同形。
 *
 * 旧实现探测 `opencode.db` 的 `session` 表有没有 token 列 —— 那是在问
 * 「数据源支不支持」,而现在真正决定页面数字的是「我们的索引跑没跑过」。
 *
 * 没有 state 行 ≠ 没用过 opencode:ingest 跑过一次就会写。所以 not_built
 * 是「索引没建」,由调用方决定要不要提示 —— 与 kimi 同一套。
 */
export function getOpencodeTokenUsageStatus(
  db: Database.Database | undefined,
  rawDataDir?: string
): OpencodeTokenUsageStatus {
  // 没有 opencode.db = 这台机器不用 opencode。那是**缺席**,不是陈旧 ——
  // 报 fresh 让看板别弹警告。这条语义是旧实现就有的,改数据源时差点弄丢:
  // 新的 state 表对「从没用过」的人也是空的,不加这一层会把「没有」
  // 误报成「索引坏了」。
  if (!existsSync(opencodeDbPath(resolveOpencodeDataDir(rawDataDir)))) {
    return { fresh: true, staleReasons: [] };
  }
  if (!db) return { fresh: false, staleReasons: ["index db unavailable"] };
  try {
    const row = db
      .prepare(
        `SELECT rule_version AS ruleVersion, last_error AS lastError
         FROM opencode_token_usage_state WHERE id = 1`
      )
      .get() as { ruleVersion: number; lastError: string | null } | undefined;
    const staleReasons: string[] = [];
    if (!row) staleReasons.push("not_built");
    if (row && row.ruleVersion !== OPENCODE_TOKEN_RULE_VERSION) {
      staleReasons.push("rule_version_mismatch");
    }
    if (row?.lastError) staleReasons.push("last_refresh_error");
    return { fresh: staleReasons.length === 0, staleReasons };
  } catch (e) {
    // 表不在(旧库)= 索引不可用,不是「没用过 opencode」。说出来,别静默当 fresh。
    return { fresh: false, staleReasons: [e instanceof Error ? e.message : String(e)] };
  }
}
