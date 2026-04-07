/** If `body` is valid JSON, return pretty-printed text; otherwise null. */
export function tryPrettyJson(body: string): string | null {
  const t = body.trim();
  if (!t.startsWith("{") && !t.startsWith("[")) return null;
  try {
    return JSON.stringify(JSON.parse(body), null, 2);
  } catch {
    return null;
  }
}
