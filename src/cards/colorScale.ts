/**
 * 卡片共用的 5 档配色标度(GitHub 贡献图绿)。rhythm 卡与 calendar 卡共用,一处维护。
 */

/** 5 档颜色,index 0 = 空格。 */
export const LEVEL_COLORS = ["#ebedf0", "#9be9a8", "#40c463", "#30a14e", "#216e39"];

/** count → 档位 0..4,基于 maxCount 的四分位。确定性、防除零。 */
export function colorLevel(count: number, maxCount: number): number {
  if (count <= 0 || maxCount <= 0) return 0;
  const r = count / maxCount;
  if (r <= 0.25) return 1;
  if (r <= 0.5) return 2;
  if (r <= 0.75) return 3;
  return 4;
}
