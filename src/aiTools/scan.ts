/**
 * AI 工具扫描管线。设计 §4:**不重扫磁盘**,直接读现有清点表(mac_apps / brew_packages)
 * 对指纹库匹配,外加 PATH 盲区探测器;幂等 upsert + 软删除(见 store.ts)。
 *
 * F4 时序:ai_tools 派生自 mac_apps/brew,故本任务应排在 software 扫描之后(靠调度 cadence,
 * 最终一致);源为空时只是少检测出桌面 app,PATH 探测器仍可独立工作。
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import {
  finishInventorySyncRun,
  startInventorySyncRun,
} from "../localInventory/syncRuns.js";
import { setInventorySyncStateValue } from "../localInventory/state.js";
import type { SyncCounts } from "../localInventory/types.js";
import { AI_TOOL_REGISTRY } from "./registry.js";
import { upsertAiTools } from "./store.js";
import type { AiToolFingerprint, DetectedAiTool } from "./types.js";

export type ScanAiToolsOptions = {
  /** 覆盖 PATH 探测的候选目录(测试注入假目录用)。默认取 $PATH + 常见 bin。 */
  pathDirs?: string[];
  registry?: AiToolFingerprint[];
  now?: () => Date;
};

export type ScanAiToolsResult = SyncCounts & {
  ok: boolean;
  status: "success" | "failed";
  warnings: unknown[];
  errorSummary?: string | null;
  runId: number;
};

type MacAppRow = {
  bundle_id: string | null;
  name: string;
  path: string;
  version: string | null;
  short_version: string | null;
};

type BrewRow = { kind: string; name: string; installed_version: string | null };

/** mac_apps:逐行对指纹库匹配,命中即产出 desktop-app / local-runtime 证据行。 */
function matchMacApps(
  db: Database.Database,
  registry: AiToolFingerprint[]
): DetectedAiTool[] {
  const rows = db
    .prepare(
      "SELECT bundle_id, name, path, version, short_version FROM mac_apps WHERE missing_since IS NULL"
    )
    .all() as MacAppRow[];
  const out: DetectedAiTool[] = [];
  for (const row of rows) {
    for (const fp of registry) {
      const hit =
        (fp.macBundleId != null && row.bundle_id === fp.macBundleId) ||
        (fp.macBundleIdPrefix != null &&
          row.bundle_id != null &&
          row.bundle_id.startsWith(fp.macBundleIdPrefix)) ||
        (fp.macNameExact != null && row.name === fp.macNameExact);
      if (!hit) continue;
      out.push({
        toolKey: fp.toolKey,
        name: fp.name,
        kind: fp.kind,
        vendor: fp.vendor ?? null,
        detectSource: "mac_apps",
        // 稳定证据键:优先 bundle_id(路径无关),回落 name。绝不用 path(F3)。
        evidence: row.bundle_id ?? row.name,
        version: row.short_version ?? row.version,
        installPath: row.path,
      });
      break; // 一个 app 只归一个工具(registry 设计上不重叠)。
    }
  }
  return out;
}

/** brew_packages:formula/cask 名精确匹配指纹库。 */
function matchBrew(
  db: Database.Database,
  registry: AiToolFingerprint[]
): DetectedAiTool[] {
  const rows = db
    .prepare(
      "SELECT kind, name, installed_version FROM brew_packages WHERE missing_since IS NULL"
    )
    .all() as BrewRow[];
  const out: DetectedAiTool[] = [];
  for (const row of rows) {
    for (const fp of registry) {
      const hit =
        (row.kind === "formula" && fp.brewFormula === row.name) ||
        (row.kind === "cask" && fp.brewCask === row.name);
      if (!hit) continue;
      out.push({
        toolKey: fp.toolKey,
        name: fp.name,
        kind: fp.kind,
        vendor: fp.vendor ?? null,
        detectSource: "brew",
        evidence: row.name, // formula/cask 名,稳定。
        version: row.installed_version,
        installPath: null,
      });
      break;
    }
  }
  return out;
}

function defaultPathDirs(): string[] {
  const fromEnv = (process.env.PATH ?? "").split(":").filter(Boolean);
  const home = homedir();
  const extra = [join(home, ".bun", "bin"), join(home, ".local", "bin")];
  return [...new Set([...fromEnv, ...extra])];
}

/** PATH 盲区探测器:mac_apps/brew 抓不到的、npm 全局/裸装的 AI CLI。 */
function detectPathBinaries(
  registry: AiToolFingerprint[],
  pathDirs: string[]
): DetectedAiTool[] {
  const out: DetectedAiTool[] = [];
  for (const fp of registry) {
    if (!fp.binaries?.length) continue;
    for (const bin of fp.binaries) {
      let found: string | null = null;
      for (const dir of pathDirs) {
        const p = join(dir, bin);
        if (existsSync(p)) {
          found = p;
          break;
        }
      }
      if (!found) continue;
      out.push({
        toolKey: fp.toolKey,
        name: fp.name,
        kind: fp.kind,
        vendor: fp.vendor ?? null,
        detectSource: "path",
        evidence: bin, // 二进制名,稳定;实际路径进 installPath(可变)。
        version: null, // v1 不跑 `--version`(重且脆)。
        installPath: found,
      });
    }
  }
  return out;
}

export function scanAiTools(
  db: Database.Database,
  opts: ScanAiToolsOptions = {}
): ScanAiToolsResult {
  const now = opts.now ?? (() => new Date());
  const registry = opts.registry ?? AI_TOOL_REGISTRY;
  const pathDirs = opts.pathDirs ?? defaultPathDirs();
  const runId = startInventorySyncRun(db, "ai_tools", {}, now());
  try {
    const detected = [
      ...matchMacApps(db, registry),
      ...matchBrew(db, registry),
      ...detectPathBinaries(registry, pathDirs),
    ];
    const counts = upsertAiTools(db, detected, now().toISOString());
    finishInventorySyncRun(db, runId, {
      status: "success",
      ...counts,
      warningsCount: 0,
      now: now(),
    });
    setInventorySyncStateValue(db, "ai_tools.last_sync_at", now().toISOString());
    return { ok: true, status: "success", ...counts, warnings: [], runId };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    finishInventorySyncRun(db, runId, {
      status: "failed",
      inserted: 0,
      updated: 0,
      markedMissing: 0,
      warningsCount: 0,
      errorSummary: message,
      now: now(),
    });
    setInventorySyncStateValue(db, "ai_tools.last_sync_error", message);
    return {
      ok: false,
      status: "failed",
      inserted: 0,
      updated: 0,
      markedMissing: 0,
      warnings: [],
      errorSummary: message,
      runId,
    };
  }
}
