import type Database from "better-sqlite3";
import { listProviders } from "../providers/store.js";
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

/** 注册表。顺序即同级线索的确定性兜底排序。 */
export const PROBES: Probe[] = [quotaLow, tokensToday];

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
