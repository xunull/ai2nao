import { accessSync, constants, existsSync, realpathSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";

const DEFAULT_BREW_PATHS = ["/opt/homebrew/bin/brew", "/usr/local/bin/brew"];

export function findBrewExecutable(envPath = process.env.PATH ?? ""): string | null {
  for (const p of pathCandidates(envPath)) {
    if (isExecutableFile(p)) return realpathSync(p);
  }
  return null;
}

export function validateCliBrewPath(path: string): string {
  if (!isAbsolute(path)) throw new Error("brew path must be absolute");
  if (!isExecutableFile(path)) throw new Error(`brew path is not executable: ${path}`);
  return realpathSync(path);
}

export function isApiAllowedBrewPath(path: string): boolean {
  if (!isExecutableFile(path)) return false;
  const real = realpathSync(path);
  return DEFAULT_BREW_PATHS.some((p) => existsSync(p) && realpathSync(p) === real);
}

function pathCandidates(envPath: string): string[] {
  const fromPath = envPath
    .split(delimiter)
    .filter(Boolean)
    .map((p) => join(p, "brew"));
  return [...fromPath, ...DEFAULT_BREW_PATHS];
}

function isExecutableFile(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
