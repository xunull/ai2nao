import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** macOS / Windows only for v1 default. */
export function isDownloadsIndexingSupported(): boolean {
  const p = process.platform;
  return p === "darwin" || p === "win32";
}

/**
 * Default `~/Downloads` roots (absolute, normalized). Empty on unsupported platforms.
 */
export function defaultDownloadRoots(): string[] {
  if (!isDownloadsIndexingSupported()) return [];
  return [resolve(join(homedir(), "Downloads"))];
}
