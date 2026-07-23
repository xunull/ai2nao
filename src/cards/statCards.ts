/**
 * 四张「数字卡」:连续天数 / 个人纪录 / AI 工具清单 / Token 用量。
 * 每个都是纯函数(数据 → SVG),内部把数据塞成 StatCardInput 交给 renderStatCard。
 * 数据查询在 registry.ts 里接上,这里只管把已有结果排版。
 */
import type {
  StreakRhythm,
  PersonalRecords,
} from "../aiRhythm/queries.js";
import type { AiToolKind, AiToolView } from "../aiTools/types.js";
import type { WorkTokensTrendTotals } from "../workTokensTrend/types.js";
import { renderStatCard } from "./statCard.js";
import { formatCompact } from "./svgUtil.js";

const DASH = "—";
const day10 = (iso: string) => iso.slice(0, 10);

/** 连续活跃天数(Duolingo 式)。 */
export function renderStreakCard(s: StreakRhythm): string {
  return renderStatCard({
    title: "连续活跃天数",
    big: { value: String(s.currentStreak), caption: "天连续活跃(当前)" },
    stats: [
      { label: "最长连续", value: `${s.longestStreak} 天` },
      { label: "累计活跃", value: `${s.totalActiveDays} 天` },
      { label: "今天", value: s.todayActive ? "已活跃" : "未活跃" },
    ],
    footer: `截至 ${day10(s.generatedAt)}`,
    accent: s.currentStreak > 0 ? "#216e39" : "#8c959f",
  });
}

/** 个人纪录/极值(奖杯架)。 */
export function renderRecordsCard(r: PersonalRecords): string {
  return renderStatCard({
    title: "个人纪录",
    big: { value: String(r.total), caption: "条消息 · 累计" },
    stats: [
      { label: "起始日", value: r.firstDay ?? DASH },
      {
        label: "最忙一天",
        value: r.busiestDay
          ? `${r.busiestDay.day.slice(5)} · ${r.busiestDay.count}`
          : DASH,
      },
      { label: "单时峰值", value: r.peakHour ? `${r.peakHour.count} 条` : DASH },
      {
        label: "最长一次输入",
        value: r.maxCharLen > 0 ? `${r.maxCharLen} 字` : DASH,
      },
    ],
    footer: `截至 ${day10(r.generatedAt)}`,
  });
}

const KIND_ORDER: AiToolKind[] = [
  "desktop-app",
  "cli",
  "local-runtime",
  "ide-extension",
];
const KIND_ZH: Record<AiToolKind, string> = {
  "desktop-app": "桌面应用",
  cli: "命令行",
  "local-runtime": "本地运行时",
  "ide-extension": "编辑器插件",
};

/** 本机在用的 AI 工具数,按类型分。views = 在场工具(listAiTools 默认已过滤 missing)。 */
export function renderAiToolsCard(views: AiToolView[], asOfIso: string): string {
  const byKind = new Map<AiToolKind, number>();
  for (const v of views) byKind.set(v.kind, (byKind.get(v.kind) ?? 0) + 1);
  const stats = KIND_ORDER.filter((k) => (byKind.get(k) ?? 0) > 0).map((k) => ({
    label: KIND_ZH[k],
    value: `${byKind.get(k)} 个`,
  }));
  return renderStatCard({
    title: "AI 工具清单",
    big: { value: String(views.length), caption: "个 AI 工具在用" },
    stats,
    footer: `截至 ${day10(asOfIso)}`,
  });
}

/** Token 用量(近 6 个月总量 + 各源分布;cost 时附成本估算)。 */
export function renderTokenCard(
  t: WorkTokensTrendTotals,
  opts: { cost?: boolean; asOfIso: string }
): string {
  const stats: { label: string; value: string }[] = [];
  if (t.claudeTokens > 0)
    stats.push({ label: "Claude", value: formatCompact(t.claudeTokens) });
  if (t.codexTokens > 0)
    stats.push({ label: "Codex", value: formatCompact(t.codexTokens) });
  if (t.minimaxTokens > 0)
    stats.push({ label: "MiniMax", value: formatCompact(t.minimaxTokens) });
  if (opts.cost) {
    const usd = t.claudeCostUsd + t.codexCostUsd;
    stats.push({ label: "≈ 成本", value: `$${usd.toFixed(2)}` });
  }
  return renderStatCard({
    title: "Token 用量",
    big: { value: formatCompact(t.totalTokens), caption: "近 6 个月 token" },
    stats,
    footer: `近 6 个月 · 截至 ${day10(opts.asOfIso)}`,
  });
}
