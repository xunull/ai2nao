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
  /**
   * 这场会话进 token 索引了没有。`false` = 只有正文 —— 标题、模型、agent 数、
   * 项目归属都还没有,因为那些字段只有 `kimi_agent_token_usage` 里有。
   * 界面把它们收进「待索引」,不能并进「(未知项目)」:那个词的意思是
   * 「确定没有目录」,不是「还没查出来」(见 CONTEXT.md)。
   */
  tokenIndexed: boolean;
};

/** 「待索引」会话共用的项目键。只是展示用的分桶,从不入库。 */
export const KIMI_PENDING_PROJECT_KEY = "kimi:pending";

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
  -- token 索引**见过**的全部会话,含已标记文件消失的。下面靠它把「文件没了」
  -- 与「还没索引到」分开:前者要继续隐藏(正文表不会因为文件消失而删行,
  -- 不减掉的话死会话会被正文表请回列表),后者要显示。
  known AS (SELECT DISTINCT session_id FROM kimi_agent_token_usage),
  -- 一遍窗口扫出「最早一条真人提问」与两个计数。用相关子查询取 preview 在真库上
  -- 是 128ms(它只按 source 走索引,再逐会话扫到匹配为止),这个形式是 86ms。
  msgs AS (
    SELECT session_id, first_human_text, human_count, total_count, first_at, last_at
    FROM (
      SELECT source_session_id AS session_id,
             cleaned_text      AS first_human_text,
             ROW_NUMBER() OVER (
               PARTITION BY source_session_id
               ORDER BY CASE WHEN is_human = 1 THEN 0 ELSE 1 END, event_at_utc
             ) AS rn,
             SUM(CASE WHEN is_human = 1 THEN 1 ELSE 0 END)
               OVER (PARTITION BY source_session_id) AS human_count,
             COUNT(*) OVER (PARTITION BY source_session_id) AS total_count,
             MIN(event_at_utc) OVER (PARTITION BY source_session_id) AS first_at,
             MAX(event_at_utc) OVER (PARTITION BY source_session_id) AS last_at
      FROM agent_user_messages
      WHERE source = 'kimi'
    )
    WHERE rn = 1
  ),
  -- 主干 = token 索引里还在的 ∪ 索引压根没见过但已经有正文的。
  -- 只认前者的话,token 刷新任务一关,新会话就在这个页面上静默消失
  -- (真库里曾有 17 场是这样)。见 docs/adr/0002-kimi-session-spine.md。
  spine AS (
    SELECT session_id FROM agents
    UNION
    SELECT session_id FROM msgs WHERE session_id NOT IN (SELECT session_id FROM known)
  )
  SELECT s.session_id,
         a.title,
         COALESCE(a.project_key, ?)  AS project_key,
         COALESCE(a.project_path, '') AS project_path,
         COALESCE(a.identity_confidence, 'low') AS identity_confidence,
         a.model,
         COALESCE(a.created_at, m.first_at)      AS created_at,
         COALESCE(a.last_updated_at, m.last_at)  AS last_updated_at,
         COALESCE(a.agent_count, 0)  AS agent_count,
         COALESCE(m.human_count, 0)  AS human_count,
         COALESCE(m.total_count, 0)  AS total_count,
         COALESCE(m.first_human_text, '') AS preview,
         CASE WHEN a.session_id IS NULL THEN 0 ELSE 1 END AS token_indexed
  FROM spine s
  LEFT JOIN agents a ON a.session_id = s.session_id
  LEFT JOIN msgs   m ON m.session_id = s.session_id
  ORDER BY COALESCE(a.last_updated_at, m.last_at) DESC
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
  token_indexed: number;
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

/**
 * token 刷新任务开着没有。
 *
 * 「有正文、没索引」最常见的成因不是滞后,而是 `kimi.tokens.refresh` 压根关着
 * (本仓库所有定时任务都以关闭状态入库,要用户自己开)。真库上曾经有 17 场会话
 * 因此只有正文:正文同步开着、每小时在跑,token 索引停在几周前。
 *
 * 所以诊断要直接说是哪个任务,而不是只报一个数字让人自己猜。
 */
function tokenRefreshEnabled(db: Database.Database): boolean | null {
  try {
    const row = db
      .prepare(`SELECT enabled FROM scheduled_tasks WHERE task_key = 'kimi.tokens.refresh'`)
      .get() as { enabled: number } | undefined;
    return row ? row.enabled === 1 : null; // 没有这一行 = 任务还没注册过
  } catch {
    return null; // 旧库没有这张表 —— 说不出所以然,就别断言
  }
}

export function listKimiDashboardSessions(db: Database.Database): {
  sessions: KimiDashboardSessionRow[];
  diagnostics: KimiSessionsDiagnostic[];
} {
  const diagnostics: KimiSessionsDiagnostic[] = [];
  let raw: RawRow[];
  try {
    raw = db.prepare(LIST_SQL).all(KIMI_PENDING_PROJECT_KEY) as RawRow[];
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
    tokenIndexed: r.token_indexed === 1,
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

  // 主干已经把它们列出来了,所以这条诊断不再是「你看不到 N 场」,而是
  // 「这 N 场缺标题和 token 状态,原因多半是那个任务关着」。
  const pending = sessions.filter((x) => !x.tokenIndexed).length;
  if (pending > 0) {
    const enabled = tokenRefreshEnabled(db);
    diagnostics.push({
      kind: enabled === false ? "kimi-token-refresh-disabled" : "kimi-sessions-pending-index",
      message:
        enabled === false
          ? `${pending} 场会话还没进 token 索引，暂时没有标题与用量 —— 定时任务「kimi token 统计刷新」是关着的，去调度页打开它`
          : `${pending} 场会话还没进 token 索引，暂时没有标题与用量，等下一轮「kimi token 统计刷新」`,
      count: pending,
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

/** 详情页的一条消息。 */
export type KimiSessionMessage = {
  id: number;
  role: "user" | "assistant";
  eventAtUtc: string;
  text: string;
};

/**
 * 一场 kimi 会话的全部正文,按时序。
 *
 * 与 `userMessageList` 不同:那个是时间窗口制且硬过滤 `is_human = 1`,
 * 详情页要的是单场会话里人和 AI 的完整往返。
 *
 * 筛子是 `role = 'assistant' OR is_human = 1`,不是简单的 `is_human = 1`
 * (那会连 AI 正文一起丢掉),也不是全取(那会混进工具噪音)。`role` 与 `is_human`
 * 是两个不同的列:`<bash-input>` / `<bash-stdout>` 这类控制标签结构上是 role='user'
 * 但 is_human=0。真库里有一场会话的全部 2 条消息都是这种噪音,它在列表页显示
 * 「问了 0 次」,详情页也应该是空态 —— 两处口径必须一致。
 *
 * 不分页 —— 真库里最长的一场是 469 条,一次取完远比翻页简单;页面用固定视口
 * 加内部滚动来满足「不许堆出超长纵向页面」的约束,而不是靠少取数据。
 */
export function listKimiSessionMessages(
  db: Database.Database,
  sessionId: string
): KimiSessionMessage[] {
  try {
    return db
      .prepare(
        `SELECT id, role, event_at_utc AS eventAtUtc, cleaned_text AS text
         FROM agent_user_messages
         WHERE source = 'kimi' AND source_session_id = ?
           AND (role = 'assistant' OR is_human = 1)
         ORDER BY event_at_utc ASC, id ASC`
      )
      .all(sessionId) as KimiSessionMessage[];
  } catch {
    // 旧库没有 role 列之类 —— 详情页显示空态,不整页崩掉。
    return [];
  }
}
