/**
 * 把 AI coding 作息热力图渲成一张自包含 SVG,供嵌入 GitHub 主页 README。
 * 设计:~/.gstack/projects/xunull-ai2nao/20260722-design-profile-rhythm-card.md
 *
 * 关键约束:
 * - GitHub 把 SVG 当 <img> 渲染(secure static mode):脚本禁用、外链禁用,但 SVG 内联
 *   presentation 样式照常。故这里**不引外部字体/CDN、不用 <style>**,样式全走 presentation
 *   属性(font-family/fill 挂在 <g>/<text> 上),最稳。
 * - **自带不透明浅色底**:卡片是张"贴纸",GitHub 亮/暗底下都一致,回避暗色文字看不见的坑
 *   (设计 §3 的坑①;暗色专版留 v2)。
 * - 只输出聚合网格 + 计数,绝不含消息内容 / 路径 / PII(设计 §6)。
 */
import type { RhythmHeatmap } from "../aiRhythm/queries.js";
import { LEVEL_COLORS, colorLevel } from "./colorScale.js";

const PAD = 16;
const TITLE_H = 26;
const HOUR_LABEL_H = 15;
const CELL = 14;
const GAP = 4;
const STEP = CELL + GAP; // 18
const DAY_LABEL_W = 34;
const COLS = 24; // 小时 0-23
const ROWS = 7; // 周一→周日
const GRID_W = COLS * STEP - GAP; // 428
const GRID_H = ROWS * STEP - GAP; // 122
const FOOTER_H = 20;

const GRID_X = PAD + DAY_LABEL_W; // 50
const GRID_Y = PAD + TITLE_H + HOUR_LABEL_H; // 57
const WIDTH = PAD + DAY_LABEL_W + GRID_W + PAD; // 494
const HEIGHT = GRID_Y + GRID_H + FOOTER_H + PAD; // 215

const FONT =
  '-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif';
/** 行标签:周一…周日。 */
const DAY_LABELS = ["一", "二", "三", "四", "五", "六", "日"];
/** 按 SQLite weekday(0=周日)取中文,用于 peak 文案。 */
const WEEKDAY_ZH = ["日", "一", "二", "三", "四", "五", "六"];

/** SQLite weekday(0=周日)→ 周一起的行号(0=周一..6=周日)。 */
function mondayRow(weekday: number): number {
  return (weekday + 6) % 7;
}

export function renderRhythmSvg(heatmap: RhythmHeatmap): string {
  // 稀疏 cells → zero-fill 成 7×24。
  const grid: number[][] = Array.from({ length: ROWS }, () =>
    new Array<number>(COLS).fill(0)
  );
  for (const cell of heatmap.cells) {
    const row = mondayRow(cell.weekday);
    if (row < 0 || row >= ROWS || cell.hour < 0 || cell.hour >= COLS) continue;
    grid[row][cell.hour] = cell.count;
  }

  const rects: string[] = [];
  for (let r = 0; r < ROWS; r++) {
    for (let h = 0; h < COLS; h++) {
      const x = GRID_X + h * STEP;
      const y = GRID_Y + r * STEP;
      const fill = LEVEL_COLORS[colorLevel(grid[r][h], heatmap.maxCount)];
      rects.push(
        `<rect x="${x}" y="${y}" width="${CELL}" height="${CELL}" rx="2" fill="${fill}"/>`
      );
    }
  }

  const dayLabels = DAY_LABELS.map((d, r) => {
    const y = GRID_Y + r * STEP + CELL / 2;
    return `<text x="${GRID_X - 8}" y="${y}" text-anchor="end" dominant-baseline="central">${d}</text>`;
  });

  const hourLabels: string[] = [];
  for (let h = 0; h < COLS; h += 4) {
    const x = GRID_X + h * STEP + CELL / 2;
    hourLabels.push(
      `<text x="${x}" y="${GRID_Y - 6}" text-anchor="middle">${h}</text>`
    );
  }

  const peakStr = heatmap.peak
    ? `峰值 周${WEEKDAY_ZH[heatmap.peak.weekday] ?? "?"} ${String(
        heatmap.peak.hour
      ).padStart(2, "0")}:00`
    : "暂无数据";
  const footer = `共 ${heatmap.total} 次 · ${peakStr} · 截至 ${heatmap.generatedAt.slice(
    0,
    10
  )}`;

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}" role="img" aria-label="AI coding 作息热力图">`,
    `<rect x="0.5" y="0.5" width="${WIDTH - 1}" height="${HEIGHT - 1}" rx="8" fill="#ffffff" stroke="#d0d7de"/>`,
    `<g font-family='${FONT}'>`,
    `<text x="${PAD}" y="${PAD + 16}" font-size="15" font-weight="600" fill="#1f2328">AI coding 作息热力图</text>`,
    `<g font-size="10" fill="#656d76">${hourLabels.join("")}${dayLabels.join("")}</g>`,
    rects.join(""),
    `<text x="${PAD}" y="${HEIGHT - PAD + 2}" font-size="11" fill="#656d76">${footer}</text>`,
    `</g>`,
    `</svg>`,
  ].join("");
}
