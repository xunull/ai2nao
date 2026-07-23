/**
 * 卡片注册表 —— 一处列全所有卡。bundle / HTTP 端点 / CLI 都读它(DRY)。
 * 每条把「查询 → 纯渲染器」接起来;渲染器本身与 db 无关、易测。
 * 新增一张卡 = 加一条 CardDef,bundle/端点/CLI 自动带上。
 */
import type Database from "better-sqlite3";
import {
  activityCalendar,
  commandLeaderboard,
  heatmapRhythm,
  personalRecords,
  streakRhythm,
  weeklySourceMix,
} from "../aiRhythm/queries.js";
import { getAiToolsStatus, listAiTools } from "../aiTools/queries.js";
import { generateTrend } from "../workTokensTrend/service.js";
import { renderCalendarSvg } from "./calendarSvg.js";
import { renderLeaderboardSvg } from "./leaderboardSvg.js";
import { renderRhythmSvg } from "./rhythmSvg.js";
import { renderSourceTrendSvg } from "./sourceTrendSvg.js";
import {
  renderAiToolsCard,
  renderRecordsCard,
  renderStreakCard,
  renderTokenCard,
} from "./statCards.js";

export type CardRenderOpts = {
  /** token 卡:附带成本估算($)。仅该卡关心,其它卡忽略。 */
  cost?: boolean;
  /** 覆盖时钟(测试用),同时作为无 generatedAt 的卡的 footer 日期。 */
  now?: Date;
};

export type CardDef = {
  /** 文件名 / URL 段,如 "rhythm"、"ai-tools"。 */
  name: string;
  /** README 小节标题 + 卡内可见标题。 */
  title: string;
  /** README 里的一句说明。 */
  description: string;
  render: (db: Database.Database, opts?: CardRenderOpts) => string;
};

const isoNow = (o?: CardRenderOpts): string => (o?.now ?? new Date()).toISOString();

export const CARD_REGISTRY: CardDef[] = [
  {
    name: "rhythm",
    title: "AI coding 作息热力图",
    description: "周几 × 小时,看几点、周几最常找 AI。",
    render: (db, o) => renderRhythmSvg(heatmapRhythm(db, { now: o?.now })),
  },
  {
    name: "calendar",
    title: "AI coding 活动日历",
    description: "GitHub 贡献图式:哪些天在用 AI、连不连续。",
    render: (db, o) => renderCalendarSvg(activityCalendar(db, { now: o?.now })),
  },
  {
    name: "streak",
    title: "连续活跃天数",
    description: "Duolingo 式连续天数:当前 / 最长 / 累计。",
    render: (db, o) => renderStreakCard(streakRhythm(db, { now: o?.now })),
  },
  {
    name: "records",
    title: "个人纪录",
    description: "最忙一天、单时峰值、累计消息、最长一次输入。",
    render: (db, o) => renderRecordsCard(personalRecords(db, { now: o?.now })),
  },
  {
    name: "ai-tools",
    title: "AI 工具清单",
    description: "本机在用的 AI 工具数(按类型分)。",
    render: (db, o) =>
      renderAiToolsCard(listAiTools(db), getAiToolsStatus(db).lastSyncAt ?? isoNow(o)),
  },
  {
    name: "token",
    title: "Token 用量",
    description: "近 6 个月 token 总量(各源分布;可选成本)。",
    render: (db, o) =>
      renderTokenCard(generateTrend(db, { window: "6m", now: o?.now }).totals, {
        cost: o?.cost,
        asOfIso: isoNow(o),
      }),
  },
  {
    name: "source-trend",
    title: "三源使用趋势",
    description: "按周统计 Claude / Codex / opencode 的对话量迁移。",
    render: (db, o) => renderSourceTrendSvg(weeklySourceMix(db, { now: o?.now })),
  },
  {
    name: "leaderboard",
    title: "命令 / 技能排行",
    description: "最常用的斜杠命令 / 技能 Top 8。",
    render: (db, o) => renderLeaderboardSvg(commandLeaderboard(db, { limit: 8, now: o?.now })),
  },
];

/** 按 name 找卡(端点 / CLI 用)。 */
export function findCard(name: string): CardDef | undefined {
  return CARD_REGISTRY.find((c) => c.name === name);
}
