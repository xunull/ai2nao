import { existsSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join, resolve } from "node:path";

export function isMacAppInventorySupported(): boolean {
  return platform() === "darwin";
}

export function defaultMacAppRoots(): string[] {
  if (!isMacAppInventorySupported()) return [];
  return ["/Applications", join(homedir(), "Applications"), "/System/Applications"]
    .map((p) => resolve(p))
    .filter((p) => existsSync(p));
}
