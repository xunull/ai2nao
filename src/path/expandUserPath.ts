import { homedir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Resolve a path the way users expect: `~/foo` → under home, not a literal `~/` segment in cwd.
 * Does not support `~otheruser` (pass-through to `resolve`).
 */
export function expandUserPath(p: string): string {
  const t = p.trim();
  if (t.length === 0) return t;
  if (t === "~") {
    return homedir();
  }
  if (t.startsWith("~/") || t.startsWith("~\\")) {
    return resolve(join(homedir(), t.slice(2)));
  }
  return resolve(t);
}
