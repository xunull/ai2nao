/**
 * Resolve the configured default scan roots (Settings page → app_config.scan.roots)
 * AND re-validate them at use time. A stored root can be deleted or swapped after
 * it was saved, and discoverGitRepos returns [] for an invalid root — a silent
 * "scanned 0 repos" false success. So every consumer (the CLI default path and the
 * repos.scan scheduler task) must go through here.
 *
 * `state` makes the unconfigured case explicit: getScanRoots returns [] for BOTH
 * "nothing stored" and a corrupt/wrong-shape row, so callers can't infer intent
 * from an empty array alone.
 */
import { statSync } from "node:fs";
import type Database from "better-sqlite3";
import { getScanRoots } from "../appConfig/index.js";

export type SkippedRoot = { path: string; reason: "missing" | "not-a-directory" | "stat-error" };

export type ResolvedScanRoots = {
  configured: string[];
  valid: string[];
  skipped: SkippedRoot[];
  state: "unconfigured" | "resolved";
};

export function resolveScanRoots(db: Database.Database): ResolvedScanRoots {
  const configured = getScanRoots(db);
  if (configured.length === 0) {
    return { configured: [], valid: [], skipped: [], state: "unconfigured" };
  }
  const valid: string[] = [];
  const skipped: SkippedRoot[] = [];
  for (const path of configured) {
    let stat;
    try {
      stat = statSync(path);
    } catch (e) {
      const reason = (e as { code?: string })?.code === "ENOENT" ? "missing" : "stat-error";
      skipped.push({ path, reason });
      continue;
    }
    if (stat.isDirectory()) valid.push(path);
    else skipped.push({ path, reason: "not-a-directory" });
  }
  return { configured, valid, skipped, state: "resolved" };
}
