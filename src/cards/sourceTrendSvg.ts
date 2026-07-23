/**
 * 三源使用趋势卡:按本地周分桶,每周一根堆叠竖条(Claude / Codex / opencode 三色)。
 * 看的是「对哪个 agent 说话」随时间的迁移。数据 = weeklySourceMix(is_human 消息计数)。
 * 约束同其它卡:无 <style>/外链、presentation 属性、自带浅色底。
 */
import type { SourceTrend } from "../aiRhythm/queries.js";

const PAD = 16;
const TITLE_H = 30;
const PLOT_H = 96;
const FOOTER_H = 18;
const BAR_W = 12;
const BAR_GAP = 4;
const STEP = BAR_W + BAR_GAP; // 16
const SHOW_WEEKS = 16; // 最近 N 周
const FONT =
  '-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif';

/** 三源固定色(GitHub 分类色,彼此可辨)。 */
const SERIES: { key: "claude" | "codex" | "opencode"; label: string; color: string }[] =
  [
    { key: "claude", label: "Claude", color: "#8250df" },
    { key: "codex", label: "Codex", color: "#1f6feb" },
    { key: "opencode", label: "opencode", color: "#2da44e" },
  ];

export function renderSourceTrendSvg(trend: SourceTrend): string {
  const weeks = trend.weeks.slice(-SHOW_WEEKS);
  const plotW = Math.max(STEP, weeks.length * STEP - BAR_GAP);
  const width = Math.max(260, PAD * 2 + plotW);
  const yPlotTop = PAD + TITLE_H;
  const yPlotBottom = yPlotTop + PLOT_H;
  const yLegend = yPlotBottom + 15;
  const yFooter = yLegend + FOOTER_H;
  const height = yFooter + 6;

  const maxTotal = Math.max(1, ...weeks.map((w) => w.total));
  let sumTotal = 0;

  const bars: string[] = [];
  weeks.forEach((w, i) => {
    sumTotal += w.total;
    const x = PAD + i * STEP;
    let bottom = yPlotBottom;
    for (const s of SERIES) {
      const v = w[s.key];
      if (v <= 0) continue;
      const h = Math.max(1, Math.round((v / maxTotal) * PLOT_H));
      const y = bottom - h;
      bars.push(
        `<rect x="${x}" y="${y}" width="${BAR_W}" height="${h}" fill="${s.color}"/>`
      );
      bottom = y;
    }
  });

  const legend = SERIES.map((s, i) => {
    const lx = PAD + i * 92;
    return (
      `<rect x="${lx}" y="${yLegend - 9}" width="10" height="10" rx="2" fill="${s.color}"/>` +
      `<text x="${lx + 14}" y="${yLegend}" font-size="10" fill="#656d76">${s.label}</text>`
    );
  }).join("");

  const footer = `共 ${sumTotal} 次 · 近 ${weeks.length} 周 · 截至 ${trend.generatedAt.slice(
    0,
    10
  )}`;

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="三源使用趋势">`,
    `<rect x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" rx="8" fill="#ffffff" stroke="#d0d7de"/>`,
    `<g font-family='${FONT}'>`,
    `<text x="${PAD}" y="${PAD + 15}" font-size="15" font-weight="600" fill="#1f2328">三源使用趋势</text>`,
    bars.join(""),
    legend,
    `<text x="${PAD}" y="${yFooter}" font-size="11" fill="#656d76">${footer}</text>`,
    `</g>`,
    `</svg>`,
  ].join("");
}
