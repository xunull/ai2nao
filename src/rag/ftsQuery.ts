/**
 * Build an FTS5 MATCH query from user text (token OR token).
 * Escapes double quotes for safety.
 */
export function fts5FromUserQuery(q: string): string {
  const tokens = q
    .trim()
    .split(/\s+/)
    .filter((t) => t.length > 0);
  if (tokens.length === 0) return '""';
  return tokens
    .map((t) => {
      const safe = t.replace(/"/g, '""');
      return `"${safe}"`;
    })
    .join(" OR ");
}
