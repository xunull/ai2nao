#!/usr/bin/env node
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { Command } from "commander";
import { join, resolve } from "node:path";
import { openDailySummaryCacheDatabase } from "./dailySummary/cache.js";
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
import { openRagDatabase } from "./rag/open.js";
import { defaultDownloadRoots } from "./downloads/roots.js";
import {
  defaultChromeHistoryPath,
  isChromeHistoryIndexingSupported,
} from "./chromeHistory/paths.js";
import { syncChromeHistory } from "./chromeHistory/sync.js";
import { rebuildChromeHistoryVisitDomains } from "./chromeHistory/domainPivot.js";
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
import { runServe } from "./serve/runServe.js";
import { resolveWebDist } from "./serve/app.js";
import { syncBrewPackages } from "./software/brew/sync.js";
import { syncMacApps } from "./software/macApps/sync.js";
import { resetSoftwareSource } from "./software/reset.js";
import { getVscodeMirrorStatus } from "./vscode/queries.js";
import { resetVscodeRecent } from "./vscode/reset.js";
import { syncVscodeRecent } from "./vscode/sync.js";
import { parseVscodeAppId } from "./vscode/paths.js";
import { listVscodeWindowProjects } from "./vscode/windowState.js";
import { vscodeAppLabel } from "./vscode/labels.js";
import type { VscodeAppId } from "./vscode/types.js";
import { openDatabase, openReadOnlyDatabase } from "./store/open.js";
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

program
  .name("ai2nao")
  .description("Local-first indexer for git repos and manifest files")
  .version("0.1.0");

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
  .action((opts: { root: string[]; db: string; json: boolean }) => {
    const roots = (opts.root?.length ? opts.root : [process.cwd()]).map((r) =>
      resolve(r)
    );
    const db = openDatabase(opts.db);
    try {
      const result = runScan(db, roots);
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
    "--llm-base-url <url>",
    "OpenAI-compatible local LLM base URL (or AI2NAO_LLM_BASE_URL)"
  )
  .option(
    "--llm-model <name>",
    "local LLM model name (or AI2NAO_LLM_MODEL)"
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
    (opts: {
      db: string;
      host: string;
      port: string;
      apiOnly: boolean;
      atuinDb?: string;
      dailySummary: boolean;
      dailySummaryDb: string;
      llmBaseUrl?: string;
      llmModel?: string;
      llmTimeoutMs: string;
      ragDb: string;
    }) => {
      let db;
      try {
        db = openDatabase(opts.db);
      } catch (e) {
        console.error(String(e));
        process.exitCode = 1;
        return;
      }

      let atuin: { db: ReturnType<typeof openReadOnlyDatabase>; path: string } | undefined;
      let dailySummary:
        | {
            cacheDb: ReturnType<typeof openDailySummaryCacheDatabase>;
            runtime: {
              enabled: boolean;
              cacheDbPath: string;
              llm: {
                baseUrl: string | null;
                model: string | null;
                timeoutMs: number;
              };
            };
          }
        | undefined;
      const explicitAtuin = opts.atuinDb?.trim();
      const defaultAtuinPath = join(homedir(), ".local/share/atuin/history.db");
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
        const llmBaseUrl =
          opts.llmBaseUrl?.trim() || process.env.AI2NAO_LLM_BASE_URL || null;
        const llmModel =
          opts.llmModel?.trim() || process.env.AI2NAO_LLM_MODEL || null;
        const llmTimeoutMs = Math.max(
          1_000,
          parseInt(opts.llmTimeoutMs, 10) || 30_000
        );
        dailySummary = {
          cacheDb: openDailySummaryCacheDatabase(cacheDbPath),
          runtime: {
            enabled: true,
            cacheDbPath,
            llm: {
              baseUrl: llmBaseUrl,
              model: llmModel,
              timeoutMs: llmTimeoutMs,
            },
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
      const dist = resolveWebDist(process.cwd());
      const withStatic = !opts.apiOnly && existsSync(dist);
      const { url, close } = runServe({
        db,
        atuin,
        dailySummary,
        rag,
        host: opts.host,
        port,
        withStatic,
        cwd: process.cwd(),
      });
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
            "Daily summary LLM not fully configured. Requests will degrade to factual recap until --llm-base-url and --llm-model (or env vars) are provided."
          );
        }
      }
      const shutdown = () => {
        try {
          close();
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
  .option("--json", "print machine-readable JSON", false)
  .action(
    async (opts: {
      root: string[];
      ragDb: string;
      config?: string;
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
            `RAG ingest: ${result.roots} root(s), ${result.filesIndexed}/${result.filesSeen} file(s), ${result.chunksInserted} chunk(s) → ${dbPath}`
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

program.parse();
