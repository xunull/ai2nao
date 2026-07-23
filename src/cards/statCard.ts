/**
 * 通用「数字卡」原语:标题 + 可选大数字(带小注)+ 若干 label/value 行 + footer。
 * streak / records / ai-tools / token 四张卡都用它,各自把数据塞成 StatCardInput。
 *
 * 约束同 rhythm/calendar 卡:无 <style>/外链、样式全走 presentation 属性、自带不透明
 * 浅色底(GitHub camo/暗色安全)。见 20260723-design-card-bundle.md。
 */
import { escapeXml } from "./svgUtil.js";

export type StatCardStat = { label: string; value: string };
export type StatCardInput = {
  title: string;
  /** 可选大数字(hero)。value 是格式化好的字符串,caption 是其下的小注。 */
  big?: { value: string; caption?: string };
  stats: StatCardStat[];
  footer: string;
  /** 大数字颜色,默认 GitHub 绿。 */
  accent?: string;
};

const WIDTH = 260;
const PAD = 16;
const TITLE_H = 30;
const ROW_H = 24;
const FONT =
  '-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif';

export function renderStatCard(input: StatCardInput): string {
  const accent = input.accent ?? "#216e39";
  const bigH = input.big ? (input.big.caption ? 58 : 44) : 0;

  const yAfterTitle = PAD + TITLE_H; // 46
  const yStats = yAfterTitle + bigH;
  const yAfterStats = yStats + input.stats.length * ROW_H;
  const footerY = yAfterStats + 16;
  const height = footerY + PAD - 4;

  const body: string[] = [];

  body.push(
    `<text x="${PAD}" y="${PAD + 15}" font-size="15" font-weight="600" fill="#1f2328">${escapeXml(
      input.title
    )}</text>`
  );

  if (input.big) {
    body.push(
      `<text x="${PAD}" y="${yAfterTitle + 34}" font-size="34" font-weight="700" fill="${accent}">${escapeXml(
        input.big.value
      )}</text>`
    );
    if (input.big.caption) {
      body.push(
        `<text x="${PAD}" y="${yAfterTitle + 50}" font-size="11" fill="#656d76">${escapeXml(
          input.big.caption
        )}</text>`
      );
    }
  }

  // 大数字与 stats 之间的细分隔线(仅两者都在时)。
  if (input.big && input.stats.length > 0) {
    body.push(
      `<line x1="${PAD}" y1="${yStats - 6}" x2="${WIDTH - PAD}" y2="${yStats - 6}" stroke="#eaeef2"/>`
    );
  }

  input.stats.forEach((s, i) => {
    const y = yStats + i * ROW_H + 15;
    body.push(
      `<text x="${PAD}" y="${y}" font-size="12" fill="#656d76">${escapeXml(s.label)}</text>`,
      `<text x="${WIDTH - PAD}" y="${y}" text-anchor="end" font-size="12.5" font-weight="600" fill="#1f2328">${escapeXml(
        s.value
      )}</text>`
    );
  });

  body.push(
    `<text x="${PAD}" y="${footerY}" font-size="11" fill="#656d76">${escapeXml(input.footer)}</text>`
  );

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${height}" viewBox="0 0 ${WIDTH} ${height}" role="img" aria-label="${escapeXml(
      input.title
    )}">`,
    `<rect x="0.5" y="0.5" width="${WIDTH - 1}" height="${height - 1}" rx="8" fill="#ffffff" stroke="#d0d7de"/>`,
    `<g font-family='${FONT}'>`,
    body.join(""),
    `</g>`,
    `</svg>`,
  ].join("");
}
