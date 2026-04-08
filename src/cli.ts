#!/usr/bin/env node
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { Command } from "commander";
import { join, resolve } from "node:path";
import { openDailySummaryCacheDatabase } from "./dailySummary/cache.js";
import {
  defaultDailySummaryDbPath,
  defaultDbPath,
} from "./config.js";
import { defaultDownloadRoots } from "./downloads/roots.js";
import { scanDownloads } from "./downloads/scan.js";
import { runScan } from "./scan/runScan.js";
import { runServe } from "./serve/runServe.js";
import { resolveWebDist } from "./serve/app.js";
import { openDatabase, openReadOnlyDatabase } from "./store/open.js";
import { getStatusSummary, searchManifests } from "./store/operations.js";

const program = new Command();

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

      const port = Math.max(1, parseInt(opts.port, 10) || 8787);
      const dist = resolveWebDist(process.cwd());
      const withStatic = !opts.apiOnly && existsSync(dist);
      const { url, close } = runServe({
        db,
        atuin,
        dailySummary,
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
              db.close();
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

program.parse();
