/**
 * 项目活动日历(/project-calendar)的读侧。
 *
 * 命题:「那一天,哪些项目在动」——判断依据是**有没有 AI 编码对话**归属于该项目。
 * 提交是富化信息,不参与「活跃项目」的判定。
 *
 *   agent_user_messages (is_human=1)          git_commits
 *   ┌──────────────────────────┐              ┌──────────────────────┐
 *   │ project / source / 逐条时间 │              │ project_key / 作者时间 │
 *   └────────────┬─────────────┘              └───────────┬──────────┘
 *                │  每表各查一次(不 N+1)                    │
 *                ▼                                        ▼
 *          按 canonicalProject 归属 ──────────────────────┘
 *                │
 *      ┌─────────┴──────────┐
 *      ▼                    ▼
 *  有对话的项目          只有提交、没对话的项目
 *  → 主列表             → 底部折叠区
 *  → 日历格子色阶        → 日历格子上的小点(不参与色阶)
 *
 * **格子上的数字恒等于主列表的行数** —— 两者同源,不允许出现不一致。
 *
 * 分桶:一律走 bucketExpr("day", col)(src/timeWindow/bucket.ts),即
 * `strftime('%Y-%m-%d', col, 'localtime')`。WHERE 与 GROUP BY 用**同一个表达式**,
 * 所以时区边界上不可能错位;代价是全表扫(实测月查询 aum 6.8ms + commits 0.7ms)。
 * 数据量涨到六位数再回来优化(届时的正确写法是 UTC 范围左右各放宽一天,再在 app 层按本地日过滤)。
 *
 * 时区契约:SQL 的 localtime 取 **serve 进程**时区,浏览器时区可能不同(局域网访问)。
 * 因此响应显式带 serverToday,前端的「今天」以它为准,不用 new Date()。
 */
import type Database from "better-sqlite3";
import { bucketExpr } from "../timeWindow/bucket.js";
import {
  buildRepoSlugMap,
  canonicalProject,
  displayName,
  type RepoSlugMap,
} from "./projectRollup.js";

/** 卡片上「当天第一句人话」的服务端截断长度(一天最多 15 个项目,别把 payload 撑大)。 */
const FIRST_TEXT_MAX = 120;

const DAY_AUM = bucketExpr("day", "event_at_utc");
const DAY_COMMIT = bucketExpr("day", "author_date_utc");

// ---------------------------------------------------------------- 入参校验

/** 非法入参一律抛错(路由层转 400)。脏输入安静返回空 = 伪装成「那天没活动」。 */
export class InvalidParam extends Error {}

/** `YYYY-MM-DD`,且必须是真实存在的日期(排除 2026-02-30 这类格式合法但不存在的)。 */
export function assertLocalDay(dateStr: unknown): string {
  if (typeof dateStr !== "string") throw new InvalidParam("date is required");
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
  if (!m) throw new InvalidParam(`invalid date: ${dateStr} (want YYYY-MM-DD)`);
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  // 本地构造后回读:2026-02-30 会滚到 3 月,round-trip 对不上 → 拒绝。
  const probe = new Date(y, mo - 1, d);
  if (
    probe.getFullYear() !== y ||
    probe.getMonth() !== mo - 1 ||
    probe.getDate() !== d
  ) {
    throw new InvalidParam(`date does not exist: ${dateStr}`);
  }
  return dateStr;
}

export function assertYearMonth(
  year: unknown,
  month: unknown,
): {
  year: number;
  month: number;
} {
  const y = Number(year);
  const mo = Number(month);
  if (!Number.isInteger(y) || y < 1970 || y > 9999) {
    throw new InvalidParam(`invalid year: ${String(year)}`);
  }
  if (!Number.isInteger(mo) || mo < 1 || mo > 12) {
    throw new InvalidParam(`invalid month: ${String(month)}`);
  }
  return { year: y, month: mo };
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** serve 进程本地时区的今天。前端的「今天」以此为准。 */
export function localToday(now: Date = new Date()): string {
  return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
}

/** 某个本地月的 [首日, 下月首日) —— 都是 YYYY-MM-DD 字符串,词典序即时序。 */
function monthDayRange(
  year: number,
  month: number,
): { from: string; to: string } {
  const from = `${year}-${pad2(month)}-01`;
  const to =
    month === 12 ? `${year + 1}-01-01` : `${year}-${pad2(month + 1)}-01`;
  return { from, to };
}

// ---------------------------------------------------------------- 月视图

export type MonthDay = {
  day: string;
  /** 当天有对话的**项目数** —— 日历格子五档色阶用这个。 */
  projectCount: number;
  messageCount: number;
  /** 当天全部提交数(含只提交没对话的项目)。 */
  commitCount: number;
  /** 当天「有提交但没对话」的项目数 —— 格子上的小点用这个,不参与色阶。 */
  commitOnlyProjectCount: number;
};

export type MonthActivity = {
  year: number;
  month: number;
  /** 只含有活动的天(有对话或有提交),升序。 */
  days: MonthDay[];
  /** serve 进程本地时区的今天。 */
  serverToday: string;
  /** 对话数据最早的本地日;早于它的月份只有提交记录。无对话数据时 null。 */
  dataStartDay: string | null;
};

export function monthActivity(
  db: Database.Database,
  yearRaw: unknown,
  monthRaw: unknown,
  opts: { now?: Date; repoSlugs?: RepoSlugMap } = {},
): MonthActivity {
  const { year, month } = assertYearMonth(yearRaw, monthRaw);
  const { from, to } = monthDayRange(year, month);
  const repoSlugs = opts.repoSlugs ?? buildRepoSlugMap(db);

  // 每表各一次查询,app 层归属 + 分组(N+1 防护)。
  const convRows = db
    .prepare(
      `SELECT ${DAY_AUM} AS day, project, COUNT(*) AS n
       FROM agent_user_messages
       WHERE is_human = 1 AND project IS NOT NULL
         AND ${DAY_AUM} >= @from AND ${DAY_AUM} < @to
       GROUP BY day, project`,
    )
    .all({ from, to }) as { day: string; project: string; n: number }[];

  const commitRows = db
    .prepare(
      `SELECT ${DAY_COMMIT} AS day, project_key AS project, COUNT(*) AS n
       FROM git_commits
       WHERE project_key IS NOT NULL
         AND ${DAY_COMMIT} >= @from AND ${DAY_COMMIT} < @to
       GROUP BY day, project`,
    )
    .all({ from, to }) as { day: string; project: string; n: number }[];

  type Acc = {
    convProjects: Set<string>;
    commitProjects: Set<string>;
    messageCount: number;
    commitCount: number;
  };
  const byDay = new Map<string, Acc>();
  const ensure = (day: string): Acc => {
    let acc = byDay.get(day);
    if (!acc) {
      acc = {
        convProjects: new Set(),
        commitProjects: new Set(),
        messageCount: 0,
        commitCount: 0,
      };
      byDay.set(day, acc);
    }
    return acc;
  };

  for (const r of convRows) {
    const acc = ensure(r.day);
    acc.convProjects.add(canonicalProject(r.project, repoSlugs).key);
    acc.messageCount += r.n;
  }
  for (const r of commitRows) {
    const acc = ensure(r.day);
    acc.commitProjects.add(canonicalProject(r.project, repoSlugs).key);
    acc.commitCount += r.n;
  }

  const days: MonthDay[] = [...byDay.entries()]
    .map(([day, acc]) => {
      let commitOnly = 0;
      for (const p of acc.commitProjects) {
        if (!acc.convProjects.has(p)) commitOnly += 1;
      }
      return {
        day,
        projectCount: acc.convProjects.size,
        messageCount: acc.messageCount,
        commitCount: acc.commitCount,
        commitOnlyProjectCount: commitOnly,
      };
    })
    .sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));

  const startRow = db
    .prepare(
      `SELECT MIN(${DAY_AUM}) AS d FROM agent_user_messages
       WHERE is_human = 1 AND project IS NOT NULL`,
    )
    .get() as { d: string | null };

  return {
    year,
    month,
    days,
    serverToday: localToday(opts.now),
    dataStartDay: startRow?.d ?? null,
  };
}

// ---------------------------------------------------------------- 当日明细

export type DaySourceCount = { source: string; count: number };
export type DayCommit = { hash: string; subject: string; atMs: number };

export type DayProject = {
  key: string;
  name: string;
  path: string | null;
  messageCount: number;
  bySource: DaySourceCount[];
  firstAtMs: number;
  lastAtMs: number;
  firstHumanText: string;
  commits: DayCommit[];
};

export type DayCommitOnlyProject = {
  key: string;
  name: string;
  path: string | null;
  commits: DayCommit[];
};

export type DayDetail = {
  date: string;
  /** 恒等于 projects.length,也恒等于日历格子上的数字。 */
  projectCount: number;
  messageCount: number;
  /** 含 commitOnlyProjects 的提交。 */
  commitCount: number;
  /** 有对话的项目,按消息数降序;并列时按 key 升序(稳定)。 */
  projects: DayProject[];
  /** 只有提交、没有对话的项目,按提交数降序。 */
  commitOnlyProjects: DayCommitOnlyProject[];
};

export function dayDetail(
  db: Database.Database,
  dateRaw: unknown,
  opts: { repoSlugs?: RepoSlugMap } = {},
): DayDetail {
  const date = assertLocalDay(dateRaw);
  const repoSlugs = opts.repoSlugs ?? buildRepoSlugMap(db);

  // 一次拉当天全部人话行(不逐项目查)。按时间升序,首条即「当天第一句」。
  const msgRows = db
    .prepare(
      `SELECT project, source, event_at_utc AS eventAtUtc, cleaned_text AS cleanedText
       FROM agent_user_messages
       WHERE is_human = 1 AND project IS NOT NULL AND ${DAY_AUM} = @date
       ORDER BY event_at_utc ASC, id ASC`,
    )
    .all({ date }) as {
    project: string;
    source: string;
    eventAtUtc: string;
    cleanedText: string | null;
  }[];

  // 一次拉当天全部提交。
  const commitRows = db
    .prepare(
      `SELECT project_key AS project, commit_hash AS hash, subject,
              author_date_utc AS authorDateUtc
       FROM git_commits
       WHERE project_key IS NOT NULL AND ${DAY_COMMIT} = @date
       ORDER BY author_date_utc ASC, commit_hash ASC`,
    )
    .all({ date }) as {
    project: string;
    hash: string;
    subject: string | null;
    authorDateUtc: string;
  }[];

  type ConvAcc = {
    key: string;
    path: string | null;
    messageCount: number;
    bySource: Map<string, number>;
    firstAtMs: number;
    lastAtMs: number;
    firstHumanText: string;
  };
  const conv = new Map<string, ConvAcc>();

  for (const r of msgRows) {
    const atMs = Date.parse(r.eventAtUtc);
    if (Number.isNaN(atMs)) continue; // 脏时间戳跳过,不污染时间跨度
    const { key, path } = canonicalProject(r.project, repoSlugs);
    let acc = conv.get(key);
    if (!acc) {
      acc = {
        key,
        path,
        messageCount: 0,
        bySource: new Map(),
        firstAtMs: atMs,
        lastAtMs: atMs,
        // 行已按时间升序,所以第一次见到这个项目时就是它当天的第一句。
        firstHumanText: (r.cleanedText ?? "").slice(0, FIRST_TEXT_MAX),
      };
      conv.set(key, acc);
    }
    acc.messageCount += 1;
    acc.bySource.set(r.source, (acc.bySource.get(r.source) ?? 0) + 1);
    if (atMs < acc.firstAtMs) acc.firstAtMs = atMs;
    if (atMs > acc.lastAtMs) acc.lastAtMs = atMs;
  }

  const commitsByProject = new Map<string, DayCommit[]>();
  let commitCount = 0;
  for (const r of commitRows) {
    const atMs = Date.parse(r.authorDateUtc);
    if (Number.isNaN(atMs)) continue;
    const { key } = canonicalProject(r.project, repoSlugs);
    const list = commitsByProject.get(key) ?? [];
    list.push({ hash: r.hash, subject: r.subject ?? "", atMs });
    commitsByProject.set(key, list);
    commitCount += 1;
  }

  const projects: DayProject[] = [...conv.values()]
    .map((acc) => ({
      key: acc.key,
      name: displayName(acc.key, acc.path),
      path: acc.path,
      messageCount: acc.messageCount,
      bySource: [...acc.bySource.entries()]
        .map(([source, count]) => ({ source, count }))
        .sort((a, b) => b.count - a.count || (a.source < b.source ? -1 : 1)),
      firstAtMs: acc.firstAtMs,
      lastAtMs: acc.lastAtMs,
      firstHumanText: acc.firstHumanText,
      commits: commitsByProject.get(acc.key) ?? [],
    }))
    .sort(
      (a, b) =>
        b.messageCount - a.messageCount ||
        (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
    );

  const commitOnlyProjects: DayCommitOnlyProject[] = [
    ...commitsByProject.entries(),
  ]
    .filter(([key]) => !conv.has(key))
    .map(([key, commits]) => {
      // 折叠区的项目没走过 conv 分支,这里单独取一次归属拿 path。
      const path = canonicalProject(key, repoSlugs).path;
      return { key, name: displayName(key, path), path, commits };
    })
    .sort(
      (a, b) =>
        b.commits.length - a.commits.length ||
        (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
    );

  return {
    date,
    projectCount: projects.length,
    messageCount: msgRows.length,
    commitCount,
    projects,
    commitOnlyProjects,
  };
}

// ---------------------------------------------------------------- 提交数据覆盖率

export type SyncCoverage = {
  totalRepos: number;
  scannedRepos: number;
  okCount: number;
  failedCount: number;
  neverScanned: number;
  /**
   * 最保守的水位:所有已扫描仓库里**最早**的那次扫描时刻。
   * 不用 MAX(git_commits.author_date_utc) —— 那只是某个仓库最新提交的作者时间,
   * 证明不了其余仓库扫完没有、失败没有,还可能被未来日期的提交顶高。
   */
  lastScanAt: string | null;
  /** lastScanAt 的本地日。晚于它的日期,提交数据不可信 → UI 显示「提交未同步」而非「0」。 */
  cutoffDay: string | null;
};

/** 提交摄取任务的 key。routes 与进度查询共用,别写第二份字面量。 */
export const GIT_COMMITS_TASK_KEY = "git.commits.sync";

export type SyncProgress = {
  /** 最近一次运行还没结束。 */
  running: boolean;
  /** 本轮已完成(成功或失败)的仓库数。 */
  done: number;
  /** 本轮要走的仓库总数。 */
  total: number;
  startedAt: string | null;
  finishedAt: string | null;
  /** scheduled_task_runs.status:running / success / partial / failed / skipped。 */
  lastStatus: string | null;
  errorSummary: string | null;
};

/**
 * 同步进度 —— **纯查出来**,不依赖任何内存状态。
 *
 * 成立的前提:ingestGitCommits 的 nowIso 整轮只算一次,逐仓库盖进
 * git_commits_state.last_run_at(成功和失败两条分支都盖)。所以
 * 「last_run_at >= 本轮 started_at」的行数,恰好是本轮已完成的仓库数。
 *
 * 这样一来:进程重启不丢、多标签一致、从 /scheduler 页触发同一任务也能看到进度。
 */
export function syncProgress(db: Database.Database): SyncProgress {
  const total = (
    db
      .prepare(`SELECT COUNT(*) AS n FROM repos WHERE missing_since IS NULL`)
      .get() as { n: number }
  ).n;

  const run = db
    .prepare(
      `SELECT started_at AS startedAt, finished_at AS finishedAt,
              status, error_summary AS errorSummary
       FROM scheduled_task_runs
       WHERE task_key = @key
       ORDER BY id DESC LIMIT 1`
    )
    .get({ key: GIT_COMMITS_TASK_KEY }) as
    | {
        startedAt: string;
        finishedAt: string | null;
        status: string;
        errorSummary: string | null;
      }
    | undefined;

  if (!run) {
    // 从未跑过 —— 与「跑过但 0 个仓库完成」是两回事,别混。
    return {
      running: false,
      done: 0,
      total,
      startedAt: null,
      finishedAt: null,
      lastStatus: null,
      errorSummary: null,
    };
  }

  const done = (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM git_commits_state s
           JOIN repos r ON r.path_canonical = s.repo_key
          WHERE r.missing_since IS NULL AND s.last_run_at >= @startedAt`
      )
      .get({ startedAt: run.startedAt }) as { n: number }
  ).n;

  return {
    running: run.finishedAt === null,
    done,
    total,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    lastStatus: run.status,
    errorSummary: run.errorSummary,
  };
}

export function syncCoverage(db: Database.Database): SyncCoverage {
  const row = db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM repos WHERE missing_since IS NULL) AS totalRepos,
         (SELECT COUNT(*) FROM git_commits_state s
            JOIN repos r ON r.path_canonical = s.repo_key
           WHERE r.missing_since IS NULL) AS scannedRepos,
         (SELECT COUNT(*) FROM git_commits_state s
            JOIN repos r ON r.path_canonical = s.repo_key
           WHERE r.missing_since IS NULL AND s.last_status = 'success') AS okCount,
         (SELECT MIN(s.last_run_at) FROM git_commits_state s
            JOIN repos r ON r.path_canonical = s.repo_key
           WHERE r.missing_since IS NULL) AS lastScanAt`,
    )
    .get() as {
    totalRepos: number;
    scannedRepos: number;
    okCount: number;
    lastScanAt: string | null;
  };

  const cutoffDay = row.lastScanAt
    ? ((
        db
          .prepare(`SELECT ${bucketExpr("day", "@ts")} AS d`)
          .get({ ts: row.lastScanAt }) as { d: string | null }
      ).d ?? null)
    : null;

  return {
    totalRepos: row.totalRepos,
    scannedRepos: row.scannedRepos,
    okCount: row.okCount,
    failedCount: row.scannedRepos - row.okCount,
    neverScanned: row.totalRepos - row.scannedRepos,
    lastScanAt: row.lastScanAt,
    cutoffDay,
  };
}
