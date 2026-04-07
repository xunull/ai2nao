/** Show last two path segments for dense display. */
export function shortPath(full: string): string {
  const norm = full.replace(/\\/g, "/").replace(/\/+$/, "");
  const parts = norm.split("/").filter(Boolean);
  if (parts.length <= 2) return parts.join("/") || full;
  return `…/${parts.slice(-2).join("/")}`;
}
