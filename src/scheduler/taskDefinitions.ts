import { resolve } from "node:path";
import { defaultChromeHistoryPath } from "../chromeHistory/paths.js";
import { rebuildChromeHistoryVisitDomains } from "../chromeHistory/domainPivot.js";
import { syncChromeHistory } from "../chromeHistory/sync.js";
import { defaultDownloadRoots } from "../downloads/roots.js";
import { scanDownloads } from "../downloads/scan.js";
import { syncHuggingfaceModels } from "../huggingface/sync.js";
import { syncLmStudioModels } from "../lmstudio/sync.js";
import { rebuildDirectoryActivity } from "../atuin/directoryActivity/rebuild.js";
import { refreshClaudeTokenUsage } from "../claudeTokenUsage/refresh.js";
import { refreshCodexTokenUsage } from "../codexTokenUsage/refresh.js";
import { syncModelPrices } from "../cost/modelsDevSync.js";
import { refreshCosmos } from "../workCosmos/refresh.js";
import { refreshWorkDuration } from "../workDuration/refresh.js";
import { syncBrewPackages } from "../software/brew/sync.js";
import { syncMacApps } from "../software/macApps/sync.js";
import { syncVscodeRecent } from "../vscode/sync.js";
import type {
  ScheduledTaskDefinition,
  ScheduledTaskRunResult,
} from "./types.js";

const fiveMinutes = 5 * 60;
const oneHour = 60 * 60;
const sixHours = 6 * oneHour;
const oneDay = 24 * oneHour;

export function createDefaultScheduledTaskDefinitions(): ScheduledTaskDefinition[] {
  return [
    {
      key: "downloads.scan",
      label: "下载目录扫描",
      description: "扫描本机下载文件夹并写入 download_files。",
      category: "local_inventory",
      defaultIntervalSeconds: fiveMinutes,
      sensitivity: "medium",
      run: (ctx) => {
        const roots = stringArrayConfig(ctx.config.roots) ?? defaultDownloadRoots();
        if (roots.length === 0) {
          return skipped("no download roots configured");
        }
        const result = scanDownloads(ctx.db, roots);
        return Promise.resolve({
          status: result.errors.length > 0 ? "partial" : "success",
          summary: result,
          errorSummary: result.errors[0] ?? null,
        });
      },
    },
    {
      key: "mac_apps.sync",
      label: "Mac 应用同步",
      description: "扫描 macOS 应用目录并同步应用清单。",
      category: "local_inventory",
      defaultIntervalSeconds: oneDay,
      sensitivity: "low",
      run: async (ctx) => {
        const roots = stringArrayConfig(ctx.config.roots);
        return inventoryResult(await syncMacApps(ctx.db, roots ? { roots } : {}));
      },
    },
    {
      key: "brew.sync",
      label: "Homebrew 同步",
      description: "读取 Homebrew formula 和 cask 清单。",
      category: "local_inventory",
      defaultIntervalSeconds: oneDay,
      sensitivity: "low",
      run: async (ctx) => {
        const brewPath = stringConfig(ctx.config.brewPath);
        return inventoryResult(await syncBrewPackages(ctx.db, { brewPath, allowCustomBrewPath: Boolean(brewPath) }));
      },
    },
    {
      key: "huggingface.models.sync",
      label: "Hugging Face 模型同步",
      description: "扫描 Hugging Face Hub 本地 cache。",
      category: "model_cache",
      defaultIntervalSeconds: sixHours,
      sensitivity: "low",
      run: (ctx) =>
        Promise.resolve(
          inventoryResult(syncHuggingfaceModels(ctx.db, { root: stringConfig(ctx.config.root) }))
        ),
    },
    {
      key: "lmstudio.models.sync",
      label: "LM Studio 模型同步",
      description: "扫描 LM Studio 本地模型目录。",
      category: "model_cache",
      defaultIntervalSeconds: sixHours,
      sensitivity: "low",
      run: (ctx) =>
        Promise.resolve(
          inventoryResult(syncLmStudioModels(ctx.db, { root: stringConfig(ctx.config.root) }))
        ),
    },
    {
      key: "vscode.recent.sync",
      label: "VS Code 最近项目同步",
      description: "读取 VS Code state.vscdb 中的最近项目、文件和 workspace。",
      category: "editor",
      defaultIntervalSeconds: oneHour,
      sensitivity: "high",
      run: (ctx) => Promise.resolve(editorResult(syncVscodeRecent(ctx.db, { app: "code" }))),
    },
    {
      key: "cursor.projects.sync",
      label: "Cursor 项目同步",
      description: "读取 Cursor state.vscdb 中的最近项目。",
      category: "editor",
      defaultIntervalSeconds: oneHour,
      sensitivity: "high",
      run: (ctx) => Promise.resolve(editorResult(syncVscodeRecent(ctx.db, { app: "cursor" }))),
    },
    {
      key: "chrome.history.sync",
      label: "Chrome 历史同步",
      description: "同步 Chrome visits/downloads，并刷新 domain pivot 状态。",
      category: "browser",
      defaultIntervalSeconds: fiveMinutes,
      sensitivity: "high",
      defaultConfig: { profile: "Default" },
      run: (ctx) => {
        const profile = stringConfig(ctx.config.profile) ?? "Default";
        const historyPath = stringConfig(ctx.config.historyPath)
          ? resolve(stringConfig(ctx.config.historyPath) as string)
          : defaultChromeHistoryPath(profile);
        if (!historyPath) {
          return skipped("no default Chrome History path on this platform");
        }
        const result = syncChromeHistory(ctx.db, historyPath, profile);
        return Promise.resolve({
          status: result.errors.length > 0 ? "partial" : "success",
          summary: {
            profile,
            historyPath,
            insertedVisits: result.insertedVisits,
            skippedVisits: result.skippedVisits,
            insertedDownloads: result.insertedDownloads,
            skippedDownloads: result.skippedDownloads,
            domainRebuild: result.domainRebuild,
            errors: result.errors,
          },
          errorSummary: result.errors[0] ?? null,
        });
      },
    },
    {
      key: "chrome.domains.rebuild",
      label: "Chrome 域名重建",
      description: "重建 Chrome History domain pivot 派生表。",
      category: "derived",
      defaultIntervalSeconds: oneHour,
      sensitivity: "high",
      defaultConfig: { profile: "Default" },
      run: (ctx) => {
        const profile = stringConfig(ctx.config.profile) ?? "Default";
        const result = rebuildChromeHistoryVisitDomains(ctx.db, profile);
        return Promise.resolve({
          status: result.ok ? "success" : "failed",
          summary: result,
          errorSummary: result.error ?? null,
        });
      },
    },
    {
      key: "atuin.directories.rebuild",
      label: "Atuin 目录活动重建",
      description: "从只读 Atuin history.db 重建目录活动派生表。",
      category: "derived",
      defaultIntervalSeconds: oneHour,
      sensitivity: "high",
      run: (ctx) => {
        if (!ctx.atuin) return skipped("Atuin history not configured");
        const result = rebuildDirectoryActivity({
          indexDb: ctx.db,
          atuinDb: ctx.atuin.db,
        });
        return Promise.resolve({
          status: result.ok ? "success" : "failed",
          summary: { atuinPath: ctx.atuin.path, ...result },
          errorSummary: result.error ?? null,
        });
      },
    },
    {
      key: "codex.tokens.refresh",
      label: "Codex token 统计刷新",
      description: "扫描 Codex rollout JSONL 并刷新项目级真实 token 派生索引。",
      category: "derived",
      defaultIntervalSeconds: oneHour,
      sensitivity: "high",
      run: async (ctx) => {
        const full = Boolean(ctx.config.full);
        const result = await refreshCodexTokenUsage(ctx.db, { full });
        return {
          status: result.status,
          summary: result,
          errorSummary: result.errors[0] ?? null,
        };
      },
    },
    {
      key: "work.tokens.refresh",
      label: "工作项目统计刷新",
      description: "刷新 Claude Code 与 Codex 项目级真实 token 和活跃时长派生索引。",
      category: "derived",
      defaultIntervalSeconds: oneHour,
      sensitivity: "high",
      run: async (ctx) => {
        const full = Boolean(ctx.config.full);
        const codex = await refreshCodexTokenUsage(ctx.db, { full });
        const claude = await refreshClaudeTokenUsage(ctx.db, { full });
        const duration = await refreshWorkDuration(ctx.db, { full });
        const status =
          codex.status === "failed" || claude.status === "failed" || duration.status === "failed"
            ? "failed"
            : codex.status === "partial" || claude.status === "partial" || duration.status === "partial"
              ? "partial"
              : "success";
        return {
          status,
          summary: { codex, claude, duration },
          errorSummary: codex.errors[0] ?? claude.errors[0] ?? duration.errors[0] ?? null,
        };
      },
    },
    {
      // Activity Cosmos refresh. Default disabled so a fresh install doesn't
      // hit DashScope without user opt-in; user clicks the in-page refresh
      // button (which calls scheduler.runNow) to populate.
      key: "work.cosmos.refresh",
      label: "对话宇宙刷新",
      description: "重算 /dashboard/cosmos 散点：summary → embedding → UMAP 投影。",
      category: "derived",
      defaultIntervalSeconds: sixHours,
      sensitivity: "high",
      run: async (ctx) => {
        const full = Boolean(ctx.config.full);
        const result = await refreshCosmos(ctx.db, { full });
        return {
          status: result.status,
          summary: result,
          errorSummary: result.errors[0] ?? null,
        };
      },
    },
    {
      // Model price sync. Default disabled (all tasks seed disabled) so a fresh
      // install doesn't hit the network until the user enables it. Fetches
      // models.dev/api.json and refreshes anthropic+openai prices for the USD
      // cost view; failure leaves the last synced prices in place.
      key: "model.prices.sync",
      label: "模型价格同步",
      description:
        "从 models.dev 同步 Anthropic / OpenAI 模型单价（供 token 成本估算使用）。",
      category: "model_cache",
      defaultIntervalSeconds: 7 * oneDay,
      sensitivity: "low",
      run: async (ctx) => {
        const result = await syncModelPrices(ctx.db);
        return {
          status: result.status,
          summary: result,
          errorSummary: result.error ?? null,
        };
      },
    },
  ];
}

function inventoryResult(result: {
  ok: boolean;
  status: "success" | "partial" | "failed";
  inserted: number;
  updated: number;
  markedMissing: number;
  warnings: unknown[];
  errorSummary?: string | null;
}): ScheduledTaskRunResult {
  return {
    status: result.status,
    summary: {
      inserted: result.inserted,
      updated: result.updated,
      markedMissing: result.markedMissing,
      warningsCount: result.warnings.length,
      ok: result.ok,
    },
    errorSummary: result.errorSummary ?? null,
  };
}

function editorResult(result: {
  ok: boolean;
  status: "success" | "partial" | "failed";
  app: string;
  profile: string;
  sourcePath: string | null;
  inserted: number;
  updated: number;
  markedMissing: number;
  totalEntries: number;
  warnings: unknown[];
}): ScheduledTaskRunResult {
  return {
    status: result.status,
    summary: {
      ok: result.ok,
      app: result.app,
      profile: result.profile,
      sourcePath: result.sourcePath,
      inserted: result.inserted,
      updated: result.updated,
      markedMissing: result.markedMissing,
      totalEntries: result.totalEntries,
      warningsCount: result.warnings.length,
    },
    errorSummary: result.warnings[0]
      ? warningMessage(result.warnings[0])
      : null,
  };
}

function skipped(message: string): Promise<ScheduledTaskRunResult> {
  return Promise.resolve({
    status: "skipped",
    summary: { reason: message },
    errorSummary: message,
  });
}

function stringConfig(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function stringArrayConfig(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
  return items.length > 0 ? items : undefined;
}

function warningMessage(value: unknown): string | null {
  if (value && typeof value === "object" && "message" in value) {
    const message = (value as { message?: unknown }).message;
    return typeof message === "string" ? message : String(message);
  }
  return value == null ? null : String(value);
}
