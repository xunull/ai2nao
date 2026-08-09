import type Database from "better-sqlite3";
import { listProviders } from "../providers/store.js";
import { listReplaySessions } from "../replay/queries.js";
import { localDayRangeUtc, todayLocalDay } from "../timeWindow/bucket.js";
import { generateTrend } from "../workTokensTrend/service.js";
import type { WorkTokensTrendBucket } from "../workTokensTrend/types.js";

/**
 * 首页「今日线索」。
 *
 * 一条线索 = 一个确定性事实 + 一个能点进去的深链。探针产出线索;**没话说就返回 null**。
 *
 *   registry: Probe[]
 *        │
 *        └─ for each: run(db, ctx) ──┬─→ Lead    有话说
 *                                    ├─→ null    今天很正常
 *                                    └─→ throw   捕获进 errors[],不伪造成 Lead
 *        │
 *        ├─ 排序: severity desc → asOf desc → registry 顺序(确定性兜底)
 *        └─ warning 全留;info/notable 填到总数 7 为止,其余计入 overflow
 *
 * **防墙机制不是「返回 null」这个约定,是 `baseline`。** 「今天花了 token」几乎天天为真,
 * 只靠约定,实现时最省事的写法就是「有数据就出一条」,结果仍是一堵每天准时上班的指标墙。
 * 所以每个探针必须声明它凭什么认为今天不寻常,`validateRegistry` 在模块加载时就拦。
 */

/** 与 workDashboard / workTokensTrend / workRecap 的 Diagnostic 同用 `warning`,不写 `warn`。 */
export type LeadSeverity = "info" | "notable" | "warning";

export type Lead = {
  /** 稳定 id,等于探针 id。前端拿它做 key。 */
  id: string;
  severity: LeadSeverity;
  /** 一句话结论,**必须含具体数字**。「今天 token 比 7 日中位数高 62%」 */
  title: string;
  /** 可选补充,一行以内。 */
  detail?: string;
  /** 深链。必须命中 web/src/routes.ts 的路由表 —— test/home.links.test.ts 会断言。 */
  href: string;
  /** 数据的时间戳,不是渲染时间。 */
  asOf: string;
};

/**
 * 探针凭什么认为「今天值得说」。这不是文档说明,是注册前置条件。
 * - `deviation` 偏离近期常态到一定幅度才出声(token 花销这类天天有值的)
 * - `threshold` 越过一个绝对线才出声(额度剩余百分比这类)
 * - `novelty`   只在「第一次出现」时出声
 * - `failure`   只在出错/停摆时出声
 */
export type BaselineSpec =
  | { kind: "deviation"; windowDays: number; minPctDelta: number }
  | { kind: "threshold"; note: string }
  | { kind: "novelty" }
  | { kind: "failure" };

export type ProbeContext = { now: Date };

export type Probe = {
  id: string;
  label: string;
  baseline: BaselineSpec;
  /**
   * 这个探针把你送到哪一页。**声明在探针上,不是埋在 run() 的返回语句里** —— 深链是探针的
   * 静态属性,提上来才能在不跑数据库的情况下静态校验(test/home.links.test.ts)。
   * 埋在 run() 里的话,只有「今天恰好有话说」的探针才会被检查到,那种测试是假的。
   */
  href: string;
  run(db: Database.Database, ctx: ProbeContext): Omit<Lead, "id" | "href"> | null;
};

export type LeadError = { probeId: string; message: string };

export type LeadsResponse = {
  leads: Lead[];
  /** 被截断的非 warning 条数。放响应上,不塞进 Lead。 */
  overflow: number;
  /** 探针抛异常落这里。**不伪造成 Lead** —— 否则一次多探针故障就能占满首页。 */
  errors: LeadError[];
  /** 仅当 leads 为空时出现,让首页摆几张现成的卡而不是一片空白。 */
  fallbackCards?: string[];
};

/** 首页最多显示这么多条(项目铁律:禁止垂直过度滚动)。warning 例外,见 collectLeads。 */
export const MAX_LEADS = 7;

/** 全空时的兜底卡片,取自 src/cards/registry.ts 的 name。 */
export const FALLBACK_CARDS = ["streak", "rhythm", "token"] as const;

const SEVERITY_RANK: Record<LeadSeverity, number> = { warning: 2, notable: 1, info: 0 };

// ---------- 探针 ----------

/** 今天的 token 花销偏离最近一周常态多少。 */
const TOKENS_TODAY_MIN_PCT = 40;

const tokensToday: Probe = {
  id: "tokens.today",
  label: "今天的 token 花销",
  baseline: { kind: "deviation", windowDays: 7, minPctDelta: TOKENS_TODAY_MIN_PCT },
  href: "/dashboard/tokens-trend",
  run(db, ctx) {
    // 复用趋势服务而不是自己拼多源 union —— token 口径散在 claude/codex/minimax/opencode
    // 四套表里,`generateTrend` 就是为统一它们而存在的,再写一遍必然漂。
    const trend = generateTrend(db, { window: "1w", now: ctx.now });
    const buckets = trend.buckets;
    if (buckets.length < 2) return null;

    const today = buckets[buckets.length - 1];
    const prior = buckets.slice(0, -1).map(bucketTotal).filter((n) => n > 0);
    if (prior.length < 3) return null; // 基线样本太少,不足以说「反常」

    const todayTotal = bucketTotal(today);
    if (todayTotal <= 0) return null;

    const base = median(prior);
    if (base <= 0) return null;

    const pct = Math.round(((todayTotal - base) / base) * 100);
    if (Math.abs(pct) < TOKENS_TODAY_MIN_PCT) return null; // 今天很正常,不出声

    const dir = pct > 0 ? "高" : "低";
    return {
      severity: Math.abs(pct) >= 150 ? "notable" : "info",
      title: `今天 token ${fmtCount(todayTotal)},比近 7 日中位数${dir} ${Math.abs(pct)}%`,
      detail: `中位数 ${fmtCount(base)}`,
      asOf: ctx.now.toISOString(),
    };
  },
};

/** 额度剩余低于这个百分比就出声。 */
const QUOTA_WARN_PCT = 15;
const QUOTA_NOTABLE_PCT = 30;

const quotaLow: Probe = {
  id: "quota.low",
  label: "订阅额度见底",
  baseline: { kind: "threshold", note: `remainingPercent < ${QUOTA_NOTABLE_PCT}` },
  href: "/providers",
  run(db, ctx) {
    let worst: { label: string; pct: number; syncedAt: string | null } | null = null;
    for (const p of listProviders(db)) {
      if (!p.enabled) continue;
      for (const item of p.items) {
        const pct = item.remainingPercent;
        if (typeof pct !== "number" || pct >= QUOTA_NOTABLE_PCT) continue;
        if (!worst || pct < worst.pct) {
          worst = { label: `${p.label} · ${item.label}`, pct, syncedAt: item.syncedAt ?? null };
        }
      }
    }
    if (!worst) return null;
    return {
      severity: worst.pct < QUOTA_WARN_PCT ? "warning" : "notable",
      title: `${worst.label} 额度只剩 ${Math.round(worst.pct)}%`,
      asOf: worst.syncedAt ?? ctx.now.toISOString(),
    };
  },
};

/** 一个项目沉寂这么多天后又动了,才算「久违」。 */
const DORMANT_DAYS = 14;

const reposToday: Probe = {
  id: "repos.today",
  label: "今天动了哪些项目",
  baseline: { kind: "novelty" },
  href: "/project-calendar",
  run(db, ctx) {
    const { fromIso, toIso } = localDayRangeUtc(ctx.now, 1);
    // 先用日期范围圈出今天有提交的项目(这一段要扫 git_commits —— 它的索引最左列是
    // repo_key,按时间范围用不上),再对**这几个**项目各查一次上次提交(走 project_key 索引)。
    // 反过来写成一条 GROUP BY 全表的话,工作量跟仓库总数成正比而不是跟今天的活跃数。
    const rows = db
      .prepare(
        `WITH today AS (
           SELECT DISTINCT project_key FROM git_commits
           WHERE author_date_utc >= ? AND author_date_utc < ? AND project_key IS NOT NULL
         )
         SELECT t.project_key AS pk,
                (SELECT MAX(g.author_date_utc) FROM git_commits g
                  WHERE g.project_key = t.project_key AND g.author_date_utc < ?) AS prev
         FROM today t`
      )
      .all(fromIso, toIso, fromIso) as { pk: string; prev: string | null }[];
    if (rows.length === 0) return null;

    const cutoff = new Date(ctx.now.getTime() - DORMANT_DAYS * 86_400_000).toISOString();
    const revived = rows.filter((r) => r.prev === null || r.prev < cutoff);
    // 只是「今天动了几个项目」不值得占版面 —— 那天天为真。有久违的才出声。
    if (revived.length === 0) return null;

    const names = revived.map((r) => shortProject(r.pk));
    return {
      severity: "notable",
      title: `${names.slice(0, 3).join("、")}${names.length > 3 ? ` 等 ${names.length} 个` : ""}沉了 ${DORMANT_DAYS} 天以上,今天又动了`,
      detail: `今天共 ${rows.length} 个项目有提交`,
      asOf: ctx.now.toISOString(),
    };
  },
};

const schedulerFailing: Probe = {
  id: "scheduler.failing",
  label: "定时任务失败",
  baseline: { kind: "failure" },
  href: "/scheduler",
  run(db, ctx) {
    // 只看 failed,**不看 partial** —— partial 目前是常态噪音(812 个仓库里 32 个空仓库
    // 让 git 两个任务每次都 partial)。把噪音也算进来,这条探针就会天天亮,等于没有。
    // 从 scheduled_tasks(27 行)出发,每个任务走一次 idx_scheduled_task_runs_task_started
    // 取它最后一次运行。反过来「扫 run 表再 GROUP BY task_key」的话,12 万行每行都要回表
    // —— data.stale 起初就是那么写的,实测 101ms。
    const rows = db
      .prepare(
        `SELECT r.task_key AS k, r.started_at AS at
           FROM scheduled_tasks t
           JOIN scheduled_task_runs r ON r.id = (
             SELECT r2.id FROM scheduled_task_runs r2
              WHERE r2.task_key = t.task_key
              ORDER BY r2.started_at DESC, r2.id DESC LIMIT 1)
          WHERE r.status = 'failed'`
      )
      .all() as { k: string; at: string }[];
    if (rows.length === 0) return null;
    const names = rows.map((r) => r.k);
    return {
      severity: "warning",
      title: `${names.slice(0, 2).join("、")}${names.length > 2 ? ` 等 ${names.length} 个` : ""}定时任务上一次跑失败了`,
      asOf: rows.map((r) => r.at).sort().slice(-1)[0] ?? ctx.now.toISOString(),
    };
  },
};

/** 某个数据源最后一次成功超过这么多天,就算停更。 */
const STALE_DAYS = 7;

/**
 * 每个任务最后一次成功是什么时候。导出是为了让计划回归测试能 EXPLAIN 它本身,
 * 而不是在测试里抄一份必然会漂的副本。
 */
export const DATA_STALE_SQL = `SELECT t.task_key AS k,
        (SELECT MAX(r.started_at) FROM scheduled_task_runs r
          WHERE r.task_key = t.task_key
            AND likelihood(r.status = 'success', 0.96)) AS last_ok
   FROM scheduled_tasks t`;

const dataStale: Probe = {
  id: "data.stale",
  label: "数据源停更",
  baseline: { kind: "failure" },
  href: "/scheduler",
  run(db, ctx) {
    // 判据是「**有过**成功却停了」,不是「任务被禁用」。ensureRegisteredTasks 注册每个任务
    // 时 enabled 都是 0(src/scheduler/store.ts),拿 enabled 当判据的话:扫全部会在全新安装
    // 上永久报警,只扫已启用的又恰好看不见那些「开过、后来被关掉、数据因此停更」的源
    // —— 而那才是真正会坑人的一类。
    // `likelihood(..., 0.96)` 不是装饰,是这条查询能不能用的分界线。
    //
    // 这张表有两条索引:(task_key, started_at DESC) 和 (status, started_at DESC)。库里没有
    // ANALYZE 统计,优化器只能猜,而它猜错了 —— 选了 status 那条。于是 27 个任务里的每一个
    // 都要走完 118631 条 success 行去过滤 task_key,约 320 万次行访问,实测 863ms。
    // likelihood() 把「status='success' 命中 96% 的行、几乎没有选择性」这个事实告诉它,
    // 它就改走 task_key 那条:1.1ms。实测 863 → 1.1。
    //
    // 用 likelihood 而不是 `INDEXED BY`:前者陈述关于数据的事实,后者硬编码索引名。索引改名
    // 或被替换时,前者仍能选出合理计划,后者直接报错。计划本身有回归测试钉着(见
    // test/home.probes.plan.test.ts),漂回去会红。
    const rows = (
      db.prepare(DATA_STALE_SQL).all() as { k: string; last_ok: string | null }[]
    ).filter((r): r is { k: string; last_ok: string } => r.last_ok !== null);
    const cutoff = new Date(ctx.now.getTime() - STALE_DAYS * 86_400_000).toISOString();
    const stale = rows.filter((r) => r.last_ok < cutoff);
    if (stale.length === 0) return null;

    stale.sort((a, b) => (a.last_ok < b.last_ok ? -1 : 1));
    const worst = stale[0];
    const days = Math.floor((ctx.now.getTime() - Date.parse(worst.last_ok)) / 86_400_000);
    return {
      severity: "warning",
      title: `${stale.length} 个数据源停更了,最久的 ${worst.k} 已经 ${days} 天`,
      detail: "页面上的相关数字仍是旧的",
      asOf: worst.last_ok,
    };
  },
};

const toolsNew: Probe = {
  id: "tools.new",
  label: "新出现的 AI 工具",
  baseline: { kind: "novelty" },
  href: "/ai-tools",
  run(db, ctx) {
    const { fromIso, toIso } = localDayRangeUtc(ctx.now, 1);
    const rows = db
      .prepare(
        `SELECT DISTINCT name FROM ai_tools
          WHERE first_seen_at >= ? AND first_seen_at < ? LIMIT 6`
      )
      .all(fromIso, toIso) as { name: string }[];
    if (rows.length === 0) return null;
    const names = rows.map((r) => r.name);
    return {
      severity: "info",
      title: `今天第一次见到 ${names.slice(0, 3).join("、")}${names.length > 3 ? ` 等 ${names.length} 个工具` : ""}`,
      asOf: ctx.now.toISOString(),
    };
  },
};

const atuinNewDirs: Probe = {
  id: "atuin.newdirs",
  label: "新的工作目录",
  baseline: { kind: "novelty" },
  href: "/atuin/directories",
  run(db, ctx) {
    const { fromIso, toIso } = localDayRangeUtc(ctx.now, 1);
    // 这张表存的是纳秒时间戳。first_timestamp_ns 落在今天 = 这个目录今天第一次出现。
    const rows = db
      .prepare(
        `SELECT cwd FROM atuin_directory_activity_dirs
          WHERE first_timestamp_ns >= ? AND first_timestamp_ns < ? LIMIT 6`
      )
      .all(Date.parse(fromIso) * 1_000_000, Date.parse(toIso) * 1_000_000) as { cwd: string }[];
    if (rows.length === 0) return null;
    const names = rows.map((r) => r.cwd.split("/").slice(-1)[0] || r.cwd);
    return {
      severity: "info",
      title: `shell 今天进了 ${rows.length} 个没去过的目录:${names.slice(0, 3).join("、")}`,
      asOf: ctx.now.toISOString(),
    };
  },
};

/** 今天下载量比常态高这么多倍才出声。 */
const DOWNLOADS_MIN_RATIO = 2;

const downloadsToday: Probe = {
  id: "downloads.today",
  label: "今天的下载",
  baseline: { kind: "deviation", windowDays: 8, minPctDelta: (DOWNLOADS_MIN_RATIO - 1) * 100 },
  href: "/downloads",
  run(db, ctx) {
    const today = todayLocalDay(ctx.now);
    const since = todayLocalDay(new Date(ctx.now.getTime() - 7 * 86_400_000));
    // calendar_day 本身就是本地日字符串,而且有索引(idx_download_files_day) —— 直接比字符串。
    const rows = db
      .prepare(
        `SELECT calendar_day AS d, COUNT(*) AS c FROM download_files
          WHERE calendar_day >= ? AND calendar_day <= ? GROUP BY calendar_day`
      )
      .all(since, today) as { d: string; c: number }[];

    const todayCount = rows.find((r) => r.d === today)?.c ?? 0;
    if (todayCount === 0) return null;
    const prior = rows.filter((r) => r.d !== today).map((r) => r.c);
    if (prior.length < 3) return null;
    const base = Math.max(1, median(prior));
    if (todayCount < base * DOWNLOADS_MIN_RATIO) return null;

    return {
      severity: "info",
      title: `今天下载了 ${todayCount} 个文件,是平时的 ${(todayCount / base).toFixed(1)} 倍`,
      asOf: ctx.now.toISOString(),
    };
  },
};

/** 一段连续工作超过这么久才值得一提。 */
const LONG_SESSION_MS = 3 * 3_600_000;

const sessionLongest: Probe = {
  id: "session.longest",
  label: "今天最长的一段工作",
  baseline: { kind: "threshold", note: `>= ${LONG_SESSION_MS / 3_600_000}h` },
  href: "/replay",
  run(db, ctx) {
    // 复用「那天回放」的分段引擎,不另起一套。gapThresholdMs 用它的默认值 ——
    // 这里刻意不读 app_config 的 replay.gapMinutes:首页只是引流,真正的口径以回放页为准,
    // 两处读同一个设置反而会让「首页说 4 小时、点进去看到两段」更难解释。
    const { sessions } = listReplaySessions(db, {
      windowDays: 1,
      nowMs: ctx.now.getTime(),
      includeNoCommit: true,
    });
    if (sessions.length === 0) return null;

    const longest = sessions.reduce((a, b) =>
      b.endedAtMs - b.startedAtMs > a.endedAtMs - a.startedAtMs ? b : a
    );
    const ms = longest.endedAtMs - longest.startedAtMs;
    if (ms < LONG_SESSION_MS) return null;

    const hours = (ms / 3_600_000).toFixed(1);
    return {
      severity: "info",
      title: `今天有一段 ${hours} 小时的连续工作,${longest.messageCount} 条对话、${longest.commitCount} 次提交`,
      asOf: new Date(longest.endedAtMs).toISOString(),
    };
  },
};

/**
 * 注册表。顺序即同级线索的确定性兜底排序 —— 越靠前越先显示,所以按「你多半更想先看到」
 * 排:出事的 → 该注意的 → 有意思的。
 */
export const PROBES: Probe[] = [
  quotaLow,
  schedulerFailing,
  dataStale,
  reposToday,
  tokensToday,
  sessionLongest,
  downloadsToday,
  toolsNew,
  atuinNewDirs,
];

// ---------- 编排 ----------

/**
 * 注册前置检查。TS 已经能保证字段存在,这里挡的是 `as any` 之类的逃逸,
 * 以及「加了探针但忘了想清楚它凭什么出声」这种更常见的情况。
 */
export function validateRegistry(probes: readonly Probe[]): void {
  const seen = new Set<string>();
  for (const p of probes) {
    if (!p.id) throw new Error("probe without id");
    if (seen.has(p.id)) throw new Error(`duplicate probe id: ${p.id}`);
    seen.add(p.id);
    if (!p.baseline || typeof p.baseline.kind !== "string") {
      throw new Error(`probe ${p.id} has no baseline — 说不清凭什么出声的探针不允许注册`);
    }
    if (!p.href || !p.href.startsWith("/")) {
      throw new Error(`probe ${p.id} has no href — 不能点进去的线索没有意义`);
    }
  }
}

export function collectLeads(
  db: Database.Database,
  ctx: ProbeContext,
  probes: readonly Probe[] = PROBES
): LeadsResponse {
  // 带上 registry 下标做确定性兜底排序。用包装对象而不是往 Lead 上挂隐藏字段 ——
  // 后者会顺着 JSON 漏到前端去。
  const found: { lead: Lead; order: number }[] = [];
  const errors: LeadError[] = [];

  probes.forEach((probe, order) => {
    try {
      const partial = probe.run(db, ctx);
      // id 和 href 由探针声明,run() 只负责「今天说什么」。这样一个探针不可能返回
      // 与自己 id 不符的线索,href 也永远是那个被静态校验过的值。
      if (partial) found.push({ lead: { ...partial, id: probe.id, href: probe.href }, order });
    } catch (e) {
      errors.push({ probeId: probe.id, message: e instanceof Error ? e.message : String(e) });
    }
  });

  found.sort((a, b) => {
    const bySeverity = SEVERITY_RANK[b.lead.severity] - SEVERITY_RANK[a.lead.severity];
    if (bySeverity !== 0) return bySeverity;
    if (a.lead.asOf !== b.lead.asOf) return a.lead.asOf < b.lead.asOf ? 1 : -1;
    return a.order - b.order;
  });

  // warning 全留(额度见底不能因为版面不够被折走);其余填到总数 MAX_LEADS 为止。
  const warnings = found.filter((f) => f.lead.severity === "warning").map((f) => f.lead);
  const rest = found.filter((f) => f.lead.severity !== "warning").map((f) => f.lead);
  const room = Math.max(0, MAX_LEADS - warnings.length);
  const shown = [...warnings, ...rest.slice(0, room)];

  const res: LeadsResponse = {
    leads: shown,
    overflow: Math.max(0, rest.length - room),
    errors,
  };
  if (shown.length === 0) res.fallbackCards = [...FALLBACK_CARDS];
  return res;
}

// ---------- 小工具 ----------

/**
 * 一个桶的三源合计。桶上没有 `totalTokens` —— 那个字段在 `totals` 上,桶是**按源分列**的
 * (claudeTokens / codexTokens / minimaxTokens)。这里显式相加,而不是去 totals 上取:
 * totals 是整窗合计,拿它算不出「今天 vs 前六天」。
 */
function bucketTotal(b: WorkTokensTrendBucket): number {
  return b.claudeTokens + b.codexTokens + b.minimaxTokens;
}

/** 项目 key 是路径 slug,首页只需要末段。 */
function shortProject(key: string): string {
  return key.split("-").slice(-1)[0] || key;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
}

function fmtCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(Math.round(n));
}

validateRegistry(PROBES);
