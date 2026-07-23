/**
 * 命令 / 技能排行卡:最常用的斜杠命令 Top N,横条按榜首归一 + 次数标注。
 * 数据 = commandLeaderboard(cleaned_text LIKE '/%' 的 is_human 消息,已做路径守卫)。
 * 命令名是用户数据 → 必须 escapeXml。约束同其它卡。
 */
import type { CommandLeaderboard } from "../aiRhythm/queries.js";
import { escapeXml, truncate } from "./svgUtil.js";

const PAD = 16;
const TITLE_H = 30;
const ROW_H = 22;
const FOOTER_H = 18;
const WIDTH = 300;
const NAME_W = 96; // 左侧命令名列宽
const COUNT_W = 38; // 右侧次数列宽
const BAR_X = PAD + NAME_W + 8;
const BAR_MAX_W = WIDTH - PAD - COUNT_W - BAR_X;
const BAR_H = 12;
const FONT =
  '-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif';

export function renderLeaderboardSvg(board: CommandLeaderboard): string {
  const cmds = board.commands.slice(0, 8);
  const maxCount = board.maxCount || 1;
  const yRowsTop = PAD + TITLE_H;
  const yFooter = yRowsTop + cmds.length * ROW_H + FOOTER_H;
  const height = yFooter + 6;

  const rows: string[] = [];
  cmds.forEach((cmd, i) => {
    const baseline = yRowsTop + i * ROW_H + 15;
    const barW = Math.max(2, Math.round((cmd.count / maxCount) * BAR_MAX_W));
    const barY = baseline - 11;
    rows.push(
      `<text x="${PAD}" y="${baseline}" font-size="12" fill="#1f2328">/${escapeXml(
        truncate(cmd.name, 12)
      )}</text>`,
      `<rect x="${BAR_X}" y="${barY}" width="${barW}" height="${BAR_H}" rx="2" fill="#40c463"/>`,
      `<text x="${WIDTH - PAD}" y="${baseline}" text-anchor="end" font-size="11.5" font-weight="600" fill="#656d76">${cmd.count}</text>`
    );
  });

  const footer = `共 ${board.totalCommands} 次调用 · ${board.distinctCommands} 个命令 · 截至 ${board.generatedAt.slice(
    0,
    10
  )}`;

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${height}" viewBox="0 0 ${WIDTH} ${height}" role="img" aria-label="命令 / 技能排行">`,
    `<rect x="0.5" y="0.5" width="${WIDTH - 1}" height="${height - 1}" rx="8" fill="#ffffff" stroke="#d0d7de"/>`,
    `<g font-family='${FONT}'>`,
    `<text x="${PAD}" y="${PAD + 15}" font-size="15" font-weight="600" fill="#1f2328">命令 / 技能排行</text>`,
    rows.join(""),
    `<text x="${PAD}" y="${yFooter}" font-size="11" fill="#656d76">${footer}</text>`,
    `</g>`,
    `</svg>`,
  ].join("");
}
