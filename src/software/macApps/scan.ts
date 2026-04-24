import { readdirSync, statSync, type Dirent } from "node:fs";
import { join, resolve } from "node:path";
import { readInfoPlist, plistToMacAppRecord, type MacAppRecord } from "./plist.js";
import type { SoftwareWarning } from "../types.js";

export type ScanMacAppsOptions = {
  readInfo?: typeof readInfoPlist;
};

export type ScanMacAppsResult = {
  roots: string[];
  apps: MacAppRecord[];
  warnings: SoftwareWarning[];
};

const MAX_DEPTH = 4;

export async function scanMacApps(
  rootsInput: string[],
  opts: ScanMacAppsOptions = {}
): Promise<ScanMacAppsResult> {
  const roots = rootsInput.map((r) => resolve(r));
  const warnings: SoftwareWarning[] = [];
  const apps: MacAppRecord[] = [];
  const readInfo = opts.readInfo ?? readInfoPlist;

  for (const root of roots) {
    let appPaths: string[];
    try {
      appPaths = findAppBundles(root);
    } catch (e) {
      warnings.push({
        code: "root_unreadable",
        path: root,
        message: e instanceof Error ? e.message : String(e),
      });
      continue;
    }
    for (const appPath of appPaths) {
      const infoPath = join(appPath, "Contents", "Info.plist");
      try {
        const plist = await readInfo(infoPath);
        apps.push(plistToMacAppRecord(appPath, root, plist));
      } catch (e) {
        warnings.push({
          code: "plist_unreadable",
          path: infoPath,
          message: e instanceof Error ? e.message : String(e),
        });
      }
    }
  }

  return { roots, apps, warnings };
}

function findAppBundles(root: string): string[] {
  const out: string[] = [];
  const rootAbs = resolve(root);
  statSync(rootAbs);

  function walk(dir: string, depth: number): void {
    if (depth > MAX_DEPTH) return;
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      throw new Error(`cannot read directory ${dir}: ${String(e)}`);
    }
    for (const ent of entries) {
      const full = join(dir, ent.name);
      if (ent.isSymbolicLink()) continue;
      if (!ent.isDirectory()) continue;
      if (ent.name.endsWith(".app")) {
        out.push(full);
        continue;
      }
      walk(full, depth + 1);
    }
  }

  walk(rootAbs, 0);
  return out;
}
