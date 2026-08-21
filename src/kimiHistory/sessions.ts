import type Database from "better-sqlite3";

/**
 * kimi 的会话列表 —— 供工作看板的项目行、以及 `/kimi-history` 两个页面。
 *
 * 数据来自两张表的 JOIN,不新建第三张表:
 *
 * ```
 *   kimi_agent_token_usage      有 title / project_* / 时间戳 / token 状态
 *     (session_id, agent)       ✗ 没有消息条数,没有 preview
 *          │  GROUP BY session_id
 *          ▼
 *   agent_user_messages         有 cleaned_text / role / event_at_utc
 *     source='kimi'             ✗ 没有 title,没有 token 状态
 * ```
 *
 * **粒度**是这里最容易错的地方。token 表是 `(session_id, agent)` 粒度 ——
 * 一个会话最多有 12 个 `agents/<x>/wire.jsonl`。用 `SELECT DISTINCT session_id,
 * title, ...` 取列表在真库上会返回 62 行而不是 31:各 agent 的 title 恰好一致,
 * 但 `last_updated_at` 在 7 个会话里不同,DISTINCT 于是按 agent 展开。所以这里
 * 一律 `GROUP BY session_id` 并对每个投影列显式写冲突规则。
 *
 * **计数单位**:`messageCount` 数的是**真人提问**(`is_human=1`)。该字段在另外
 * 三家那里已经是三种含义(claude 是 JSONL 行数、opencode 列表页写死 0、opencode
 * 详情页是真实条数),没有现成口径可对齐;取真人提问是因为它含义稳定且用户读得懂
 * ——「我在这场里问了几次」。真库现状:2493 行 kimi 消息里只有 193 条是真人提问,
 * 其余 92% 是 AI 正文。
 */

/** 一行 = 一个 kimi 会话(已按 session_id 聚合)。 */
export type KimiDashboardSessionRow = {
  sessionId: string;
  title: string | null;
  projectKey: string;
  projectPath: string;
  identityConfidence: "high" | "low";
  model: string | null;
  createdAt: string;
  lastUpdatedAt: string;
  /** 这个会话下有几个 agent 文件(已排除 missing_since 的)。 */
  agentCount: number;
  /** 真人提问条数。天然可以是 0 —— 真库里就有这样的会话。 */
  humanMessageCount: number;
  /** 含 AI 正文在内的全部消息条数。用于分辨「零提问」与「正文没入库」。 */
  totalMessageCount: number;
  preview: string;
};

export type KimiSessionsDiagnostic = {
  kind: string;
  message: string;
  count?: number;
};

const LIST_SQL = `
  WITH agents AS (
    SELECT session_id,
           MAX(title)               AS title,
           MAX(project_key)         AS project_key,
           MAX(project_path)        AS project_path,
           MAX(identity_confidence) AS identity_confidence,
           MAX(model)               AS model,
           MIN(created_at)          AS created_at,
           MAX(last_updated_at)     AS last_updated_at,
           COUNT(*)                 AS agent_count
    FROM kimi_agent_token_usage
    WHERE missing_since IS NULL
    GROUP BY session_id
  ),
  -- 一遍窗口扫出「最早一条真人提问」与两个计数。用相关子查询取 preview 在真库上
  -- 是 128ms(它只按 source 走索引,再逐会话扫到匹配为止),这个形式是 86ms。
  msgs AS (
    SELECT session_id, first_human_text, human_count, total_count
    FROM (
      SELECT source_session_id AS session_id,
             cleaned_text      AS first_human_text,
             ROW_NUMBER() OVER (
               PARTITION BY source_session_id
               ORDER BY CASE WHEN is_human = 1 THEN 0 ELSE 1 END, event_at_utc
             ) AS rn,
             SUM(CASE WHEN is_human = 1 THEN 1 ELSE 0 END)
               OVER (PARTITION BY source_session_id) AS human_count,
             COUNT(*) OVER (PARTITION BY source_session_id) AS total_count
      FROM agent_user_messages
      WHERE source = 'kimi'
    )
    WHERE rn = 1
  )
  SELECT a.session_id, a.title, a.project_key, a.project_path,
         a.identity_confidence, a.model, a.created_at, a.last_updated_at,
         a.agent_count,
         COALESCE(m.human_count, 0)  AS human_count,
         COALESCE(m.total_count, 0)  AS total_count,
         COALESCE(m.first_human_text, '') AS preview
  FROM agents a
  LEFT JOIN msgs m ON m.session_id = a.session_id
  ORDER BY a.last_updated_at DESC
`;

type RawRow = {
  session_id: string;
  title: string | null;
  project_key: string;
  project_path: string;
  identity_confidence: string;
  model: string | null;
  created_at: string | null;
  last_updated_at: string;
  agent_count: number;
  human_count: number;
  total_count: number;
  preview: string;
};

/**
 * 正文侧同步的状态。分辨三件不同的事,否则「没有正文」这一条诊断会把
 * 「还没跑过」「跑失败了」「真的没有」混成一句话。
 */
function messageIngestState(db: Database.Database): {
  kind: "never_run" | "failed" | "ok" | "unknown";
  detail: string;
} {
  try {
    const row = db
      .prepare(
        `SELECT last_status, last_error, last_run_at
         FROM agent_user_messages_sync_state WHERE source = 'kimi'`
      )
      .get() as
      | { last_status: string | null; last_error: string | null; last_run_at: string | null }
      | undefined;
    if (!row) return { kind: "never_run", detail: "kimi 正文同步从未运行" };
    if (row.last_error) return { kind: "failed", detail: `上次同步报错: ${row.last_error}` };
    if (row.last_status && row.last_status !== "success") {
      return { kind: "failed", detail: `上次同步状态为 ${row.last_status}` };
    }
    return { kind: "ok", detail: `上次同步 ${row.last_run_at ?? "时间未知"}` };
  } catch {
    // 旧库没有这张表 —— 说不出所以然,但不能假装同步过了。
    return { kind: "unknown", detail: "同步状态表不可用" };
  }
}

export function listKimiDashboardSessions(db: Database.Database): {
  sessions: KimiDashboardSessionRow[];
  diagnostics: KimiSessionsDiagnostic[];
} {
  const diagnostics: KimiSessionsDiagnostic[] = [];
  let raw: RawRow[];
  try {
    raw = db.prepare(LIST_SQL).all() as RawRow[];
  } catch (e) {
    // 表不在(旧库)= 索引损坏,不是「没用过 kimi」。别静默返回空。
    return {
      sessions: [],
      diagnostics: [
        {
          kind: "kimi-sessions-unavailable",
          message: e instanceof Error ? e.message : String(e),
        },
      ],
    };
  }

  const sessions: KimiDashboardSessionRow[] = raw.map((r) => ({
    sessionId: r.session_id,
    title: r.title,
    projectKey: r.project_key,
    projectPath: r.project_path,
    identityConfidence: r.identity_confidence === "low" ? "low" : "high",
    model: r.model,
    createdAt: r.created_at ?? r.last_updated_at,
    lastUpdatedAt: r.last_updated_at,
    agentCount: r.agent_count,
    humanMessageCount: r.human_count,
    totalMessageCount: r.total_count,
    preview: r.preview,
  }));

  // 判据用「一条消息都没有」而不是「没有真人提问」—— 一个会话完全可以只有 AI 正文
  // 而没有真人提问(真库里就有一个),那是真实情况,不是入库缺失。
  const withoutBodies = sessions.filter((s) => s.totalMessageCount === 0);
  if (withoutBodies.length > 0) {
    const state = messageIngestState(db);
    diagnostics.push({
      kind:
        state.kind === "never_run"
          ? "kimi-messages-not-ingested"
          : state.kind === "failed"
            ? "kimi-messages-sync-failed"
            : "kimi-messages-missing",
      message:
        state.kind === "ok"
          ? `${withoutBodies.length} 个 kimi 会话在 token 索引里有,但正文一条都没有(${state.detail})`
          : `${withoutBodies.length} 个 kimi 会话缺正文 —— ${state.detail}`,
      count: withoutBodies.length,
    });
  }

  return { sessions, diagnostics };
}

/** 单场会话的元信息,供详情页在正文之外显示标题/项目/agent 数。 */
export function getKimiDashboardSession(
  db: Database.Database,
  sessionId: string
): KimiDashboardSessionRow | null {
  const { sessions } = listKimiDashboardSessions(db);
  return sessions.find((s) => s.sessionId === sessionId) ?? null;
}
