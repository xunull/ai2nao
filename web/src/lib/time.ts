/**
 * Relative-time label for an ISO timestamp, e.g. "今天" / "3 天前" / "2 个月前".
 * Returns "—" for null/empty. Shared by GithubRepoCard and the Claude project list.
 */
export function formatRelative(iso: string | null): string {
  if (!iso) return "—";
  const then = new Date(iso).getTime();
  const now = Date.now();
  const days = Math.floor((now - then) / (1000 * 60 * 60 * 24));
  if (days < 1) return "今天";
  if (days < 30) return `${days} 天前`;
  if (days < 365) return `${Math.floor(days / 30)} 个月前`;
  return `${Math.floor(days / 365)} 年前`;
}
