#!/usr/bin/env node
import { existsSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { Command } from "commander";
import { join, resolve } from "node:path";
import { openDailySummaryCacheDatabase } from "./dailySummary/cache.js";
import { buildDailySummaryLlmConfig } from "./dailySummary/llm.js";
import type { DailySummaryRuntimeOptions } from "./dailySummary/service.js";
import { readLlmChatConfig } from "./llmChat/config.js";
import {
  defaultDailySummaryDbPath,
  defaultDbPath,
  defaultRagDbPath,
} from "./config.js";
import {
  readRagConfig,
  readRagConfigFile,
  resolveRagConfigPath,
} from "./rag/config.js";
import { ingestCorpus, type IngestFileProgress } from "./rag/ingest.js";
import { loadRagEvalCases, runRagEval } from "./rag/eval.js";
import { cleanupDeletedRagFileManifests } from "./rag/manifest.js";
import { openRagDatabase } from "./rag/open.js";
import { resolveScanRoots } from "./scan/roots.js";
import { getScanMaxDepth, getScanMaxDocs, getScanConcurrency } from "./appConfig/index.js";
import { createVectorStore } from "./rag/vectorStore/factory.js";
import { defaultDownloadRoots } from "./downloads/roots.js";
import {
  defaultChromeHistoryPath,
  isChromeHistoryIndexingSupported,
} from "./chromeHistory/paths.js";
import { syncChromeHistory } from "./chromeHistory/sync.js";
import { rebuildChromeHistoryVisitDomains } from "./chromeHistory/domainPivot.js";
import { rebuildChromeTopicStream, rebuildGitTopicStream } from "./topicStream/rebuild.js";
import { rebuildConversationTopicStream } from "./topicStream/conversation.js";
import { llmClusterNamer } from "./topicStream/conversationNaming.js";
import { loadGithubToken } from "./github/config.js";
import { syncGithub } from "./github/sync.js";
import { redactAuth } from "./github/fetcher.js";
import {
  listTagAliases,
  rebuildAllRepoTags,
  removeAlias,
  seedTagAliases,
  upsertUserAlias,
} from "./github/tags.js";
import { scanDownloads } from "./downloads/scan.js";
import { runScan } from "./scan/runScan.js";
import { runServe, ServeListenError } from "./serve/runServe.js";
import { resolveWebDist } from "./serve/app.js";
import { ScheduledTaskRegistry } from "./scheduler/registry.js";
import { SchedulerRuntime } from "./scheduler/runner.js";
import { listScheduledTasks } from "./scheduler/store.js";
import { createDefaultScheduledTaskDefinitions } from "./scheduler/taskDefinitions.js";
import { syncBrewPackages } from "./software/brew/sync.js";
import { syncHuggingfaceModels } from "./huggingface/sync.js";
import { syncLmStudioModels } from "./lmstudio/sync.js";
import { syncMacApps } from "./software/macApps/sync.js";
import { resetSoftwareSource } from "./software/reset.js";
import { getVscodeMirrorStatus } from "./vscode/queries.js";
import { resetVscodeRecent } from "./vscode/reset.js";
import { syncVscodeRecent } from "./vscode/sync.js";
import { parseVscodeAppId } from "./vscode/paths.js";
import { listVscodeWindowProjects } from "./vscode/windowState.js";
import { vscodeAppLabel } from "./vscode/labels.js";
import type { VscodeAppId } from "./vscode/types.js";
import {
  getDirectoryActivityStatus,
  rebuildDirectoryActivity,
} from "./atuin/directoryActivity/index.js";
import { migrateCredentials, migrateRagSettings } from "./settings/migrate.js";
import { packageVersion } from "./path/packageRoot.js";
import { openDatabase, openReadOnlyDatabase } from "./store/open.js";
import { ingestClaudeUserMessages } from "./agentUserMessages/claudeIngest.js";
import { ingestCodexUserMessages } from "./agentUserMessages/codexIngest.js";
import { ingestKimiUserMessages } from "./agentUserMessages/kimiIngest.js";
import { ingestOpencodeUserMessages } from "./agentUserMessages/opencodeIngest.js";
import { setSyncState, getSyncState } from "./agentUserMessages/store.js";
import { CARD_REGISTRY } from "./cards/registry.js";
import { generateCardBundle } from "./cards/bundle.js";
import { exportFixture, probeAttentionSource } from "./attention/probe.js";
import { CLOSING_STREAMS } from "./attention/read.js";
import { getStatusSummary, searchManifests } from "./store/operations.js";
import {
  expandPath,
  findWorkspaces,
  getCursorDataPath,
  getSession,
  listSessions,
  listWorkspaces,
  searchSessions,
} from "./cursorHistory/index.js";

const program = new Command();

function createCliSchedulerRuntime(db: ReturnType<typeof openDatabase>): SchedulerRuntime {
  return new SchedulerRuntime({
    db,
    registry: new ScheduledTaskRegistry(createDefaultScheduledTaskDefinitions()),
    ownerId: `cli-${process.pid}`,
  });
}

function parseCursorSessionArg(raw: string): number | string {
  const t = raw.trim();
  if (/^\d+$/.test(t)) return parseInt(t, 10);
  return t;
}

function printEditorMirrorStatus(app: VscodeAppId, result: ReturnType<typeof getVscodeMirrorStatus>): void {
  console.error(
    `${vscodeAppLabel(app).toLowerCase()} projects status [${result.app}]: active ${result.counts.active}, missing ${result.counts.missing}, remote ${result.counts.remote}`
  );
  console.error(`Source: ${result.statePath ?? "(unsupported)"}`);
}

function printEditorSyncResult(result: ReturnType<typeof syncVscodeRecent>): void {
  console.error(
    `${vscodeAppLabel(result.app).toLowerCase()} projects sync [${result.status}]: inserted ${result.inserted}, updated ${result.updated}, missing ${result.markedMissing}, entries ${result.totalEntries}, warnings ${result.warnings.length}`
  );
  if (result.sourcePath) console.error(`Source: ${result.sourcePath}`);
  for (const w of result.warnings) console.error(`warning: ${w.message}`);
}

function printEditorResetResult(result: ReturnType<typeof resetVscodeRecent>): void {
  console.error(
    `${vscodeAppLabel(result.app).toLowerCase()} projects reset: deleted ${result.deletedRows} rows and ${result.deletedState} state row(s).`
  );
}

function defaultAtuinHistoryPath(): string {
  return join(homedir(), ".local/share/atuin/history.db");
}

program
  .name("ai2nao")
  .description("Local-first indexer for git repos and manifest files")
  // Read, never typed: this was hardcoded "0.1.0" long after package.json reached
  // 0.4.0, so `ai2nao --version` lied by three minor releases.
  .version(packageVersion());

program
  .command("scan")
  .description("Discover git repos under roots and index manifest files")
  .option(
    "-r, --root <path>",
    "scan root (repeatable; default: current directory)",
    (v: string, prev: string[]) => [...prev, v],
    [] as string[]
  )
  .option("--db <path>", "SQLite database path", defaultDbPath())
  .option("--json", "print machine-readable JSON", false)
  .action(async (opts: { root: string[]; db: string; json: boolean }) => {
    const db = openDatabase(opts.db);
    try {
      let roots: string[];
      if (opts.root?.length) {
        // Explicit --root: unchanged behavior (runScan tolerates a missing root).
        roots = opts.root.map((r) => resolve(r));
      } else {
        // No --root: use the configured default scan roots (Settings page),
        // re-validated at scan time via the shared resolver (also used by the
        // repos.scan task). Unconfigured -> cwd (interactive convenience);
        // all configured roots invalid -> error + non-zero exit, NOT a silent scan.
        const resolved = resolveScanRoots(db);
        if (resolved.state === "unconfigured") {
          roots = [process.cwd()];
        } else {
          for (const s of resolved.skipped) {
            console.error(`warning: skipping ${s.reason} scan root: ${s.path}`);
          }
          if (resolved.valid.length === 0) {
            console.error(
              "error: all configured scan roots are missing/invalid; fix them in Settings or pass --root"
            );
            process.exitCode = 1;
            return;
          }
          roots = resolved.valid;
        }
      }
      const result = await runScan(db, roots, undefined, {
        maxDepth: getScanMaxDepth(db),
        maxDocs: getScanMaxDocs(db),
        concurrency: getScanConcurrency(db),
      });
      if (opts.json) {
        console.log(JSON.stringify({ ok: true, ...result }, null, 2));
      } else {
        console.error(
          `Indexed ${result.manifestsIndexed} manifest(s) across ${result.reposFound} repo(s) (job ${result.jobId}).`
        );
        for (const err of result.errors) console.error(`warning: ${err}`);
      }
      process.exitCode = result.errors.length ? 1 : 0;
    } finally {
      db.close();
    }
  });

program
  .command("status")
  .description("Show index statistics")
  .option("--db <path>", "SQLite database path", defaultDbPath())
  .option("--json", "print machine-readable JSON", false)
  .action((opts: { db: string; json: boolean }) => {
    const db = openDatabase(opts.db);
    try {
      const s = getStatusSummary(db);
      if (opts.json) {
        console.log(JSON.stringify(s, null, 2));
      } else {
        console.log(`repos: ${s.repos}`);
        console.log(`manifests: ${s.manifests}`);
        if (s.lastJob) {
          console.log(
            `last job: #${s.lastJob.id} ${s.lastJob.kind} ${s.lastJob.status} ${s.lastJob.finished_at ?? ""}`
          );
        }
      }
    } finally {
      db.close();
    }
  });

program
  .command("search")
  .description("Search indexed manifest bodies (FTS5)")
  .argument("<query>", "FTS5 query string")
  .option("--db <path>", "SQLite database path", defaultDbPath())
  .option("-n, --limit <n>", "max results", "20")
  .option("--json", "print machine-readable JSON", false)
  .action(
    (
      query: string,
      opts: { db: string; limit: string; json: boolean }
    ) => {
      const limit = Math.min(500, Math.max(1, parseInt(opts.limit, 10) || 20));
      const db = openDatabase(opts.db);
      try {
        const hits = searchManifests(db, query, limit);
        if (opts.json) {
          console.log(JSON.stringify({ hits }, null, 2));
        } else {
          for (const h of hits) {
            console.log(`${h.repo_path} — ${h.rel_path}`);
            console.log(`  ${h.snippet}`);
            console.log("");
          }
          if (hits.length === 0) console.error("no matches");
        }
        process.exitCode = hits.length ? 0 : 1;
      } finally {
        db.close();
      }
    }
  );

const huggingfaceCmd = program
  .command("huggingface")
  .description("Index locally cached Hugging Face Hub models");

huggingfaceCmd
  .command("sync")
  .description("Scan Hugging Face Hub cache and record cached model metadata")
  .option("--db <path>", "SQLite database path", defaultDbPath())
  .option("-r, --root <path>", "Hub cache root (default: HF_HUB_CACHE, HF_HOME/hub, or ~/.cache/huggingface/hub)")
  .option("--json", "print machine-readable JSON", false)
  .action((opts: { db: string; root?: string; json: boolean }) => {
    const db = openDatabase(opts.db);
    try {
      const result = syncHuggingfaceModels(db, { root: opts.root });
      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.error(
          `Hugging Face sync [${result.status}]: inserted ${result.inserted}, updated ${result.updated}, missing ${result.markedMissing}, warnings ${result.warnings.length}`
        );
        console.error(`Cache root: ${result.cacheRoot}`);
        for (const w of result.warnings) console.error(`warning: ${w.message}`);
      }
      process.exitCode = result.ok && result.status !== "failed" ? 0 : 1;
    } finally {
      db.close();
    }
  });

const cardCmd = program
  .command("card")
  .description("生成可嵌入的卡片(SVG)");

// 每张注册表里的卡都有一个 `card <name>` 子命令(读 registry,一处维护)。
for (const card of CARD_REGISTRY) {
  cardCmd
    .command(card.name)
    .description(`生成「${card.title}」SVG`)
    .option("--db <path>", "SQLite database path", defaultDbPath())
    .option("--out <file>", "写入该文件;省略则打印到 stdout")
    .option("--cost", "token 卡:附带成本估算($),其它卡忽略", false)
    .action((opts: { db: string; out?: string; cost?: boolean }) => {
      const db = openReadOnlyDatabase(opts.db);
      try {
        const svg = card.render(db, { cost: opts.cost });
        if (opts.out) {
          const target = resolve(opts.out);
          writeFileSync(target, svg, "utf8");
          console.error(`Wrote ${target}`);
        } else {
          process.stdout.write(svg);
        }
      } finally {
        db.close();
      }
    });
}

cardCmd
  .command("bundle")
  .description("生成全部卡片 SVG + 一个 README.md 到目录(整目录 commit 成公开 repo,主页 README 引用)")
  .option("--db <path>", "SQLite database path", defaultDbPath())
  .option("--out-dir <dir>", "输出目录", "cards")
  .option("--cost", "token 卡:附带成本估算($)", false)
  .action((opts: { db: string; outDir: string; cost?: boolean }) => {
    const db = openReadOnlyDatabase(opts.db);
    try {
      const { outDir, files } = generateCardBundle(db, opts.outDir, {
        cost: opts.cost,
      });
      console.error(`Wrote ${files.length} files to ${outDir}`);
    } finally {
      db.close();
    }
  });

const lmstudioCmd = program
  .command("lmstudio")
  .description("Index locally downloaded LM Studio models");

lmstudioCmd
  .command("sync")
  .description("Scan LM Studio models directory and record model metadata")
  .option("--db <path>", "SQLite database path", defaultDbPath())
  .option("-r, --root <path>", "LM Studio models root (default: LM Studio settings downloadsFolder or ~/.lmstudio/models)")
  .option("--json", "print machine-readable JSON", false)
  .action((opts: { db: string; root?: string; json: boolean }) => {
    const db = openDatabase(opts.db);
    try {
      const result = syncLmStudioModels(db, { root: opts.root });
      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.error(
          `LM Studio sync [${result.status}]: inserted ${result.inserted}, updated ${result.updated}, missing ${result.markedMissing}, warnings ${result.warnings.length}`
        );
        console.error(`Models root: ${result.modelsRoot}`);
        if (result.settingsPath) console.error(`Settings: ${result.settingsPath}`);
        for (const alt of result.alternativeRoots) {
          console.error(`alternative root (${alt.source}): ${alt.modelsRoot}`);
        }
        for (const w of result.warnings) console.error(`warning: ${w.message}`);
      }
      process.exitCode = result.ok && result.status !== "failed" ? 0 : 1;
    } finally {
      db.close();
    }
  });

const downloadsCmd = program
  .command("downloads")
  .description(
    "Index files under ~/Downloads (macOS/Windows); see docs/downloads-design.md"
  );

downloadsCmd
  .command("scan")
  .description("Scan download folder(s) once and record new files in the index DB")
  .option("--db <path>", "SQLite database path", defaultDbPath())
  .option(
    "-r, --root <path>",
    "scan root (repeatable; default: ~/Downloads on supported OS)",
    (v: string, prev: string[]) => [...prev, v],
    [] as string[]
  )
  .option("--json", "print machine-readable JSON", false)
  .action((opts: { db: string; root: string[]; json: boolean }) => {
    const roots =
      opts.root.length > 0
        ? opts.root.map((r) => resolve(r))
        : defaultDownloadRoots();
    if (roots.length === 0) {
      console.error(
        "No download roots: use --root <path> on this platform, or see docs/downloads-design.md."
      );
      process.exitCode = 1;
      return;
    }
    const db = openDatabase(opts.db);
    try {
      const result = scanDownloads(db, roots);
      if (opts.json) {
        console.log(JSON.stringify({ ok: true, ...result }, null, 2));
      } else {
        console.error(
          `Downloads scan: inserted ${result.inserted}, skipped ${result.skipped} (already indexed) across ${result.roots.length} root(s).`
        );
        for (const err of result.errors) console.error(`warning: ${err}`);
      }
      process.exitCode = result.errors.length ? 1 : 0;
    } finally {
      db.close();
    }
  });

downloadsCmd
  .command("watch")
  .description("Re-scan download folder(s) on an interval (do not use with serve auto-scan)")
  .option("--db <path>", "SQLite database path", defaultDbPath())
  .option(
    "-r, --root <path>",
    "scan root (repeatable; default: ~/Downloads on supported OS)",
    (v: string, prev: string[]) => [...prev, v],
    [] as string[]
  )
  .option(
    "--interval <sec>",
    "seconds between scans",
    (v: string) => Math.max(5, parseInt(v, 10) || 30),
    30
  )
  .action((opts: { db: string; root: string[]; interval: number }) => {
    const roots =
      opts.root.length > 0
        ? opts.root.map((r) => resolve(r))
        : defaultDownloadRoots();
    if (roots.length === 0) {
      console.error(
        "No download roots: use --root <path> on this platform, or see docs/downloads-design.md."
      );
      process.exitCode = 1;
      return;
    }
    const tick = () => {
      const db = openDatabase(opts.db);
      try {
        const result = scanDownloads(db, roots);
        const ts = new Date().toISOString();
        console.error(
          `[${ts}] downloads watch: inserted ${result.inserted}, skipped ${result.skipped}`
        );
        for (const err of result.errors) console.error(`warning: ${err}`);
      } finally {
        db.close();
      }
    };
    tick();
    const id = setInterval(tick, opts.interval * 1000);
    const stop = () => {
      clearInterval(id);
      process.exit(0);
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  });

const chromeHistoryCmd = program
  .command("chrome-history")
  .description(
    "Mirror Chrome History SQLite (visits + downloads tables) into the index DB (insert-only); use with chrome-history:watch in package.json"
  );

chromeHistoryCmd
  .command("sync")
  .description(
    "Copy Chrome History to a temp file, read new visits and downloads, INSERT OR IGNORE into index DB"
  )
  .option("--db <path>", "SQLite database path", defaultDbPath())
  .option("--profile <name>", "Chrome profile folder name", "Default")
  .option(
    "--history-path <path>",
    "path to Chrome `History` file (default: first existing Chromium-family path for profile)"
  )
  .option("--json", "print machine-readable JSON", false)
  .option(
    "--full",
    "scan all Chrome visits/downloads and dedupe by stored content keys",
    false
  )
  .option(
    "--verbose",
    "print snapshot / WAL / downloads diagnostics (stderr)",
    false
  )
  .action(
    (opts: {
      db: string;
      profile: string;
      historyPath?: string;
      json: boolean;
      full: boolean;
      verbose: boolean;
    }) => {
      if (!isChromeHistoryIndexingSupported()) {
        console.error("Chrome history path: unsupported platform.");
        process.exitCode = 1;
        return;
      }
      const profile = opts.profile.trim() || "Default";
      const rawHistory = (opts.historyPath ?? "").trim();
      const historyPath =
        rawHistory.length > 0
          ? resolve(rawHistory)
          : defaultChromeHistoryPath(profile);
      if (!historyPath) {
        console.error("Could not resolve default Chrome History path.");
        process.exitCode = 1;
        return;
      }
      const db = openDatabase(opts.db);
      try {
        const result = syncChromeHistory(db, historyPath, profile, {
          full: opts.full,
          verbose: opts.verbose,
        });
        if (opts.json) {
          console.log(JSON.stringify({ ok: true, ...result }, null, 2));
        } else {
          console.error(
            `Chrome history sync [${profile}]: visits +${result.insertedVisits} (urls +${result.insertedUrls}), skipped ${result.skippedVisits} duplicate visit(s); downloads +${result.insertedDownloads}, skipped ${result.skippedDownloads} duplicate download(s).`
          );
          console.error(`Source: ${result.sourcePath}`);
          if (result.domainRebuild) {
            console.error(
              `Domain pivot rebuild: ${result.domainRebuild.ok ? "ok" : "failed"} (${result.domainRebuild.derivedVisitCount}/${result.domainRebuild.sourceVisitCount} visits, ${result.domainRebuild.durationMs}ms).`
            );
          }
          if (opts.verbose && result.debug) {
            console.error("Diagnostics:", JSON.stringify(result.debug, null, 2));
          }
          for (const err of result.errors) console.error(`warning: ${err}`);
        }
        process.exitCode = result.errors.length ? 1 : 0;
      } finally {
        db.close();
      }
    }
  );

chromeHistoryCmd
  .command("watch")
  .description("Re-sync Chrome History on an interval (do not run two watch processes on the same DB)")
  .option("--db <path>", "SQLite database path", defaultDbPath())
  .option("--profile <name>", "Chrome profile folder name", "Default")
  .option(
    "--history-path <path>",
    "path to Chrome `History` file (default: platform default for profile)"
  )
  .option(
    "--interval <sec>",
    "seconds between syncs",
    (v: string) => Math.max(5, parseInt(v, 10) || 30),
    30
  )
  .action(
    (opts: {
      db: string;
      profile: string;
      historyPath?: string;
      interval: number;
    }) => {
      if (!isChromeHistoryIndexingSupported()) {
        console.error("Chrome history path: unsupported platform.");
        process.exitCode = 1;
        return;
      }
      const profile = opts.profile.trim() || "Default";
      const rawHistoryWatch = (opts.historyPath ?? "").trim();
      const historyPath =
        rawHistoryWatch.length > 0
          ? resolve(rawHistoryWatch)
          : defaultChromeHistoryPath(profile);
      if (!historyPath) {
        console.error("Could not resolve default Chrome History path.");
        process.exitCode = 1;
        return;
      }
      const tick = () => {
        const db = openDatabase(opts.db);
        try {
          const result = syncChromeHistory(db, historyPath, profile);
          const ts = new Date().toISOString();
          console.error(
            `[${ts}] chrome-history watch [${profile}]: visits +${result.insertedVisits} / skipped ${result.skippedVisits}; downloads +${result.insertedDownloads} / skipped ${result.skippedDownloads}`
          );
          if (result.domainRebuild) {
            console.error(
              `[${ts}] chrome-history domains [${profile}]: ${result.domainRebuild.ok ? "ok" : "failed"} (${result.domainRebuild.derivedVisitCount}/${result.domainRebuild.sourceVisitCount})`
            );
          }
          for (const err of result.errors) console.error(`warning: ${err}`);
        } finally {
          db.close();
        }
      };
      tick();
      const id = setInterval(tick, opts.interval * 1000);
      const stop = () => {
        clearInterval(id);
        process.exit(0);
      };
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);
    }
  );

const chromeHistoryDomainsCmd = chromeHistoryCmd
  .command("domains")
  .description("Build and inspect the Chrome History domain pivot derived table");

chromeHistoryDomainsCmd
  .command("rebuild")
  .description("Rebuild chrome_history_visit_domains for one Chrome profile")
  .option("--db <path>", "SQLite database path", defaultDbPath())
  .option("--profile <name>", "Chrome profile folder name", "Default")
  .option("--json", "print machine-readable JSON", false)
  .action((opts: { db: string; profile: string; json: boolean }) => {
    const profile = opts.profile.trim() || "Default";
    const db = openDatabase(opts.db);
    try {
      const result = rebuildChromeHistoryVisitDomains(db, profile);
      if (opts.json) {
        console.log(JSON.stringify({ ok: result.ok, result }, null, 2));
      } else {
        console.error(
          `Chrome history domain rebuild [${profile}]: ${result.ok ? "ok" : "failed"} (${result.derivedVisitCount}/${result.sourceVisitCount} visits, ${result.durationMs}ms).`
        );
        if (result.error) console.error(`error: ${result.error}`);
      }
      process.exitCode = result.ok ? 0 : 1;
    } finally {
      db.close();
    }
  });

const topicsCmd = program
  .command("topics")
  .description(
    "Topic stream: rebuild the per-visit browsing topic river derived layer (Stage 1)"
  );

topicsCmd
  .command("rebuild")
  .description("Rebuild the topic stream for one source (chrome | git | conversation)")
  .option("--db <path>", "SQLite database path", defaultDbPath())
  .option("--source <name>", "topic source: chrome | git | conversation", "chrome")
  .option("--profile <name>", "Chrome profile folder name (chrome only)", "Default")
  .option("--recluster", "conversation only: re-derive the codebook (bump clusters)", false)
  .option("--k <n>", "conversation only: cluster count for --recluster (default 12)")
  .option("--json", "print machine-readable JSON", false)
  .action(async (opts: { db: string; source: string; profile: string; recluster: boolean; k?: string; json: boolean }) => {
    const source = opts.source.trim() || "chrome";
    if (source !== "chrome" && source !== "git" && source !== "conversation") {
      console.error(`topics rebuild: unknown source '${source}' (use chrome | git | conversation).`);
      process.exitCode = 1;
      return;
    }
    const profile = opts.profile.trim() || "Default";
    const db = openDatabase(opts.db);
    try {
      const result =
        source === "git"
          ? rebuildGitTopicStream(db)
          : source === "conversation"
            ? await rebuildConversationTopicStream(db, {
                recluster: opts.recluster,
                namer: llmClusterNamer,
                k: opts.k ? Math.max(2, parseInt(opts.k, 10) || 12) : undefined,
              })
            : rebuildChromeTopicStream(db, profile);
      if (opts.json) {
        console.log(JSON.stringify({ ok: result.ok, result }, null, 2));
      } else {
        console.error(
          `Topic stream rebuild [${source}/${result.profile}]: ${result.ok ? "ok" : "failed"} (${result.derivedCount}/${result.sourceCount} kept, ${result.durationMs}ms, rules ${result.ruleVersion}).`
        );
        const d = result.diagnostic;
        if (d) {
          console.error(`  其他 share: ${(d.other_share * 100).toFixed(1)}%  (kept ${d.total_kept} / source ${d.total_source}, non-web dropped ${d.filtered_non_web})`);
          const cats = Object.entries(d.category_counts).sort((a, b) => b[1] - a[1]);
          for (const [name, count] of cats) console.error(`    ${name}: ${count}`);
          const filtered = Object.entries(d.filtered_transition).sort((a, b) => b[1] - a[1]);
          if (filtered.length) {
            console.error(`  filtered transitions: ${filtered.map(([k, v]) => `${k}=${v}`).join(", ")}`);
          }
          if (d.top_unmatched_domains.length) {
            console.error(`  top unmatched domains (→其他):`);
            for (const u of d.top_unmatched_domains) console.error(`    ${u.domain}: ${u.count}`);
          }
        }
        if (result.error) console.error(`error: ${result.error}`);
      }
      process.exitCode = result.ok ? 0 : 1;
    } finally {
      db.close();
    }
  });

const githubCmd = program
  .command("github")
  .description(
    "Mirror your GitHub owned repos + stars + commit counts into the index DB (read-only mirror; requires GITHUB_TOKEN or ~/.ai2nao/github.json)"
  );

githubCmd
  .command("sync")
  .description(
    "One-shot sync (incremental by default; use --full for a complete reindex). Reads token from GITHUB_TOKEN or ~/.ai2nao/github.json."
  )
  .option("--db <path>", "SQLite database path", defaultDbPath())
  .option("--full", "ignore watermarks and re-fetch everything", false)
  .option("--json", "print machine-readable JSON", false)
  .action(async (opts: { db: string; full: boolean; json: boolean }) => {
    const loaded = loadGithubToken();
    if (!loaded) {
      console.error(
        "No GitHub token configured. Set GITHUB_TOKEN or create ~/.ai2nao/github.json with {\"token\":\"ghp_...\"} (chmod 0600)."
      );
      process.exitCode = 1;
      return;
    }
    const db = openDatabase(opts.db);
    try {
      const result = await syncGithub(db, {
        token: loaded.token,
        apiBase: loaded.config.apiBase,
        mode: opts.full ? "full" : "incremental",
        onProgress: (ev) => {
          if (opts.json) return;
          if (ev.phase === "login") {
            console.error(`github: authenticated as ${ev.login}`);
          } else if (ev.phase === "repos") {
            console.error(
              `github: repos fetched=${ev.fetched} upserted=${ev.upserted}`
            );
          } else if (ev.phase === "commit-counts") {
            console.error(`github: commit counts ${ev.done}/${ev.total}`);
          } else if (ev.phase === "stars") {
            console.error(
              `github: stars fetched=${ev.fetched} upserted=${ev.upserted}`
            );
          } else if (ev.phase === "tags-rebuild") {
            console.error(
              `github: tags rebuild scanned=${ev.scanned} inserted=${ev.inserted}`
            );
          } else if (ev.phase === "done") {
            console.error(`github: done in ${ev.durationMs}ms`);
          }
        },
      });
      if (opts.json) {
        console.log(JSON.stringify({ ok: true, ...result }, null, 2));
      } else {
        const tagSuffix = result.tagsRebuild
          ? `, tags ~${result.tagsRebuild.tagsInserted} (${result.tagsRebuild.starsScanned} stars)`
          : "";
        console.error(
          `github sync [${result.mode}]: repos +${result.reposUpserted}, stars +${result.starsUpserted}, commit_counts +${result.commitCountsUpdated} (failures ${result.commitCountFailures})${tagSuffix}, ${result.durationMs}ms`
        );
        for (const err of result.errors) console.error(`warning: ${err}`);
      }
      process.exitCode = result.errors.length ? 1 : 0;
    } catch (e) {
      const msg = redactAuth(e instanceof Error ? e.message : String(e));
      console.error(`github sync failed: ${msg}`);
      process.exitCode = 1;
    } finally {
      db.close();
    }
  });

const appsCmd = program
  .command("apps")
  .description("Mirror installed macOS .app bundles into the index DB");

appsCmd
  .command("sync")
  .description("Scan macOS application roots and upsert app metadata")
  .option("--db <path>", "SQLite database path", defaultDbPath())
  .option(
    "-r, --root <path>",
    "scan root (repeatable; CLI only; API uses default roots)",
    (v: string, prev: string[]) => [...prev, v],
    [] as string[]
  )
  .option("--json", "print machine-readable JSON", false)
  .action(async (opts: { db: string; root: string[]; json: boolean }) => {
    const db = openDatabase(opts.db);
    try {
      const result = await syncMacApps(db, {
        roots: opts.root.length ? opts.root.map((r) => resolve(r)) : undefined,
      });
      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.error(
          `apps sync [${result.status}]: inserted ${result.inserted}, updated ${result.updated}, missing ${result.markedMissing}, warnings ${result.warnings.length}`
        );
        for (const w of result.warnings) console.error(`warning: ${w.message}`);
      }
      process.exitCode = result.ok ? 0 : 1;
    } finally {
      db.close();
    }
  });

appsCmd
  .command("reset")
  .description("Delete mirrored macOS app inventory rows and sync history")
  .option("--db <path>", "SQLite database path", defaultDbPath())
  .option("--yes", "confirm destructive reset", false)
  .option("--json", "print machine-readable JSON", false)
  .action((opts: { db: string; yes: boolean; json: boolean }) => {
    if (!opts.yes) {
      const msg = "confirmation_required: re-run with --yes to delete app inventory rows";
      if (opts.json) console.log(JSON.stringify({ ok: false, error: msg }, null, 2));
      else console.error(msg);
      process.exitCode = 1;
      return;
    }
    const db = openDatabase(opts.db);
    try {
      const result = resetSoftwareSource(db, "mac_apps");
      if (opts.json) console.log(JSON.stringify({ ok: true, ...result }, null, 2));
      else {
        console.error(
          `apps reset: deleted ${result.deletedRows} rows, ${result.deletedRuns} run(s), ${result.deletedState} state row(s).`
        );
      }
    } finally {
      db.close();
    }
  });

const brewCmd = program
  .command("brew")
  .description("Mirror installed Homebrew formulae and casks into the index DB");

brewCmd
  .command("sync")
  .description("Read local Homebrew inventory and upsert package metadata")
  .option("--db <path>", "SQLite database path", defaultDbPath())
  .option("--brew <path>", "absolute path to brew executable (CLI only)")
  .option("--json", "print machine-readable JSON", false)
  .action(async (opts: { db: string; brew?: string; json: boolean }) => {
    const db = openDatabase(opts.db);
    try {
      const result = await syncBrewPackages(db, {
        brewPath: opts.brew,
        allowCustomBrewPath: Boolean(opts.brew),
      });
      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.error(
          `brew sync [${result.status}]: inserted ${result.inserted}, updated ${result.updated}, missing ${result.markedMissing}, warnings ${result.warnings.length}`
        );
        if (result.brewPath) console.error(`Source: ${result.brewPath}`);
        for (const w of result.warnings) console.error(`warning: ${w.message}`);
      }
      process.exitCode = result.ok ? 0 : 1;
    } finally {
      db.close();
    }
  });

brewCmd
  .command("reset")
  .description("Delete mirrored Homebrew inventory rows and sync history")
  .option("--db <path>", "SQLite database path", defaultDbPath())
  .option("--yes", "confirm destructive reset", false)
  .option("--json", "print machine-readable JSON", false)
  .action((opts: { db: string; yes: boolean; json: boolean }) => {
    if (!opts.yes) {
      const msg = "confirmation_required: re-run with --yes to delete brew inventory rows";
      if (opts.json) console.log(JSON.stringify({ ok: false, error: msg }, null, 2));
      else console.error(msg);
      process.exitCode = 1;
      return;
    }
    const db = openDatabase(opts.db);
    try {
      const result = resetSoftwareSource(db, "brew");
      if (opts.json) console.log(JSON.stringify({ ok: true, ...result }, null, 2));
      else {
        console.error(
          `brew reset: deleted ${result.deletedRows} rows, ${result.deletedRuns} run(s), ${result.deletedState} state row(s).`
        );
      }
    } finally {
      db.close();
    }
  });

const vscodeCmd = program
  .command("vscode")
  .description("Mirror VS Code recently opened files and folders from state.vscdb");

vscodeCmd
  .command("windows")
  .description("Read storage.json windowsState and print currently restorable VS Code projects")
  .option("--app <app>", "VS Code app id: code, code-insiders, vscodium, cursor", "code")
  .option("--storage <path>", "storage.json path for tests or one-off inspection")
  .option("--json", "print machine-readable JSON", false)
  .action((opts: { app: string; storage?: string; json: boolean }) => {
    if (!parseVscodeAppId(opts.app)) {
      console.error("invalid app");
      process.exitCode = 1;
      return;
    }
    const result = listVscodeWindowProjects({ app: opts.app, storagePath: opts.storage });
    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.error(`vscode windows [${result.app}]: ${result.projects.length} project window(s)`);
      console.error(`Source: ${result.storagePath ?? "(unsupported)"}`);
      for (const warning of result.warnings) console.error(`warning: ${warning}`);
      for (const project of result.projects) {
        const marker = project.source === "lastActiveWindow" ? "*" : "-";
        const location = project.path ?? project.uri ?? "(empty)";
        console.log(`${marker} ${project.label} [${project.kind}] ${location}`);
      }
    }
    process.exitCode = result.ok ? 0 : 1;
  });

vscodeCmd
  .command("status")
  .description("Show VS Code recent-work mirror status")
  .option("--db <path>", "SQLite database path", defaultDbPath())
  .option("--app <app>", "VS Code app id: code, code-insiders, vscodium, cursor", "code")
  .option("--json", "print machine-readable JSON", false)
  .action((opts: { db: string; app: string; json: boolean }) => {
    if (!parseVscodeAppId(opts.app)) {
      console.error("invalid app");
      process.exitCode = 1;
      return;
    }
    const db = openDatabase(opts.db);
    try {
      const result = getVscodeMirrorStatus(db, { app: opts.app });
      if (opts.json) console.log(JSON.stringify(result, null, 2));
      else printEditorMirrorStatus(result.app, result);
    } finally {
      db.close();
    }
  });

vscodeCmd
  .command("sync")
  .description("Read VS Code state.vscdb and upsert recent files/folders")
  .option("--db <path>", "SQLite database path", defaultDbPath())
  .option("--app <app>", "VS Code app id: code, code-insiders, vscodium, cursor", "code")
  .option("--json", "print machine-readable JSON", false)
  .action((opts: { db: string; app: string; json: boolean }) => {
    if (!parseVscodeAppId(opts.app)) {
      console.error("invalid app");
      process.exitCode = 1;
      return;
    }
    const db = openDatabase(opts.db);
    try {
      const result = syncVscodeRecent(db, { app: opts.app });
      if (opts.json) console.log(JSON.stringify(result, null, 2));
      else printEditorSyncResult(result);
      process.exitCode = result.ok ? 0 : 1;
    } finally {
      db.close();
    }
  });

vscodeCmd
  .command("reset")
  .description("Delete mirrored VS Code recent-work rows")
  .option("--db <path>", "SQLite database path", defaultDbPath())
  .option("--app <app>", "VS Code app id: code, code-insiders, vscodium, cursor", "code")
  .option("--yes", "confirm destructive reset", false)
  .option("--json", "print machine-readable JSON", false)
  .action((opts: { db: string; app: string; yes: boolean; json: boolean }) => {
    const app = parseVscodeAppId(opts.app);
    if (!app) {
      console.error("invalid app");
      process.exitCode = 1;
      return;
    }
    if (!opts.yes) {
      const msg = `confirmation_required: re-run with --yes to delete ${vscodeAppLabel(app)} recent-work rows`;
      if (opts.json) console.log(JSON.stringify({ ok: false, error: msg }, null, 2));
      else console.error(msg);
      process.exitCode = 1;
      return;
    }
    const db = openDatabase(opts.db);
    try {
      const result = resetVscodeRecent(db, { app });
      if (opts.json) console.log(JSON.stringify({ ok: true, ...result }, null, 2));
      else printEditorResetResult(result);
    } finally {
      db.close();
    }
  });

const cursorCmd = program
  .command("cursor")
  .description("Cursor IDE local data tools");

const cursorProjectsCmd = cursorCmd
  .command("projects")
  .description("Mirror Cursor recently opened files and folders from state.vscdb");

cursorProjectsCmd
  .command("status")
  .description("Show Cursor opened-project mirror status")
  .option("--db <path>", "SQLite database path", defaultDbPath())
  .option("--json", "print machine-readable JSON", false)
  .action((opts: { db: string; json: boolean }) => {
    const db = openDatabase(opts.db);
    try {
      const result = getVscodeMirrorStatus(db, { app: "cursor" });
      if (opts.json) console.log(JSON.stringify(result, null, 2));
      else printEditorMirrorStatus("cursor", result);
    } finally {
      db.close();
    }
  });

cursorProjectsCmd
  .command("sync")
  .description("Read Cursor state.vscdb and upsert recently opened projects")
  .option("--db <path>", "SQLite database path", defaultDbPath())
  .option("--json", "print machine-readable JSON", false)
  .action((opts: { db: string; json: boolean }) => {
    const db = openDatabase(opts.db);
    try {
      const result = syncVscodeRecent(db, { app: "cursor" });
      if (opts.json) console.log(JSON.stringify(result, null, 2));
      else printEditorSyncResult(result);
      process.exitCode = result.ok ? 0 : 1;
    } finally {
      db.close();
    }
  });

cursorProjectsCmd
  .command("reset")
  .description("Delete mirrored Cursor opened-project rows")
  .option("--db <path>", "SQLite database path", defaultDbPath())
  .option("--yes", "confirm destructive reset", false)
  .option("--json", "print machine-readable JSON", false)
  .action((opts: { db: string; yes: boolean; json: boolean }) => {
    if (!opts.yes) {
      const msg = "confirmation_required: re-run with --yes to delete Cursor opened-project rows";
      if (opts.json) console.log(JSON.stringify({ ok: false, error: msg }, null, 2));
      else console.error(msg);
      process.exitCode = 1;
      return;
    }
    const db = openDatabase(opts.db);
    try {
      const result = resetVscodeRecent(db, { app: "cursor" });
      if (opts.json) console.log(JSON.stringify({ ok: true, ...result }, null, 2));
      else printEditorResetResult(result);
    } finally {
      db.close();
    }
  });

const tagsCmd = githubCmd
  .command("tags")
  .description(
    "Local tag-pivot commands. Rebuild canonical gh_repo_tag, manage the gh_tag_alias synonym map."
  );

tagsCmd
  .command("rebuild")
  .description(
    "Rebuild gh_repo_tag from gh_star + gh_tag_alias (full). Run after editing aliases."
  )
  .option("--db <path>", "SQLite database path", defaultDbPath())
  .option("--json", "print machine-readable JSON", false)
  .action((opts: { db: string; json: boolean }) => {
    const db = openDatabase(opts.db);
    try {
      const stats = rebuildAllRepoTags(db);
      if (opts.json) {
        console.log(JSON.stringify({ ok: true, ...stats }, null, 2));
      } else {
        console.error(
          `github tags rebuild: scanned ${stats.starsScanned} stars, inserted ${stats.tagsInserted} tag rows, ${stats.reposWithNoTags} stars had no tags.`
        );
      }
    } finally {
      db.close();
    }
  });

const aliasCmd = tagsCmd
  .command("alias")
  .description("Manage gh_tag_alias entries (preset seed + user overrides).");

aliasCmd
  .command("seed")
  .description(
    "Insert the bundled preset alias dictionary (INSERT OR IGNORE; safe to re-run)."
  )
  .option("--db <path>", "SQLite database path", defaultDbPath())
  .option("--json", "print machine-readable JSON", false)
  .action((opts: { db: string; json: boolean }) => {
    const db = openDatabase(opts.db);
    try {
      const inserted = seedTagAliases(db);
      if (opts.json) {
        console.log(JSON.stringify({ ok: true, inserted }, null, 2));
      } else {
        console.error(
          `github tags alias seed: inserted ${inserted} new preset entries (existing rows preserved).`
        );
        if (inserted > 0) {
          console.error(
            "hint: run `ai2nao github tags rebuild` to apply aliases to existing gh_repo_tag rows."
          );
        }
      }
    } finally {
      db.close();
    }
  });

aliasCmd
  .command("add <from> <to>")
  .description("Add or overwrite a user alias (source becomes 'user').")
  .option("--db <path>", "SQLite database path", defaultDbPath())
  .option("--note <text>", "short description for the override", "")
  .option("--json", "print machine-readable JSON", false)
  .action(
    (
      from: string,
      to: string,
      opts: { db: string; note: string; json: boolean }
    ) => {
      const db = openDatabase(opts.db);
      try {
        upsertUserAlias(db, from, to, opts.note.trim() || null);
        if (opts.json) {
          console.log(JSON.stringify({ ok: true, from, to }, null, 2));
        } else {
          console.error(
            `github tags alias add: ${from.toLowerCase()} → ${to.toLowerCase()}`
          );
          console.error(
            "hint: run `ai2nao github tags rebuild` to apply this alias."
          );
        }
      } catch (e) {
        console.error(String(e));
        process.exitCode = 1;
      } finally {
        db.close();
      }
    }
  );

aliasCmd
  .command("list")
  .description("List aliases (optionally filter by source).")
  .option("--db <path>", "SQLite database path", defaultDbPath())
  .option(
    "--source <kind>",
    "filter: preset | user (omit for all)",
    (v: string) => {
      if (v !== "preset" && v !== "user") {
        throw new Error("source must be 'preset' or 'user'");
      }
      return v;
    }
  )
  .option("--json", "print machine-readable JSON", false)
  .action((opts: { db: string; source?: "preset" | "user"; json: boolean }) => {
    const db = openDatabase(opts.db);
    try {
      const rows = listTagAliases(db, opts.source);
      if (opts.json) {
        console.log(JSON.stringify({ ok: true, aliases: rows }, null, 2));
      } else {
        if (rows.length === 0) {
          console.error("(no aliases)");
        } else {
          for (const r of rows) {
            const note = r.note ? ` — ${r.note}` : "";
            console.log(`${r.source}\t${r.from_tag} → ${r.to_tag}${note}`);
          }
        }
      }
    } finally {
      db.close();
    }
  });

aliasCmd
  .command("rm <from>")
  .description("Remove an alias by from-tag.")
  .option("--db <path>", "SQLite database path", defaultDbPath())
  .option("--json", "print machine-readable JSON", false)
  .action((from: string, opts: { db: string; json: boolean }) => {
    const db = openDatabase(opts.db);
    try {
      const removed = removeAlias(db, from);
      if (opts.json) {
        console.log(JSON.stringify({ ok: true, removed }, null, 2));
      } else {
        console.error(
          removed
            ? `github tags alias rm: removed ${from.toLowerCase()}`
            : `github tags alias rm: no alias found for ${from.toLowerCase()}`
        );
        if (removed) {
          console.error(
            "hint: run `ai2nao github tags rebuild` to apply the change."
          );
        }
      }
      process.exitCode = removed ? 0 : 1;
    } finally {
      db.close();
    }
  });

const atuinCmd = program.command("atuin").description("Read Atuin shell history");
const atuinDirectoriesCmd = atuinCmd
  .command("directories")
  .description("Inspect directory activity derived from Atuin history");

atuinDirectoriesCmd
  .command("status")
  .description("Show Atuin directory activity projection freshness")
  .option("--db <path>", "SQLite database path", defaultDbPath())
  .option("--json", "print machine-readable JSON", false)
  .action((opts: { db: string; json: boolean }) => {
    const db = openDatabase(opts.db);
    try {
      const status = getDirectoryActivityStatus(db);
      if (opts.json) {
        console.log(JSON.stringify({ ok: true, status }, null, 2));
      } else {
        console.log(`fresh: ${status.fresh ? "yes" : "no"}`);
        console.log(`directories: ${status.currentDerivedDirectoryCount}`);
        console.log(`commands: ${status.currentDerivedCommandCount}`);
        console.log(`config: ${status.configPath}`);
        if (status.staleReasons.length > 0) {
          console.log(`stale: ${status.staleReasons.join(", ")}`);
        }
      }
      process.exitCode = status.fresh ? 0 : 1;
    } finally {
      db.close();
    }
  });

atuinDirectoriesCmd
  .command("rebuild")
  .description("Rebuild directory activity from read-only Atuin history.db")
  .option("--db <path>", "SQLite database path", defaultDbPath())
  .option(
    "--atuin-db <path>",
    "Atuin history.db (default: ~/.local/share/atuin/history.db)"
  )
  .option("--json", "print machine-readable JSON", false)
  .action((opts: { db: string; atuinDb?: string; json: boolean }) => {
    const atuinPath = opts.atuinDb?.trim()
      ? resolve(opts.atuinDb.trim())
      : defaultAtuinHistoryPath();
    if (!existsSync(atuinPath)) {
      const payload = {
        ok: false,
        error: { code: "not_configured", message: `Atuin database not found: ${atuinPath}` },
      };
      if (opts.json) console.log(JSON.stringify(payload, null, 2));
      else console.error(payload.error.message);
      process.exitCode = 1;
      return;
    }
    const indexDb = openDatabase(opts.db);
    const atuinDb = openReadOnlyDatabase(atuinPath);
    try {
      const result = rebuildDirectoryActivity({ indexDb, atuinDb });
      if (opts.json) {
        console.log(JSON.stringify({ ok: result.ok, result }, null, 2));
      } else if (result.ok) {
        console.error(
          `Atuin directory activity rebuilt: ${result.derivedDirectoryCount} dirs, ${result.derivedCommandCount} commands from ${result.sourceEntryCount} entries in ${result.durationMs}ms.`
        );
      } else {
        console.error(`${result.errorCode}: ${result.error}`);
      }
      process.exitCode = result.ok ? 0 : 1;
    } finally {
      atuinDb.close();
      indexDb.close();
    }
  });

program
  .command("serve")
  .description("HTTP API + optional SPA (index DB opened read-write for downloads ingest)")
  .option("--db <path>", "SQLite database path", defaultDbPath())
  .option("--host <host>", "bind address", "127.0.0.1")
  .option("--port <port>", "port", "8787")
  .option(
    "--api-only",
    "only expose /api (do not serve web/dist even if present)",
    false
  )
  .option(
    "--atuin-db <path>",
    "Atuin history.db (omit to use ~/.local/share/atuin/history.db if exists)"
  )
  .option(
    "--daily-summary",
    "enable explicit daily summary generation for /atuin",
    false
  )
  .option(
    "--daily-summary-db <path>",
    "daily summary cache SQLite path",
    defaultDailySummaryDbPath()
  )
  .option(
    "--llm-timeout-ms <ms>",
    "daily summary LLM timeout in milliseconds",
    process.env.AI2NAO_LLM_TIMEOUT_MS ?? "30000"
  )
  .option(
    "--rag-db <path>",
    "RAG chunk SQLite (FTS5 + optional embeddings)",
    defaultRagDbPath()
  )
  .action(
    async (opts: {
      db: string;
      host: string;
      port: string;
      apiOnly: boolean;
      atuinDb?: string;
      dailySummary: boolean;
      dailySummaryDb: string;
      llmTimeoutMs: string;
      ragDb: string;
    }) => {
      let db;
      let mcpDb;
      try {
        db = openDatabase(opts.db);
        // Separate read-only handle for the MCP server (read-only enforcement).
        mcpDb = openReadOnlyDatabase(opts.db);
      } catch (e) {
        console.error(String(e));
        process.exitCode = 1;
        return;
      }

      // Move credentials out of the JSON files and out of index.db's plaintext
      // api_key column, into config.db (0600). Runs every boot, does real work
      // once, and degrades to "keep reading the files" if anything goes wrong.
      migrateCredentials(db);
      // Same for the non-secret RAG corpus settings (own marker, rag.json kept).
      migrateRagSettings();

      let atuin: { db: ReturnType<typeof openReadOnlyDatabase>; path: string } | undefined;
      let dailySummary:
        | {
            cacheDb: ReturnType<typeof openDailySummaryCacheDatabase>;
            runtime: DailySummaryRuntimeOptions;
          }
        | undefined;
      const explicitAtuin = opts.atuinDb?.trim();
      const defaultAtuinPath = defaultAtuinHistoryPath();
      const atuinPath = explicitAtuin ? resolve(explicitAtuin) : defaultAtuinPath;
      if (!explicitAtuin && !existsSync(atuinPath)) {
        atuin = undefined;
      } else {
        if (!existsSync(atuinPath)) {
          console.error(`Atuin database not found: ${atuinPath}`);
          process.exitCode = 1;
          return;
        }
        try {
          atuin = { db: openReadOnlyDatabase(atuinPath), path: atuinPath };
          console.error(`Atuin history.db: ${atuinPath}`);
        } catch (e) {
          console.error(String(e));
          process.exitCode = 1;
          return;
        }
      }

      if (opts.dailySummary) {
        const cacheDbPath = resolve(opts.dailySummaryDb);
        const llmTimeoutMs = Math.max(
          1_000,
          parseInt(opts.llmTimeoutMs, 10) || 30_000
        );
        dailySummary = {
          cacheDb: openDailySummaryCacheDatabase(cacheDbPath),
          runtime: {
            enabled: true,
            cacheDbPath,
            // 复用 llm-chat(设置 → AI 与模型)。serve 路由每次请求会再现读一次,
            // 设置页改动无需重启即可生效;这里启动时读一次仅用于下面的就绪日志。
            llm: buildDailySummaryLlmConfig(readLlmChatConfig(), llmTimeoutMs),
          },
        };
      }

      let rag: { db: ReturnType<typeof openRagDatabase>; path: string } | undefined;
      try {
        const ragEnv = (process.env.AI2NAO_RAG_DB ?? "").trim();
        const ragPath = ragEnv.length > 0 ? resolve(ragEnv) : resolve(opts.ragDb);
        rag = { db: openRagDatabase(ragPath), path: ragPath };
        console.error(`RAG index: ${ragPath}`);
      } catch (e) {
        console.error(`Failed to open RAG database: ${String(e)}`);
        try {
          db.close();
        } catch {
          /* ignore */
        }
        process.exitCode = 1;
        return;
      }

      const port = Math.max(1, parseInt(opts.port, 10) || 8787);
      const dist = resolveWebDist();
      const withStatic = !opts.apiOnly && existsSync(dist);
      let url: string;
      let close: () => Promise<void>;
      try {
        ({ url, close } = await runServe({
          db,
          mcpDb,
          atuin,
          dailySummary,
          rag,
          host: opts.host,
          port,
          withStatic,
        }));
      } catch (e) {
        // A port conflict is the single most likely way starting the daemon fails,
        // and it used to surface as a raw uncaught EADDRINUSE stack trace. Say what
        // happened and what to do about it.
        if (e instanceof ServeListenError) {
          console.error(e.message);
          if (e.code === "EADDRINUSE") {
            console.error(
              e.ownerPid === null
                ? `Find it with: lsof -ti tcp:${e.port} -sTCP:LISTEN — or start on another port with --port.`
                : `That is probably another ai2nao. Stop pid ${e.ownerPid}, or start on another port with --port.`
            );
          }
        } else {
          console.error(String(e));
        }
        atuin?.db.close();
        dailySummary?.cacheDb?.close();
        rag?.db.close();
        db.close();
        process.exitCode = 1;
        return;
      }
      console.error(`Listening ${url}`);
      if (!withStatic) {
        console.error(
          "API only. Run `npm run dev:ui` (Vite proxies /api) or `npm run build:web` then serve again for SPA."
        );
      }
      if (dailySummary) {
        console.error(
          `Daily summary enabled. Cache DB: ${dailySummary.runtime.cacheDbPath}`
        );
        if (!dailySummary.runtime.llm.baseUrl || !dailySummary.runtime.llm.model) {
          console.error(
            "Daily summary LLM not configured. Requests will degrade to factual recap until you set the chat model in 设置 → AI 与模型 (llm-chat)."
          );
        }
      }
      const shutdown = () => {
        try {
          // Fire and forget: everything that must happen before we exit (stop the
          // scheduler, withdraw the daemon record) runs synchronously inside
          // close(); only the socket teardown is async.
          void close();
        } finally {
          try {
            atuin?.db.close();
          } finally {
            try {
              dailySummary?.cacheDb.close();
            } finally {
              try {
                rag?.db.close();
              } finally {
                db.close();
              }
            }
          }
        }
      };
      process.on("SIGINT", () => {
        shutdown();
        process.exit(0);
      });
      process.on("SIGTERM", () => {
        shutdown();
        process.exit(0);
      });
    }
  );

const schedulerCmd = program
  .command("scheduler")
  .description("Run and inspect local scheduled sync tasks");

schedulerCmd
  .command("status")
  .description("List registered scheduler tasks and their latest run state")
  .option("--db <path>", "SQLite database path", defaultDbPath())
  .option("--json", "print machine-readable JSON", false)
  .action((opts: { db: string; json: boolean }) => {
    const db = openDatabase(opts.db);
    try {
      const runtime = createCliSchedulerRuntime(db);
      const tasks = listScheduledTasks(db, runtime.registry.list());
      if (opts.json) {
        console.log(JSON.stringify({ tasks }, null, 2));
        return;
      }
      for (const task of tasks) {
        const status = task.lastRun?.status ?? "never";
        const enabled = task.enabled ? "enabled" : "disabled";
        const next = task.nextRunAt ?? "-";
        console.log(`${task.key} [${enabled}] status=${status} next=${next}`);
      }
    } finally {
      db.close();
    }
  });

schedulerCmd
  .command("run <taskKey>")
  .description("Run one scheduler task once")
  .option("--db <path>", "SQLite database path", defaultDbPath())
  .option("--json", "print machine-readable JSON", false)
  .action(async (taskKey: string, opts: { db: string; json: boolean }) => {
    const db = openDatabase(opts.db);
    try {
      const runtime = createCliSchedulerRuntime(db);
      const result = await runtime.runNow(taskKey, "cli");
      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      if (!result.ok) {
        console.error(result.message);
        process.exitCode = result.status === "unknown_task" ? 2 : 1;
        return;
      }
      const err = result.run.errorSummary ? ` error=${result.run.errorSummary}` : "";
      console.log(`${taskKey} [${result.run.status}] run=${result.run.id}${err}`);
    } finally {
      db.close();
    }
  });

/** 交互终端单行刷新；CI / 重定向 则定期换行，避免刷几千行。 */
function createRagIngestProgressReporter() {
  const tty = process.stderr.isTTY === true;
  let lastNonTtyLog = 0;
  return {
    onProgress(p: IngestFileProgress) {
      if (p.total <= 0) return;
      const barW = 18;
      const done = Math.min(barW, Math.round((p.current / p.total) * barW));
      const bar = "#".repeat(done) + "-".repeat(barW - done);
      const cols = process.stderr.columns ?? 100;
      const pathMax = Math.max(16, cols - 36);
      const tail =
        p.relPath.length > pathMax
          ? "…" + p.relPath.slice(-(pathMax - 1))
          : p.relPath;
      const n = `${String(p.current).padStart(String(p.total).length)}/${p.total}`;
      const line = `RAG [${bar}] ${n} ${tail}`;
      if (tty) {
        process.stderr.write("\r\x1b[K" + line.slice(0, cols));
      } else {
        const t = Date.now();
        if (
          p.current === 1 ||
          p.current === p.total ||
          p.current % 50 === 0 ||
          t - lastNonTtyLog > 12000
        ) {
          console.error(line);
          lastNonTtyLog = t;
        }
      }
    },
    finish() {
      if (tty) {
        process.stderr.write("\n");
      }
    },
  };
}

const ragCmd = program
  .command("rag")
  .description("Index local Markdown/text into the RAG database (FTS5 + optional embeddings)");

ragCmd
  .command("ingest")
  .description(
    "Scan corpus roots, chunk, and upsert into the RAG DB. Use --root to override paths in rag.json."
  )
  .option(
    "-r, --root <path>",
    "corpus root (repeatable; when set, overrides corpusRoots in rag.json)",
    (v: string, prev: string[]) => [...prev, v],
    [] as string[]
  )
  .option("--rag-db <path>", "RAG SQLite path", defaultRagDbPath())
  .option(
    "--config <path>",
    "rag.json path (overrides AI2NAO_RAG_CONFIG / default)"
  )
  .option("--dry-run", "scan and print an incremental plan without writing indexes", false)
  .option("--force", "rebuild every matched file even when unchanged", false)
  .option("--repair", "only repair manifest rows marked partial/error/unhealthy", false)
  .option("--json", "print machine-readable JSON", false)
  .action(
    async (opts: {
      root: string[];
      ragDb: string;
      config?: string;
      dryRun: boolean;
      force: boolean;
      repair: boolean;
      json: boolean;
    }) => {
      const triedConfigPath = opts.config?.trim()
        ? resolve(opts.config.trim())
        : resolveRagConfigPath();
      const cfg = opts.config?.trim()
        ? readRagConfigFile(opts.config)
        : readRagConfig();
      if (!opts.json) {
        if (!cfg) {
          if (existsSync(triedConfigPath)) {
            console.error(
              `RAG: ${triedConfigPath} is not valid (require version: 1, non-empty corpusRoots, and parseable includeExtensions). See rag.config.example.json.`
            );
          } else {
            console.error(
              `RAG: no config at ${triedConfigPath}. Put corpusRoots there, or run with --config <path> or --root <dir>.`
            );
          }
        }
      }
      const ragEnvIngest = (process.env.AI2NAO_RAG_DB ?? "").trim();
      const dbPath =
        ragEnvIngest.length > 0 ? resolve(ragEnvIngest) : resolve(opts.ragDb);
      const db = openRagDatabase(dbPath);
      const progress = !opts.json ? createRagIngestProgressReporter() : null;
      try {
        const result = await ingestCorpus(db, cfg, opts.root, {
          dryRun: opts.dryRun,
          force: opts.force,
          repair: opts.repair,
          onProgress: progress?.onProgress,
        });
        if (opts.json) {
          console.log(
            JSON.stringify(
              { ok: true, ...result, ragDb: dbPath, configPath: triedConfigPath },
              null,
              2
            )
          );
        } else {
          console.error(
            `RAG ingest${result.dryRun ? " dry-run" : ""}: ${result.roots} root(s), indexed ${result.filesIndexed}, skipped ${result.filesSkipped}, deleted ${result.filesDeleted}, partial ${result.filesPartial}, seen ${result.filesSeen}, chunks ${result.chunksInserted} → ${dbPath}`
          );
          console.error(
            `Plan: new ${result.plan.index_new}, changed ${result.plan.index_changed}, force ${result.plan.force_rebuild}, repair ${result.plan.repair}, delete ${result.plan.delete_missing}, skip ${result.plan.skip}`
          );
          for (const err of result.errors) console.error(`warning: ${err}`);
          if (result.roots > 0 && result.filesSeen === 0) {
            console.error(
              "RAG: 0 files matched. Check that files exist under the roots, includeExtensions (e.g. .md) matches your file types, and paths are not wrong."
            );
          }
        }
        process.exitCode = result.errors.length ? 1 : 0;
      } finally {
        progress?.finish();
        db.close();
      }
    }
  );

ragCmd
  .command("optimize")
  .description("Run vector-store maintenance for the configured RAG vector database")
  .option(
    "--config <path>",
    "rag.json path (overrides AI2NAO_RAG_CONFIG / default)"
  )
  .option("--json", "print machine-readable JSON", false)
  .action(async (opts: { config?: string; json: boolean }) => {
    const cfg = opts.config?.trim()
      ? readRagConfigFile(opts.config)
      : readRagConfig();
    const store = createVectorStore(cfg);
    try {
      await store.optimize?.();
      if (opts.json) {
        console.log(JSON.stringify({ ok: true, provider: store.provider }, null, 2));
      } else {
        console.error(`RAG optimize: provider ${store.provider}`);
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (opts.json) {
        console.log(JSON.stringify({ ok: false, provider: store.provider, error: message }, null, 2));
      } else {
        console.error(`RAG optimize failed: ${message}`);
      }
      process.exitCode = 1;
    }
  });

ragCmd
  .command("cleanup-tombstones")
  .description("Remove deleted-file manifest tombstones older than a retention window")
  .option("--rag-db <path>", "RAG SQLite path", defaultRagDbPath())
  .option("--older-than-days <n>", "delete tombstones older than N days", "30")
  .option("--json", "print machine-readable JSON", false)
  .action((opts: { ragDb: string; olderThanDays: string; json: boolean }) => {
    const ragEnv = (process.env.AI2NAO_RAG_DB ?? "").trim();
    const dbPath = ragEnv.length > 0 ? resolve(ragEnv) : resolve(opts.ragDb);
    const days = Math.max(1, parseInt(opts.olderThanDays, 10) || 30);
    const olderThan = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const db = openRagDatabase(dbPath);
    try {
      const deleted = cleanupDeletedRagFileManifests(db, olderThan);
      if (opts.json) {
        console.log(JSON.stringify({ ok: true, ragDb: dbPath, olderThan: olderThan.toISOString(), deleted }, null, 2));
      } else {
        console.error(`RAG cleanup-tombstones: deleted ${deleted} row(s) older than ${olderThan.toISOString()}`);
      }
    } finally {
      db.close();
    }
  });

ragCmd
  .command("eval")
  .description("Run a small golden retrieval set and report Recall@K / MRR / NoHit")
  .requiredOption("--cases <path>", "JSON eval cases path")
  .option("--rag-db <path>", "RAG SQLite path", defaultRagDbPath())
  .option("--config <path>", "rag.json path (overrides AI2NAO_RAG_CONFIG / default)")
  .option("--top-k <n>", "retrieval depth", "8")
  .option("--json", "print machine-readable JSON", false)
  .action(
    async (opts: {
      cases: string;
      ragDb: string;
      config?: string;
      topK: string;
      json: boolean;
    }) => {
      const cfg = opts.config?.trim()
        ? readRagConfigFile(opts.config)
        : readRagConfig();
      const ragEnvEval = (process.env.AI2NAO_RAG_DB ?? "").trim();
      const dbPath = ragEnvEval.length > 0 ? resolve(ragEnvEval) : resolve(opts.ragDb);
      const db = openRagDatabase(dbPath);
      try {
        const topK = Math.min(50, Math.max(1, parseInt(opts.topK, 10) || 8));
        const cases = loadRagEvalCases(resolve(opts.cases));
        const result = await runRagEval({ db, cfg, cases, topK });
        if (opts.json) {
          console.log(JSON.stringify({ ...result, ragDb: dbPath }, null, 2));
        } else {
          console.log(
            `RAG eval: cases=${result.caseCount} topK=${result.topK} recall@K=${result.recallAtK.toFixed(3)} mrr=${result.mrr.toFixed(3)} noHit=${result.noHit}`
          );
          for (const item of result.cases) {
            const rank = item.firstRelevantRank == null ? "-" : String(item.firstRelevantRank);
            console.log(
              `${item.id}\trank=${rank}\thits=${item.hitCount}\t${item.matchedFilePath ?? "-"}`
            );
          }
        }
        process.exitCode = result.recallAtK < 1 ? 1 : 0;
      } finally {
        db.close();
      }
    }
  );

const cursorHistoryCmd = program
  .command("cursor-history")
  .description(
    "Read Cursor IDE local chat history (read-only; close Cursor if databases are locked)"
  );

cursorHistoryCmd
  .command("workspaces")
  .description("List workspaces under workspaceStorage that have chat sessions")
  .option(
    "--data-path <path>",
    "Cursor workspaceStorage root (default: platform path or CURSOR_DATA_PATH)"
  )
  .option("--json", "print JSON", false)
  .action(async (opts: { dataPath?: string; json: boolean }) => {
    try {
      const custom = opts.dataPath?.trim()
        ? expandPath(opts.dataPath.trim())
        : undefined;
      const rows = await listWorkspaces(custom);
      if (opts.json) {
        console.log(JSON.stringify({ ok: true, workspaces: rows }, null, 2));
      } else {
        for (const w of rows) {
          console.log(`${w.sessionCount}\t${w.path}\t${w.id}`);
        }
      }
    } catch (e) {
      console.error(String(e));
      process.exitCode = 1;
    }
  });

cursorHistoryCmd
  .command("list")
  .description("List chat sessions (deduped across workspaces)")
  .option("--data-path <path>", "Cursor workspaceStorage root")
  .option("--workspace <path>", "filter by workspace folder path")
  .option("-n, --limit <n>", "max sessions (ignored with --all)", "50")
  .option("--all", "list all sessions", false)
  .option("--json", "print JSON", false)
  .action(
    async (opts: {
      dataPath?: string;
      workspace?: string;
      limit: string;
      all: boolean;
      json: boolean;
    }) => {
      try {
        const custom = opts.dataPath?.trim()
          ? expandPath(opts.dataPath.trim())
          : undefined;
        const limit = Math.min(500, Math.max(1, parseInt(opts.limit, 10) || 50));
        const sessions = await listSessions(
          {
            limit: opts.all ? 0 : limit,
            all: opts.all,
            workspacePath: opts.workspace?.trim() || undefined,
          },
          custom
        );
        if (opts.json) {
          console.log(JSON.stringify({ ok: true, sessions }, null, 2));
        } else {
          for (const s of sessions) {
            const title = s.title ?? "(no title)";
            console.log(
              `${s.index}\t${s.id}\t${s.workspacePath}\t${title.slice(0, 60)}`
            );
          }
        }
      } catch (e) {
        console.error(String(e));
        process.exitCode = 1;
      }
    }
  );

cursorHistoryCmd
  .command("show")
  .description("Show one session by 1-based index (from list) or composer id")
  .argument("<id>", "index or composer UUID")
  .option("--data-path <path>", "Cursor workspaceStorage root")
  .option("--json", "print JSON (full messages)", false)
  .action(
    async (opts: { dataPath?: string; json: boolean }, id: string) => {
      try {
        const custom = opts.dataPath?.trim()
          ? expandPath(opts.dataPath.trim())
          : undefined;
        const session = await getSession(parseCursorSessionArg(id), custom);
        if (!session) {
          console.error("Session not found.");
          process.exitCode = 1;
          return;
        }
        if (opts.json) {
          const { sessionToJson } = await import("./cursorHistory/json.js");
          console.log(JSON.stringify({ ok: true, session: sessionToJson(session) }, null, 2));
        } else {
          console.log(
            `# ${session.title ?? "Untitled"}\n${session.workspacePath ?? ""}\nsource: ${session.source ?? ""}\n---`
          );
          for (const m of session.messages) {
            const ts = m.timestamp.toISOString();
            const who = m.role === "user" ? "User" : "Assistant";
            console.log(`\n[${who}] ${ts}\n${m.content}`);
          }
        }
      } catch (e) {
        console.error(String(e));
        process.exitCode = 1;
      }
    }
  );

cursorHistoryCmd
  .command("search")
  .description("Search message text across sessions (with match snippets)")
  .argument("<query>", "substring to find (case-insensitive)")
  .option("--data-path <path>", "Cursor workspaceStorage root")
  .option("--workspace <path>", "limit to workspace path")
  .option("-n, --limit <n>", "max results", "30")
  .option("-c, --context <n>", "snippet context chars", "80")
  .option("--json", "print JSON", false)
  .action(
    async (
      opts: {
        dataPath?: string;
        workspace?: string;
        limit: string;
        context: string;
        json: boolean;
      },
      query: string
    ) => {
      const q = query.trim();
      if (!q) {
        console.error("Empty query.");
        process.exitCode = 1;
        return;
      }
      try {
        const custom = opts.dataPath?.trim()
          ? expandPath(opts.dataPath.trim())
          : undefined;
        const limit = Math.min(200, Math.max(1, parseInt(opts.limit, 10) || 30));
        const contextChars = Math.min(
          500,
          Math.max(10, parseInt(opts.context, 10) || 80)
        );
        const results = await searchSessions(
          q,
          {
            limit,
            contextChars,
            workspacePath: opts.workspace?.trim() || undefined,
          },
          custom
        );
        if (opts.json) {
          const { searchResultToJson } = await import("./cursorHistory/json.js");
          console.log(
            JSON.stringify(
              {
                ok: true,
                query: q,
                results: results.map(searchResultToJson),
              },
              null,
              2
            )
          );
        } else {
          for (const r of results) {
            console.log(
              `#${r.index} ${r.sessionId} (${r.matchCount} matches) ${r.workspacePath}`
            );
            for (const sn of r.snippets) {
              console.log(`  [${sn.messageRole}] ${sn.text}`);
            }
          }
        }
      } catch (e) {
        console.error(String(e));
        process.exitCode = 1;
      }
    }
  );

cursorHistoryCmd
  .command("discover")
  .description("Show default Cursor paths and workspace count (quick health check)")
  .option("--data-path <path>", "override workspaceStorage root")
  .option("--json", "print JSON", false)
  .action(async (opts: { dataPath?: string; json: boolean }) => {
    try {
      const custom = opts.dataPath?.trim()
        ? expandPath(opts.dataPath.trim())
        : undefined;
      const workspaces = await findWorkspaces(custom);
      const base = getCursorDataPath(custom);
      if (opts.json) {
        console.log(
          JSON.stringify(
            { ok: true, workspaceStorage: base, workspaceCount: workspaces.length },
            null,
            2
          )
        );
      } else {
        console.error(`workspaceStorage: ${base}`);
        console.error(`workspaces with sessions: ${workspaces.length}`);
      }
    } catch (e) {
      console.error(String(e));
      process.exitCode = 1;
    }
  });

const attentionCmd = program
  .command("attention")
  .description(
    "Attention layer: read macOS knowledgeC foreground history (requires Full Disk Access)"
  );

attentionCmd
  .command("probe")
  .description(
    "Phase 0 diagnostic: can we read knowledgeC, how far back does it go, and do rows carry an end time"
  )
  .option("--path <path>", "override the knowledgeC path (for testing)")
  .option("--json", "print machine-readable JSON", false)
  .option(
    "--export <path>",
    "also write a de-identified /app/inFocus slice as a test fixture"
  )
  .option("--export-limit <n>", "rows to export (default 2000)", "2000")
  .action(
    (opts: {
      path?: string;
      json: boolean;
      export?: string;
      exportLimit: string;
    }) => {
      const report = probeAttentionSource(opts.path);

      if (opts.json) {
        console.log(JSON.stringify(report, null, 2));
      } else {
        console.error(`source:  ${report.source.sourcePath}`);
        console.error(`status:  ${report.source.status}`);
        console.error(
          `runtime: ${report.runtime} (feature ${report.featureWouldBeEnabled ? "enabled" : "disabled"} here)`
        );
        if (report.source.responsibleApp) {
          console.error(`GRANT TO: ${report.source.responsibleApp}`);
          console.error(
            "          (System Settings -> Privacy & Security -> Full Disk Access, then Cmd+Q that app and reopen)"
          );
        }
        if (report.source.detail) console.error(`detail:  ${report.source.detail}`);
        if (report.source.rawError) console.error(`error:   ${report.source.rawError}`);

        if (report.streams.length > 0) {
          console.error("");
          console.error("streams:");
          for (const s of report.streams) {
            const from =
              s.earliestMs === null
                ? "?"
                : new Date(s.earliestMs).toISOString().slice(0, 10);
            const to =
              s.latestMs === null
                ? "?"
                : new Date(s.latestMs).toISOString().slice(0, 10);
            console.error(
              `  ${s.stream.padEnd(28)} ${String(s.rows).padStart(8)} rows  ${from} .. ${to}  (${s.spanDays ?? "?"}d)`
            );
          }
        }

        if (report.endDate) {
          const ed = report.endDate;
          console.error("");
          console.error(
            `ZENDDATE: ${ed.verdict} — ${ed.nullEnd} of ${ed.sampled} sampled rows have no end time` +
              (ed.zeroDuration > 0
                ? `, ${ed.zeroDuration} are zero-length flickers`
                : "") +
              (ed.maxDurationMs === null
                ? ""
                : `, longest span ${Math.round(ed.maxDurationMs / 60000)} min`)
          );
          if (ed.verdict === "reliable") {
            console.error(
              "          rows close themselves, so no closing stream is needed; drop the zero-length ones with a minimum-duration filter"
            );
          } else {
            const available = CLOSING_STREAMS.filter((s) =>
              report.streams.some((x) => x.stream === s)
            );
            console.error(
              available.length > 0
                ? `          spans will need closing from ${available.join(", ")}, or sleep turns into one fake span per night`
                : "          spans need closing but NONE of the usual closing streams exist here — this needs a different answer"
            );
          }
        }

        console.error("");
        console.error(
          `PHASE 0 GATE: ${report.gate.passed ? "PASS" : "FAIL"} — ${report.gate.reason}`
        );
      }

      if (opts.export) {
        if (report.source.status !== "ok") {
          console.error(`export skipped: source is ${report.source.status}`);
        } else {
          const limit = Number.parseInt(opts.exportLimit, 10);
          const res = exportFixture(opts.export, {
            sourcePath: opts.path,
            limit: Number.isFinite(limit) && limit > 0 ? limit : 2000,
          });
          console.error(
            `fixture: ${res.rows} rows, ${res.distinctBundles} bundles anonymized, timestamps rebased -> ${res.outPath}`
          );
        }
      }

      process.exitCode = report.gate.passed ? 0 : 1;
    }
  );

// `from: "node"` 是显式的,不是多余的。commander 的自动检测看到
// `process.versions.electron` 就会切到 electron 解析模式(见 commander
// lib/command.js:981),按 argv.slice(1) 而不是 slice(2) 取参数。桌面版的 daemon
// 正是用 ELECTRON_RUN_AS_NODE 跑的 —— 是 Electron 的二进制,但语义上就是 node,
// 于是脚本路径本身会被当成子命令,报 "unknown command '.../daemon.mjs'"。
// 这里的调用形态永远是 [执行文件, 脚本, ...参数],所以直接说清楚。

/**
 * agent_user_messages 的重扫入口。
 *
 * 存在的理由:给这张表加新的**行类型**(比如 2026-08 加 assistant 行)之后,已有的
 * 水位会挡住回填 —— 旧文件的 mtime 都在水位之下,永远不会被重扫,而 ingest 的
 * lastStatus 一直是 success。实测后果:codex 的 AI 正文一条都没有,claude 的只有
 * 最近三周,而它的提问能回到 4 月。
 *
 * `--full` 把水位置 0 再跑。upsert 走 UNIQUE(source, session, key) 天然幂等,
 * 不会重复插行 —— 但它是 ON CONFLICT DO UPDATE,**会重写已存在行的 cleaned_text**。
 * 所以这个命令跑前跑后各拍一次快照并打出差异,让「顺带把旧行重清洗了」这件事
 * 是看得见的,而不是一个只有读过代码的人才知道的副作用。
 */
const agentMessagesCmd = program
  .command("agent-messages")
  .description("Cross-agent conversation index (agent_user_messages)");

type AumSourceName = "claude" | "codex" | "opencode" | "kimi";
const AUM_SOURCES: AumSourceName[] = ["claude", "codex", "opencode", "kimi"];

agentMessagesCmd
  .command("resync")
  .description(
    "Re-run the conversation ingests. With --full, reset watermarks to 0 first so pre-existing files get re-scanned (needed after adding a new row type)."
  )
  .option("--db <path>", "SQLite database path", defaultDbPath())
  .option(
    "--source <name>",
    "claude | codex | opencode | kimi | all",
    "all"
  )
  .option("--full", "reset watermarks to 0 (re-scan everything)", false)
  .option("--json", "print machine-readable JSON", false)
  .action(
    async (opts: { db: string; source: string; full: boolean; json: boolean }) => {
      const want =
        opts.source === "all"
          ? AUM_SOURCES
          : AUM_SOURCES.filter((s) => s === opts.source);
      if (want.length === 0) {
        console.error(`unknown --source ${opts.source}; expected one of: all ${AUM_SOURCES.join(" ")}`);
        process.exitCode = 1;
        return;
      }

      const db = openDatabase(opts.db);
      try {
        const snapshot = () =>
          db
            .prepare(
              `SELECT source, role, is_human AS isHuman, cleaner_version AS cleanerVersion,
                      COUNT(*) AS rows, SUM(char_len) AS chars
               FROM agent_user_messages GROUP BY 1,2,3,4 ORDER BY 1,2,3,4`
            )
            .all() as {
            source: string; role: string; isHuman: number;
            cleanerVersion: number; rows: number; chars: number;
          }[];

        const before = snapshot();

        if (opts.full) {
          for (const src of want) {
            const st = getSyncState(db, src);
            setSyncState(db, src, {
              watermarkMs: 0,
              lastRunAt: st?.lastRunAt ?? null,
              lastStatus: st?.lastStatus ?? null,
              lastError: st?.lastError ?? null,
            });
          }
        }

        const results: Record<string, unknown> = {};
        for (const src of want) {
          if (src === "claude") results[src] = await ingestClaudeUserMessages(db);
          else if (src === "codex") results[src] = await ingestCodexUserMessages(db);
          else if (src === "opencode") results[src] = ingestOpencodeUserMessages(db);
          else results[src] = ingestKimiUserMessages(db);
        }

        const after = snapshot();
        const key = (r: { source: string; role: string; isHuman: number; cleanerVersion: number }) =>
          `${r.source}/${r.role}/human=${r.isHuman}/cleaner=v${r.cleanerVersion}`;
        const beforeMap = new Map(before.map((r) => [key(r), r]));
        const afterMap = new Map(after.map((r) => [key(r), r]));
        const changed: { key: string; rows: string; chars: string }[] = [];
        for (const k of new Set([...beforeMap.keys(), ...afterMap.keys()])) {
          const b = beforeMap.get(k);
          const a = afterMap.get(k);
          if (b?.rows === a?.rows && b?.chars === a?.chars) continue;
          changed.push({
            key: k,
            rows: `${b?.rows ?? 0} → ${a?.rows ?? 0}`,
            chars: `${b?.chars ?? 0} → ${a?.chars ?? 0}`,
          });
        }

        /**
         * 真人消息条数的逐源变化。
         *
         * 这里刻意**不做硬断言**。`--full` 会把已存在的行也重跑一遍清洗器
         * (upsert 是 ON CONFLICT DO UPDATE),而清洗器升级本来就可能改变
         * is_human —— 实测 claude 从 v3 升到 v4 后有 15 行被正确地重判为非人
         * (内容是 "Base directory for this skill: ..." 这类机器注入,v3 误当成了人话)。
         * 所以这是一份**要你看一眼**的报告,不是一个会误报的闸门。
         * 真正不该发生的只有一件:某个原本有数据的源变成了 0。
         */
        const humanBySource = (rows: typeof before) => {
          const m = new Map<string, number>();
          for (const r of rows) {
            if (r.isHuman !== 1) continue;
            m.set(r.source, (m.get(r.source) ?? 0) + r.rows);
          }
          return m;
        };
        const hb = humanBySource(before);
        const ha = humanBySource(after);
        const humanDelta = [...new Set([...hb.keys(), ...ha.keys()])].sort().map((src) => ({
          source: src,
          before: hb.get(src) ?? 0,
          after: ha.get(src) ?? 0,
        }));
        const wiped = humanDelta.filter((d) => d.before > 0 && d.after === 0);
        const humanBefore = [...hb.values()].reduce((n, v) => n + v, 0);
        const humanAfter = [...ha.values()].reduce((n, v) => n + v, 0);

        if (opts.json) {
          console.log(JSON.stringify({ results, changed, humanDelta, humanBefore, humanAfter }, null, 2));
        } else {
          for (const [src, r] of Object.entries(results)) {
            console.error(`${src.padEnd(9)} ${JSON.stringify(r)}`);
          }
          console.error("");
          if (changed.length === 0) {
            console.error("没有任何分组发生变化。");
          } else {
            console.error("变化的分组(行数 / 字数):");
            for (const c of changed.sort((x, y) => x.key.localeCompare(y.key))) {
              console.error(`  ${c.key.padEnd(46)} ${c.rows.padEnd(18)} ${c.chars}`);
            }
          }
          console.error("");
          console.error("真人消息条数(逐源):");
          for (const d of humanDelta) {
            const diff = d.after - d.before;
            const tag = diff === 0 ? "" : diff > 0 ? `  (+${diff})` : `  (${diff})`;
            console.error(`  ${d.source.padEnd(9)} ${d.before} → ${d.after}${tag}`);
          }
          console.error(`  ${"合计".padEnd(9)} ${humanBefore} → ${humanAfter}`);
          if (humanDelta.some((d) => d.after < d.before)) {
            console.error(
              "  注:条数下降通常是清洗器升级把机器注入重判为非人 —— 用 --json 看 changed 里的 cleaner 分组确认。"
            );
          }
        }
        if (wiped.length > 0) {
          console.error(
            `原本有数据的源变成了 0: ${wiped.map((w) => w.source).join(", ")}`
          );
          process.exitCode = 1;
        }
      } finally {
        db.close();
      }
    }
  );

program.parseAsync(process.argv, { from: "node" }).catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
});
