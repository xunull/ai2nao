import { resolve } from "node:path";
import { defaultChromeHistoryPath } from "../chromeHistory/paths.js";
import { rebuildChromeHistoryVisitDomains } from "../chromeHistory/domainPivot.js";
import { rebuildChromeTopicStream, rebuildGitTopicStream } from "../topicStream/rebuild.js";
import { rebuildConversationTopicStream } from "../topicStream/conversation.js";
import { llmClusterNamer } from "../topicStream/conversationNaming.js";
import { runRecapPushTick } from "../workRecap/pushTick.js";
import { syncChromeHistory } from "../chromeHistory/sync.js";
import { defaultDownloadRoots } from "../downloads/roots.js";
import { scanDownloads } from "../downloads/scan.js";
import { syncHuggingfaceModels } from "../huggingface/sync.js";
import { syncLmStudioModels } from "../lmstudio/sync.js";
import { rebuildDirectoryActivity } from "../atuin/directoryActivity/rebuild.js";
import { refreshClaudeTokenUsage } from "../claudeTokenUsage/refresh.js";
import { refreshCodexTokenUsage } from "../codexTokenUsage/refresh.js";
import { syncModelPrices } from "../cost/modelsDevSync.js";
import { syncEnabledProviders } from "../providers/sync.js";
import { getProviderConfig, providerApiKey } from "../providers/store.js";
import { refreshMinimaxTokenUsage } from "../minimaxTokenUsage/refresh.js";
import { ingestOpencodeUserMessages } from "../agentUserMessages/opencodeIngest.js";
import { ingestClaudeUserMessages } from "../agentUserMessages/claudeIngest.js";
import { ingestCodexUserMessages } from "../agentUserMessages/codexIngest.js";
import { refreshCosmos } from "../workCosmos/refresh.js";
import { refreshWorkDuration } from "../workDuration/refresh.js";
import { syncAllReposChurn } from "../gitChurn/sync.js";
import { runScan } from "../scan/runScan.js";
import { resolveScanRoots } from "../scan/roots.js";
import { getScanMaxDepth, getScanMaxDocs, getScanConcurrency } from "../appConfig/index.js";
import { syncBrewPackages } from "../software/brew/sync.js";
import { syncMacApps } from "../software/macApps/sync.js";
import { scanAiTools } from "../aiTools/scan.js";
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
      key: "ai_tools.scan",
      label: "AI 工具清单扫描",
      description:
        "从 mac_apps/brew 识别 AI 工具 + PATH 探测 CLI/运行时,写入 ai_tools。派生任务,应排在软件扫描之后。",
      category: "local_inventory",
      defaultIntervalSeconds: sixHours,
      sensitivity: "low",
      run: (ctx) => Promise.resolve(inventoryResult(scanAiTools(ctx.db))),
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
      key: "topics.chrome.rebuild",
      label: "浏览主题河流重建",
      description: "重建 topic_stream 浏览主题河流派生表(会话切分 + 主题分类)。",
      category: "derived",
      defaultIntervalSeconds: oneHour,
      sensitivity: "high",
      defaultConfig: { profile: "Default" },
      run: (ctx) => {
        const profile = stringConfig(ctx.config.profile) ?? "Default";
        const result = rebuildChromeTopicStream(ctx.db, profile);
        return Promise.resolve({
          status: result.ok ? "success" : "failed",
          summary: result,
          errorSummary: result.error ?? null,
        });
      },
    },
    {
      key: "topics.git.rebuild",
      label: "提交主题河流重建",
      description: "重建 topic_stream 的 git 提交河流派生层(按 repo 出带)。",
      category: "derived",
      defaultIntervalSeconds: oneHour,
      sensitivity: "high",
      run: (ctx) => {
        const result = rebuildGitTopicStream(ctx.db);
        return Promise.resolve({
          status: result.ok ? "success" : "failed",
          summary: result,
          errorSummary: result.error ?? null,
        });
      },
    },
    {
      key: "recap.push.tick",
      label: "工作回看定时推送",
      description:
        "日历守卫:日报(每晚)/周报(每周一)到点且未发过则生成 work-recap 并推送飞书。" +
        "scheduler 是间隔式的,所以这个任务每 10 分钟跑一次、自己判断是否到点(漏了会补发)。" +
        "注意:命中时会做一次 git 扫描 + LLM 调用,约阻塞 scheduler 70 秒(每天最多两次)。" +
        "未配置 ~/.ai2nao/notify.json 时安静跳过。",
      category: "derived",
      defaultIntervalSeconds: 10 * 60,
      sensitivity: "high",
      run: async (ctx) => {
        const outcomes = await runRecapPushTick(ctx.db);
        const failed = outcomes.find((o) => o.action === "failed");
        return {
          status: failed ? "failed" : "success",
          summary: { outcomes },
          errorSummary: failed ? `${failed.kind}: ${failed.reason ?? "failed"}` : null,
        };
      },
    },
    {
      key: "topics.conversation.rebuild",
      label: "对话主题河流重建",
      description: "重建 topic_stream 的对话河流派生层(清洗用户消息 embedding + 冻结码本聚类)。",
      category: "derived",
      defaultIntervalSeconds: oneHour,
      sensitivity: "high",
      run: async (ctx) => {
        const result = await rebuildConversationTopicStream(ctx.db, { namer: llmClusterNamer });
        return {
          status: result.ok ? "success" : "failed",
          summary: result,
          errorSummary: result.error ?? null,
        };
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
      // Git line churn sync (project token-vs-output analysis). Default disabled
      // (all tasks seed disabled) so a fresh install doesn't run git over every
      // scanned repo until the user opts in. Incremental per repo; rebase-safe.
      key: "git.line_churn.sync",
      label: "Git 代码产出统计",
      description:
        "按作者增量统计各仓库每日新增/删除行（供项目级 token-vs-产出分析）。",
      category: "derived",
      defaultIntervalSeconds: sixHours,
      sensitivity: "high",
      run: async (ctx) => {
        const result = await syncAllReposChurn(ctx.db);
        return {
          status: result.status,
          summary: result,
          errorSummary: result.errors[0] ?? null,
        };
      },
    },
    {
      // Repo scan by the configured default roots (Settings page). Default
      // disabled (all tasks seed disabled). runScan is SYNCHRONOUS and reads
      // dirs / .git / manifests / docs — heavy; a manual Run now over a large
      // root tree blocks the serve process. Unconfigured -> `skipped` (the
      // house convention for "nothing to do", not a fake success); all roots
      // invalid -> `failed` (honest, never a silent 0-repo scan). Re-validation
      // is shared with the CLI default path via resolveScanRoots.
      key: "repos.scan",
      label: "仓库扫描",
      description:
        "按设置的默认根目录扫描 git 仓库并索引 manifest（默认关，根目录在设置页配置）。",
      category: "local_inventory",
      defaultIntervalSeconds: oneDay,
      sensitivity: "high",
      run: async (ctx) => {
        const resolved = resolveScanRoots(ctx.db);
        if (resolved.state === "unconfigured") {
          return skipped("未配置默认扫描根（在设置页添加）");
        }
        if (resolved.valid.length === 0) {
          return {
            status: "failed",
            summary: { skipped: resolved.skipped },
            errorSummary: "所有默认扫描根都无效/不存在",
          };
        }
        const result = await runScan(ctx.db, resolved.valid, undefined, {
          maxDepth: getScanMaxDepth(ctx.db),
          maxDocs: getScanMaxDocs(ctx.db),
          concurrency: getScanConcurrency(ctx.db),
        });
        return {
          status: result.errors.length > 0 ? "partial" : "success",
          summary: { ...result, skipped: resolved.skipped },
          errorSummary: result.errors[0] ?? null,
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
    {
      // External provider usage sync (MiniMax #1). Default disabled (no network
      // until enabled). Iterates ENABLED providers; per-provider errors are
      // isolated. Toggling a provider on/off and entering its key happens on
      // the /providers management page, not here.
      key: "provider.usage.sync",
      label: "外部平台用量同步",
      description:
        "同步已启用的外部 AI 平台（如 MiniMax）的用量快照,供 /providers 页展示。",
      category: "model_cache",
      defaultIntervalSeconds: oneHour,
      sensitivity: "low",
      run: async (ctx) => {
        const result = await syncEnabledProviders(ctx.db);
        const failed = result.results.find((r) => r.status === "failed");
        return {
          status: result.status,
          summary: result,
          errorSummary: failed?.error ?? null,
        };
      },
    },
    {
      // MiniMax billing-HISTORY sync (per-hour token usage from the undocumented
      // /account/amount endpoint). SEPARATE opt-in from the quota snapshot above:
      // only runs when the MiniMax provider has `history_enabled` set on the
      // /providers page. Each run re-pulls a rolling window and idempotently
      // upserts (late T+1~T+2 hours backfill); the scheduler lease serializes
      // runs so a manual + scheduled run can't clobber each other.
      key: "minimax.tokens.sync",
      label: "MiniMax 用量历史同步",
      description:
        "从 MiniMax 账单接口同步逐小时 token 历史,供 Token 趋势页展示(需在 /providers 页开启历史)。",
      category: "model_cache",
      defaultIntervalSeconds: oneHour,
      sensitivity: "low",
      run: async (ctx) => {
        const cfg = getProviderConfig(ctx.db, "minimax");
        if (!cfg?.history_enabled) {
          return {
            status: "skipped",
            summary: { reason: "history not enabled" },
            errorSummary: null,
          };
        }
        const apiKey = providerApiKey(ctx.db, "minimax");
        if (!apiKey) {
          return {
            status: "failed",
            summary: { reason: "no api key" },
            errorSummary: "未配置 API key",
          };
        }
        const r = await refreshMinimaxTokenUsage(ctx.db, { apiKey });
        return {
          status: r.status,
          summary: r,
          errorSummary: r.error ?? null,
        };
      },
    },
    {
      // OpenCode「我发的消息」入库(供全文搜索)。本地源、常开、无 key/opt-in。
      // 增量:按 message.time_created 水位分批 upsert;db 缺失/被锁 → 干净跳过/失败,
      // 不影响其它任务。设计:docs/agent-user-messages-design.md。
      key: "agent_user_messages.opencode.sync",
      label: "OpenCode 用户消息入库",
      description:
        "把 opencode 会话里「我发的消息」抽取并去注入后写入 agent_user_messages,供跨 agent 全文搜索。",
      category: "local_inventory",
      defaultIntervalSeconds: oneHour,
      sensitivity: "low",
      run: async (ctx) => {
        const r = ingestOpencodeUserMessages(ctx.db);
        return {
          status: r.status,
          summary: {
            scannedSessions: r.scannedSessions,
            upserted: r.upserted,
            watermarkMs: r.watermarkMs,
          },
          errorSummary: r.error ?? null,
        };
      },
    },
    {
      // Claude Code「我发的消息」入库(供全文搜索)。本地 jsonl 源、常开、无 key。
      // 增量按会话文件 mtime 水位分批 upsert;文件缺失/过大 → 干净跳过。
      key: "agent_user_messages.claude.sync",
      label: "Claude 用户消息入库",
      description:
        "把 Claude Code 会话 jsonl 里「我发的消息」抽取并去注入后写入 agent_user_messages,供跨 agent 全文搜索。",
      category: "local_inventory",
      defaultIntervalSeconds: oneHour,
      sensitivity: "low",
      run: async (ctx) => {
        const r = await ingestClaudeUserMessages(ctx.db);
        return {
          status: r.status,
          summary: {
            scannedFiles: r.scannedFiles,
            upserted: r.upserted,
            watermarkMs: r.watermarkMs,
          },
          errorSummary: r.error ?? null,
        };
      },
    },
    {
      // Codex「我发的消息」入库(供全文搜索)。本地 rollout jsonl 源、常开、无 key。
      // 增量按文件 mtime 水位分批 upsert;文件 >5000 时 summary 标注 truncated(不静默丢)。
      key: "agent_user_messages.codex.sync",
      label: "Codex 用户消息入库",
      description:
        "把 Codex 会话 rollout jsonl 里「我发的消息」抽取并去注入后写入 agent_user_messages,供跨 agent 全文搜索。",
      category: "local_inventory",
      defaultIntervalSeconds: oneHour,
      sensitivity: "low",
      run: async (ctx) => {
        const r = await ingestCodexUserMessages(ctx.db);
        return {
          status: r.status,
          summary: {
            scannedFiles: r.scannedFiles,
            upserted: r.upserted,
            watermarkMs: r.watermarkMs,
            truncated: r.truncated,
          },
          errorSummary: r.error ?? null,
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
