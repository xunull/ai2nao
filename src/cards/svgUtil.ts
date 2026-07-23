/**
 * 卡片渲染共用小工具。所有进入 SVG 的动态文本(工具名、命令名等用户/机器数据)
 * 必须先 escapeXml,否则 & < > 会破坏 SVG。
 */

/** XML/SVG 转义:文本内容与属性值都安全。 */
export function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** 截断到 max 个字符,超出用 … 结尾(避免长名撑破卡片)。 */
export function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}

/** token/次数等大数的紧凑格式:18.6B、1.2M、12.3k、999。含缓存重放的 token 可达十亿级。 */
export function formatCompact(n: number): string {
  if (n >= 1_000_000_000_000) return (n / 1_000_000_000_000).toFixed(1) + "T";
  if (n >= 1_000_000_000) return (n / 1_000_000_000).toFixed(1) + "B";
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "k";
  return String(n);
}
