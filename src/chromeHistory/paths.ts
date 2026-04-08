import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Ordered list of Chromium-family `History` paths for a profile (e.g. `Default`).
 * Google Chrome is first so dual-install users sync the browser they likely mean.
 */
export function chromeHistoryPathCandidates(profile: string): string[] {
  const h = homedir();
  if (process.platform === "darwin") {
    return [
      join(h, "Library/Application Support/Google/Chrome", profile, "History"),
      join(h, "Library/Application Support/Arc/User Data", profile, "History"),
      join(
        h,
        "Library/Application Support/BraveSoftware/Brave-Browser",
        profile,
        "History"
      ),
      join(h, "Library/Application Support/Chromium", profile, "History"),
      join(h, "Library/Application Support/Microsoft Edge", profile, "History"),
    ];
  }
  if (process.platform === "win32") {
    const local = process.env.LOCALAPPDATA;
    if (!local) return [];
    return [
      join(local, "Google", "Chrome", "User Data", profile, "History"),
      join(local, "Microsoft", "Edge", "User Data", profile, "History"),
      join(local, "BraveSoftware", "Brave-Browser", profile, "History"),
      join(local, "Chromium", "User Data", profile, "History"),
    ];
  }
  if (process.platform === "linux") {
    return [
      join(h, ".config/google-chrome", profile, "History"),
      join(h, ".config/BraveSoftware/Brave-Browser", profile, "History"),
      join(h, ".config/chromium", profile, "History"),
      join(h, ".config/microsoft-edge", profile, "History"),
    ];
  }
  return [];
}

/**
 * Prefer an on-disk `History` from {@link chromeHistoryPathCandidates}.
 * If several Chromium-family browsers are installed, picks the file with the newest
 * `mtime` so the actively used profile is more likely to win (e.g. Arc vs idle Chrome).
 * If none exist yet, returns the first candidate (Google Chrome) for UI / error text.
 */
export function defaultChromeHistoryPath(
  profile: string = "Default"
): string | null {
  if (!isChromeHistoryIndexingSupported()) return null;
  const c = chromeHistoryPathCandidates(profile);
  if (c.length === 0) return null;
  const existing = c.filter((p) => existsSync(p));
  if (existing.length === 0) return c[0]!;
  let best = existing[0]!;
  let bestM = statSync(best).mtimeMs;
  for (let i = 1; i < existing.length; i++) {
    const p = existing[i]!;
    const m = statSync(p).mtimeMs;
    if (m > bestM) {
      best = p;
      bestM = m;
    }
  }
  return best;
}

export function isChromeHistoryIndexingSupported(): boolean {
  return (
    process.platform === "darwin" ||
    process.platform === "win32" ||
    process.platform === "linux"
  );
}
