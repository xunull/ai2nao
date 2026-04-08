import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Default path to Chrome's `History` SQLite for a profile folder name (e.g. `Default`, `Profile 1`).
 * Returns `null` on unsupported platforms.
 */
export function defaultChromeHistoryPath(
  profile: string = "Default"
): string | null {
  if (process.platform === "darwin") {
    return join(
      homedir(),
      "Library/Application Support/Google/Chrome",
      profile,
      "History"
    );
  }
  if (process.platform === "win32") {
    const local = process.env.LOCALAPPDATA;
    if (!local) return null;
    return join(local, "Google", "Chrome", "User Data", profile, "History");
  }
  if (process.platform === "linux") {
    return join(homedir(), ".config/google-chrome", profile, "History");
  }
  return null;
}

export function isChromeHistoryIndexingSupported(): boolean {
  return (
    process.platform === "darwin" ||
    process.platform === "win32" ||
    process.platform === "linux"
  );
}
