import { basename } from "node:path";
import { runBoundedCommand } from "../command.js";

export type AppInfoPlist = {
  CFBundleIdentifier?: unknown;
  CFBundleName?: unknown;
  CFBundleDisplayName?: unknown;
  CFBundleVersion?: unknown;
  CFBundleShortVersionString?: unknown;
  CFBundleExecutable?: unknown;
  LSApplicationCategoryType?: unknown;
  LSMinimumSystemVersion?: unknown;
};

export type MacAppRecord = {
  bundle_id: string | null;
  name: string;
  path: string;
  version: string | null;
  short_version: string | null;
  executable: string | null;
  bundle_name: string | null;
  bundle_display_name: string | null;
  minimum_system_version: string | null;
  category: string | null;
  source_root: string;
};

export async function readInfoPlist(
  infoPlistPath: string
): Promise<AppInfoPlist> {
  const result = await runBoundedCommand(
    "/usr/bin/plutil",
    ["-convert", "json", "-o", "-", infoPlistPath],
    { timeoutMs: 5_000, maxBuffer: 512 * 1024 }
  );
  return JSON.parse(result.stdout) as AppInfoPlist;
}

export function plistToMacAppRecord(
  appPath: string,
  sourceRoot: string,
  plist: AppInfoPlist
): MacAppRecord {
  const bundleName = asString(plist.CFBundleName);
  const displayName = asString(plist.CFBundleDisplayName);
  const fallback = basename(appPath).replace(/\.app$/i, "");
  return {
    bundle_id: asString(plist.CFBundleIdentifier),
    name: displayName ?? bundleName ?? fallback,
    path: appPath,
    version: asString(plist.CFBundleVersion),
    short_version: asString(plist.CFBundleShortVersionString),
    executable: asString(plist.CFBundleExecutable),
    bundle_name: bundleName,
    bundle_display_name: displayName,
    minimum_system_version: asString(plist.LSMinimumSystemVersion),
    category: asString(plist.LSApplicationCategoryType),
    source_root: sourceRoot,
  };
}

function asString(v: unknown): string | null {
  return typeof v === "string" && v.trim().length > 0 ? v : null;
}
