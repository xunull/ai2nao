import type Database from "better-sqlite3";
import {
  KIMI_TOKEN_USAGE_RULE_VERSION,
  type KimiTokenUsageStateRow,
  type KimiTokenUsageStatus,
} from "./types.js";

/**
 * kimi token 索引的新鲜度。与 `getClaudeTokenUsageStatus` 逐行同构。
 *
 * 在此之前 claude / codex / opencode 都有这个函数而 kimi 没有,于是 kimi 的数字
 * 在「从没刷新过」「刷新出错」「解析规则变了」三种情况下都会安静地显示陈旧或 0 ——
 * 另外三家会在页面上给出一条陈旧警告,kimi 什么都不说。V55 建的
 * `kimi_token_usage_state` 一直有这三个字段且 refresh 一直在写,只是没人读。
 */
export function getKimiTokenUsageState(
  db: Database.Database
): KimiTokenUsageStateRow | null {
  return (
    (db
      .prepare(
        `SELECT id, rule_version, last_rebuilt_at, last_error,
                source_agent_count, indexed_agent_count,
                token_known_agent_count, token_unknown_agent_count,
                error_agent_count, skipped_unchanged_count,
                duration_ms, updated_at
         FROM kimi_token_usage_state
         WHERE id = 1`
      )
      .get() as KimiTokenUsageStateRow | undefined) ?? null
  );
}

export function getKimiTokenUsageStatus(
  db: Database.Database
): KimiTokenUsageStatus {
  let state: KimiTokenUsageStateRow | null = null;
  const staleReasons: string[] = [];
  try {
    state = getKimiTokenUsageState(db);
  } catch (e) {
    // 表不在(旧库)不等于「没用过 kimi」,是索引不可用 —— 说出来,别静默当 0。
    staleReasons.push("state_unavailable");
    return { state: null, fresh: false, staleReasons };
  }
  if (!state) staleReasons.push("not_built");
  if (state && state.rule_version !== KIMI_TOKEN_USAGE_RULE_VERSION) {
    staleReasons.push("rule_version_mismatch");
  }
  if (state?.last_error) staleReasons.push("last_refresh_error");
  return { state, fresh: staleReasons.length === 0, staleReasons };
}

/**
 * 按项目聚合 kimi 的 token,供工作看板 / token 排行页合并。
 *
 * 形状对齐 `CodexProjectTokenUsage`,但**计数单位是 agent 文件,不是 session** ——
 * kimi 一个会话下有 N 个 `agents/<x>/wire.jsonl`。字段名沿用 `*Sessions`
 * 是为了跟看板既有的合并逻辑对上,`coverageUnit` 才是真相的载体
 * (见 `src/workTokensTrend/types.ts`)。
 *
 * token 只算 `token_status='full'` 的 agent —— 与 claude/codex 的
 * 「只用真实 token、绝不估算」一致。坏掉的那个 agent 不贡献,
 * 同会话其他 agent 照常计入(X2)。
 */
export type KimiProjectTokenUsage = {
  projectKey: string;
  projectPath: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  /** 单位是 **agent 文件**。 */
  coveredSessions: number;
  totalSessions: number;
  errorSessions: number;
  coverage: "full" | "partial" | "unknown";
};

export function listKimiProjectTokenUsage(
  db: Database.Database,
  args: { projectKeys?: string[]; from?: Date | null }
): Map<string, KimiProjectTokenUsage> {
  const clauses = ["a.missing_since IS NULL"];
  const params: unknown[] = [];
  if (args.from) {
    clauses.push("a.last_updated_at >= ?");
    params.push(args.from.toISOString());
  }
  if (args.projectKeys && args.projectKeys.length > 0) {
    clauses.push(`a.project_key IN (${args.projectKeys.map(() => "?").join(", ")})`);
    params.push(...args.projectKeys);
  }

  let rows: {
    projectKey: string;
    projectPath: string;
    inputTokens: number;
    outputTokens: number;
    coveredSessions: number;
    totalSessions: number;
    errorSessions: number;
  }[];
  try {
    rows = db
      .prepare(
        // token 从事件表来(只取 full 的 agent),计数从 agent 表来。
        // LEFT JOIN 保证「有 agent 行但零事件」的项目也出现在结果里。
        `SELECT a.project_key AS projectKey,
                MIN(a.project_path) AS projectPath,
                COALESCE(SUM(CASE WHEN a.token_status = 'full'
                                  THEN e.fresh_input + e.cache_read_input + e.cache_creation_input
                                  ELSE 0 END), 0) AS inputTokens,
                COALESCE(SUM(CASE WHEN a.token_status = 'full' THEN e.output ELSE 0 END), 0) AS outputTokens,
                COUNT(DISTINCT a.session_id || ' ' || a.agent) AS totalSessions,
                COUNT(DISTINCT CASE WHEN a.token_status = 'full'
                                    THEN a.session_id || ' ' || a.agent END) AS coveredSessions,
                COUNT(DISTINCT CASE WHEN a.token_status = 'error'
                                    THEN a.session_id || ' ' || a.agent END) AS errorSessions
           FROM kimi_agent_token_usage a
           LEFT JOIN kimi_token_usage_event e
             ON e.session_id = a.session_id AND e.agent = a.agent
          WHERE ${clauses.join(" AND ")}
          GROUP BY a.project_key`
      )
      .all(...params) as typeof rows;
  } catch {
    // 表不在(旧库)或 schema 漂移 —— kimi 这一轮不贡献,不拖垮别的源。
    return new Map();
  }

  return new Map(
    rows.map((r) => {
      const coverage: KimiProjectTokenUsage["coverage"] =
        r.coveredSessions === 0
          ? "unknown"
          : r.coveredSessions === r.totalSessions
            ? "full"
            : "partial";
      return [
        r.projectKey,
        {
          projectKey: r.projectKey,
          projectPath: r.projectPath,
          inputTokens: r.inputTokens,
          outputTokens: r.outputTokens,
          totalTokens: r.inputTokens + r.outputTokens,
          coveredSessions: r.coveredSessions,
          totalSessions: r.totalSessions,
          errorSessions: r.errorSessions,
          coverage,
        },
      ];
    })
  );
}
