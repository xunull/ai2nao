import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Best-effort read of remote.origin.url from .git/config (no git binary required).
 */
export function readOriginUrl(repoRoot: string): string | null {
  const configPath = join(repoRoot, ".git", "config");
  let text: string;
  try {
    text = readFileSync(configPath, "utf8");
  } catch {
    return null;
  }
  return parseOriginUrlFromGitConfig(text);
}

export function parseOriginUrlFromGitConfig(text: string): string | null {
  const lines = text.split(/\r?\n/);
  let inOrigin = false;
  for (const line of lines) {
    const section = line.match(/^\s*\[remote\s+"([^"]+)"\]\s*$/);
    if (section) {
      inOrigin = section[1] === "origin";
      continue;
    }
    if (line.match(/^\s*\[/)) {
      inOrigin = false;
      continue;
    }
    if (inOrigin) {
      const m = line.match(/^\s*url\s*=\s*(.+)\s*$/);
      if (m) return m[1].trim();
    }
  }
  return null;
}
