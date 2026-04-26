import { realpath } from "node:fs/promises";
import { resolve, sep } from "node:path";

export function isPathInsideRoot(root: string, candidate: string): boolean {
  const base = resolve(root);
  const target = resolve(candidate);
  if (target === base) return true;
  const prefix = base.endsWith(sep) ? base : base + sep;
  return target.startsWith(prefix);
}

export async function assertRealPathInsideRoot(
  root: string,
  candidate: string
): Promise<string> {
  const realRoot = await realpath(root);
  const realCandidate = await realpath(candidate);
  if (!isPathInsideRoot(realRoot, realCandidate)) {
    throw new Error(`path escapes root: ${realCandidate}`);
  }
  return realCandidate;
}
