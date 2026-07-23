/**
 * 把 AI coding 活动渲成 GitHub 贡献图式日历 SVG(列=周/月份,行=星期几,每格=某一天)。
 * 与 rhythm 卡同款约束:无 <style>/外链、presentation 属性、自带浅色底(camo/暗色安全)。
 * 设计:~/.gstack/projects/xunull-ai2nao/20260722-design-profile-rhythm-card.md(第二张卡)
 */
import type { ActivityCalendar } from "../aiRhythm/queries.js";
import { LEVEL_COLORS, colorLevel } from "./colorScale.js";

const PAD = 16;
const TITLE_H = 26;
const MONTH_LABEL_H = 14;
const CELL = 11;
const GAP = 3;
const STEP = CELL + GAP; // 14
const WEEKDAY_W = 30;
const ROWS = 7;
const FOOTER_H = 20;

const FONT =
  '-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif';
/** 只标周一/三/五(GitHub 那样,减拥挤);key = 行号(0=周日..6=周六)。 */
const WEEKDAY_LABELS: Record<number, string> = { 1: "一", 3: "三", 5: "五" };

export function renderCalendarSvg(cal: ActivityCalendar): string {
  const cols = cal.weekCount;
  const gridX = PAD + WEEKDAY_W;
  const gridY = PAD + TITLE_H + MONTH_LABEL_H;
  const gridW = cols * STEP - GAP;
  const gridH = ROWS * STEP - GAP;
  const width = gridX + gridW + PAD;
  const height = gridY + gridH + FOOTER_H + PAD;

  const rects: string[] = [];
  for (let col = 0; col < cols; col++) {
    const week = cal.weeks[col];
    if (!week) continue;
    for (let row = 0; row < ROWS; row++) {
      const cell = week[row];
      if (!cell) continue; // 未来日,不画
      const x = gridX + col * STEP;
      const y = gridY + row * STEP;
      const fill = LEVEL_COLORS[colorLevel(cell.count, cal.maxCount)];
      rects.push(
        `<rect x="${x}" y="${y}" width="${CELL}" height="${CELL}" rx="2" fill="${fill}"/>`
      );
    }
  }

  const monthLabels = cal.monthLabels.map(
    ({ col, label }) =>
      `<text x="${gridX + col * STEP}" y="${gridY - 5}">${label}</text>`
  );
  const weekdayLabels = Object.entries(WEEKDAY_LABELS).map(([rowStr, label]) => {
    const y = gridY + Number(rowStr) * STEP + CELL / 2;
    return `<text x="${gridX - 6}" y="${y}" text-anchor="end" dominant-baseline="central">${label}</text>`;
  });

  const footer = `共 ${cal.total} 次 · 活跃 ${cal.activeDays} 天 · 近 ${cal.weekCount} 周 · 截至 ${cal.generatedAt.slice(
    0,
    10
  )}`;

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="AI coding 活动日历">`,
    `<rect x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" rx="8" fill="#ffffff" stroke="#d0d7de"/>`,
    `<g font-family='${FONT}'>`,
    `<text x="${PAD}" y="${PAD + 16}" font-size="15" font-weight="600" fill="#1f2328">AI coding 活动日历</text>`,
    `<g font-size="9" fill="#656d76">${monthLabels.join("")}${weekdayLabels.join("")}</g>`,
    rects.join(""),
    `<text x="${PAD}" y="${height - PAD + 2}" font-size="11" fill="#656d76">${footer}</text>`,
    `</g>`,
    `</svg>`,
  ].join("");
}
