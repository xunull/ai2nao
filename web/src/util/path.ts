/** Show last two path segments for dense display. */
export function shortPath(full: string): string {
  const norm = full.replace(/\\/g, "/").replace(/\/+$/, "");
  const parts = norm.split("/").filter(Boolean);
  if (parts.length <= 2) return parts.join("/") || full;
  return `…/${parts.slice(-2).join("/")}`;
}

/**
 * 绝对路径 → project slug(与后端 src/agentUserMessages/projectKey.ts 的 slugFromPath
 * **同规则**:去尾斜杠 + 每个 `/` 换 `-`)。用于把仓库路径对到对话↔提交桥的 project_key。
 * 规则跟随 Claude Code 目录命名,稳定;若后端规则变,两处同步。
 */
export function projectKeyFromPath(absPath: string | null | undefined): string | null {
  if (!absPath) return null;
  const p = absPath.trim().replace(/\/+$/, "");
  if (!p || !p.startsWith("/")) return null;
  return p.replace(/\//g, "-");
}
