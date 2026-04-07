import { realpathSync } from "node:fs";
import { resolve } from "node:path";

export function canonicalizePath(
  inputPath: string,
  options?: { bestEffort?: boolean }
): string | null {
  const resolved = resolve(inputPath);
  try {
    return realpathSync(resolved);
  } catch {
    return options?.bestEffort ? resolved : null;
  }
}

