/**
 * 对话↔提交桥(T1b)读侧:把「一个 commit」与「提交前那段时间你在跟 AI 聊什么」关联起来。
 *
 * 关联口径(启发式,非因果 —— UI 必须如实标注):
 *   对 repo_key=R、project_key=P、author 时刻 T(author_date_utc)的 commit C:
 *     windowFrom = max( prevCommitAuthorTime, T - CAP_HOURS )
 *       - prevCommitAuthorTime = 同一 repo_key、author_date_utc < T 里最大的 author_date_utc
 *         (本仓库上一个提交);没有则视为 -∞(退化为纯 T-CAP)。
 *       - CAP_HOURS 默认 6(常量,可配置)。
 *     matched = agent_user_messages WHERE is_human=1 AND project=P
 *               AND event_at_utc > windowFrom AND event_at_utc <= T
 *               ORDER BY event_at_utc ASC。
 *   即「本仓库上一个提交之后、本提交之前、且回溯不超过 6 小时」这段时间里你发的话。
 *   仅时间+仓库邻近,**不代表因果**。git_commits.project_key 与 agent_user_messages.project
 *   都是 slugFromPath 正向编码(`-abs-path`),两侧直接相等比较,不做有损反解。
 *
 * 字符串比较即时间比较:git_commits.author_date_utc / T-CAP 都是规范 `.toISOString()`
 * (UTC millis 形式),message.event_at_utc 也是规范 ISO-UTC,故 `>` / `<=` 词典序 == 时序。
 */
import type Database from "better-sqlite3";
import type { AgentUserMessageSource } from "../agentUserMessages/types.js";

/** 关联窗口的最大回溯小时数(commit author 时刻往前最多看这么久)。 */
export const CAP_HOURS = 6;

/**
 * 计算某 commit 的关联窗口下界 windowFrom = max(本仓库上一个提交时刻, T - CAP_HOURS),
 * 返回规范 ISO-UTC。listCommits 的 matchedCount 与 commitConversation 共用此逻辑,口径唯一。
 */
export function windowFromFor(
  db: Database.Database,
  repoKey: string,
  authorDateUtc: string
): string {
  // 本仓库 author_date_utc < T 的最大者(上一个提交);无则 null → 退化为纯 CAP。
  const prev = db
    .prepare(
      `SELECT MAX(author_date_utc) AS prev
       FROM git_commits
       WHERE repo_key = @repoKey AND author_date_utc < @t`
    )
    .get({ repoKey, t: authorDateUtc }) as { prev: string | null };

  const capFrom = new Date(
    new Date(authorDateUtc).getTime() - CAP_HOURS * 3600_000
  ).toISOString();

  // 两个下界取较晚者(都是规范 ISO-UTC,词典序即时序)。
  if (prev.prev != null && prev.prev > capFrom) return prev.prev;
  return capFrom;
}

export type CommitListItem = {
  repoKey: string;
  commitHash: string;
  authorDateUtc: string;
  committerDateUtc: string | null;
  subject: string | null;
  added: number;
  deleted: number;
  filesChanged: number;
  projectKey: string | null;
  /** 本 commit 关联窗口内的 is_human 对话条数(逐 commit 精确计,非全局)。 */
  matchedCount: number;
};

export type CommitListCursor = { authorDateUtc: string; commitHash: string };

export type CommitListPage = {
  items: CommitListItem[];
  /** 下一页复合游标 {authorDateUtc, commitHash};已到底为 null。 */
  nextBefore: CommitListCursor | null;
};

/**
 * commit 列表(最新在前、keyset 分页)。mirror userMessageList 的复合游标:
 * author_date_utc **非唯一**(两个提交可能同一秒),故 ORDER BY author_date_utc DESC,
 * commit_hash DESC + 复合下界 (before, beforeHash) 破平,防跳过/重复。
 *
 * matchedCount 只对**本页返回的 commit**逐个算(~30 个小而带索引的 COUNT),不做全局。
 */
export function listCommits(
  db: Database.Database,
  opts: {
    repo?: string;
    before?: string;
    beforeHash?: string;
    limit?: number;
  }
): CommitListPage {
  const limit = Math.min(Math.max(opts.limit ?? 30, 1), 100);
  const filters: string[] = [];
  const params: Record<string, unknown> = { limit };
  if (opts.repo) {
    filters.push("project_key = @repo");
    params.repo = opts.repo;
  }
  if (opts.before != null && opts.beforeHash != null) {
    filters.push(
      "(author_date_utc < @before OR (author_date_utc = @before AND commit_hash < @beforeHash))"
    );
    params.before = opts.before;
    params.beforeHash = opts.beforeHash;
  }
  const whereSql = filters.length ? `WHERE ${filters.join(" AND ")}` : "";

  const rows = db
    .prepare(
      `SELECT repo_key AS repoKey, commit_hash AS commitHash,
              author_date_utc AS authorDateUtc, committer_date_utc AS committerDateUtc,
              subject, added, deleted, files_changed AS filesChanged,
              project_key AS projectKey
       FROM git_commits
       ${whereSql}
       ORDER BY author_date_utc DESC, commit_hash DESC
       LIMIT @limit`
    )
    .all(params) as Omit<CommitListItem, "matchedCount">[];

  const countStmt = db.prepare(
    `SELECT COUNT(*) AS n FROM agent_user_messages
     WHERE is_human = 1 AND project = @project
       AND event_at_utc > @windowFrom AND event_at_utc <= @t`
  );

  const items: CommitListItem[] = rows.map((r) => {
    // project_key 为空的 commit 无从对齐对话 → matchedCount 0(仍返回)。
    let matchedCount = 0;
    if (r.projectKey) {
      const windowFrom = windowFromFor(db, r.repoKey, r.authorDateUtc);
      matchedCount = (
        countStmt.get({
          project: r.projectKey,
          windowFrom,
          t: r.authorDateUtc,
        }) as { n: number }
      ).n;
    }
    return { ...r, matchedCount };
  });

  const last = items[items.length - 1];
  const nextBefore =
    items.length === limit && last != null
      ? { authorDateUtc: last.authorDateUtc, commitHash: last.commitHash }
      : null;
  return { items, nextBefore };
}

export type ConversationMessage = {
  id: number;
  source: AgentUserMessageSource;
  eventAtUtc: string;
  cleanedText: string;
};

export type CommitConversation = {
  commit: {
    repoKey: string;
    commitHash: string;
    authorDateUtc: string;
    committerDateUtc: string | null;
    subject: string | null;
    added: number;
    deleted: number;
    filesChanged: number;
    projectKey: string | null;
  };
  windowFromUtc: string;
  messages: ConversationMessage[];
};

/**
 * 单个 commit 的窗口对话。repo = project_key(前端下拉/列表都用它),hash = commit_hash;
 * project_key = slugFromPath(repo_key) 单射,(project_key, commit_hash) 唯一确定一条 commit。
 * commit 不存在 → null(路由映射 404)。
 */
export function commitConversation(
  db: Database.Database,
  opts: { repo: string; hash: string }
): CommitConversation | null {
  const commit = db
    .prepare(
      `SELECT repo_key AS repoKey, commit_hash AS commitHash,
              author_date_utc AS authorDateUtc, committer_date_utc AS committerDateUtc,
              subject, added, deleted, files_changed AS filesChanged,
              project_key AS projectKey
       FROM git_commits
       WHERE project_key = @repo AND commit_hash = @hash`
    )
    .get({ repo: opts.repo, hash: opts.hash }) as
    | CommitConversation["commit"]
    | undefined;
  if (!commit) return null;

  const windowFromUtc = windowFromFor(db, commit.repoKey, commit.authorDateUtc);
  const messages = commit.projectKey
    ? (db
        .prepare(
          `SELECT id, source, event_at_utc AS eventAtUtc, cleaned_text AS cleanedText
           FROM agent_user_messages
           WHERE is_human = 1 AND project = @project
             AND event_at_utc > @windowFrom AND event_at_utc <= @t
           ORDER BY event_at_utc ASC`
        )
        .all({
          project: commit.projectKey,
          windowFrom: windowFromUtc,
          t: commit.authorDateUtc,
        }) as ConversationMessage[])
    : [];

  return { commit, windowFromUtc, messages };
}

export type CommitCoverage = {
  totalCommits: number;
  /** project_key 在 agent_user_messages(is_human=1)里出现过的仓库的 commit 数(**仓库级**,非逐窗口)。 */
  commitsInReposWithConversation: number;
  /** commitsInReposWithConversation / totalCommits(totalCommits=0 → 0)。 */
  pctReposWithConversation: number;
};

/**
 * 诚实的覆盖率聚合(可选按 repo=project_key 筛)。刻意只做**仓库级**口径:
 * 「这个仓库整体有没有对话」,不是「每个 commit 的窗口里到底有没有对话」——后者会显著更低。
 * UI 必须把它标成仓库级,不得过度声称。
 */
export function commitCoverage(
  db: Database.Database,
  opts?: { repo?: string }
): CommitCoverage {
  const filters: string[] = [];
  const params: Record<string, unknown> = {};
  if (opts?.repo) {
    filters.push("project_key = @repo");
    params.repo = opts.repo;
  }
  const whereSql = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
  const totalCommits = (
    db
      .prepare(`SELECT COUNT(*) AS n FROM git_commits ${whereSql}`)
      .get(params) as { n: number }
  ).n;

  const convFilters = [
    ...filters,
    `project_key IN (
       SELECT DISTINCT project FROM agent_user_messages
       WHERE is_human = 1 AND project IS NOT NULL
     )`,
  ];
  const commitsInReposWithConversation = (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM git_commits WHERE ${convFilters.join(" AND ")}`
      )
      .get(params) as { n: number }
  ).n;

  const pctReposWithConversation =
    totalCommits === 0 ? 0 : commitsInReposWithConversation / totalCommits;
  return { totalCommits, commitsInReposWithConversation, pctReposWithConversation };
}

export type BridgeRepo = {
  projectKey: string;
  /** 友好名:slug 最后一个 `-` 段(见 friendlyRepoName 的取舍)。 */
  displayName: string;
  commitCount: number;
};

/** 仓库下拉数据源:git_commits 里 distinct project_key + 每仓库 commit 数(多在前)。 */
export function listBridgeRepos(db: Database.Database): BridgeRepo[] {
  const rows = db
    .prepare(
      `SELECT project_key AS projectKey, COUNT(*) AS commitCount
       FROM git_commits
       WHERE project_key IS NOT NULL
       GROUP BY project_key
       ORDER BY commitCount DESC, project_key ASC`
    )
    .all() as { projectKey: string; commitCount: number }[];
  return rows.map((r) => ({
    projectKey: r.projectKey,
    displayName: friendlyRepoName(r.projectKey),
    commitCount: r.commitCount,
  }));
}

/**
 * 友好名 = 去前导 `-` 后取最后一个 `-` 段。slug 无损反解不可行(路径分隔符和字面连字符
 * 都变成了 `-`),故连字符命名的目录(如 open-source)会被截断;前端把全 projectKey 挂到
 * title 兜底,信息不丢。
 */
function friendlyRepoName(projectKey: string): string {
  const trimmed = projectKey.replace(/^-+/, "");
  const seg = trimmed.split("-").pop() ?? trimmed;
  return seg || projectKey;
}
