#!/usr/bin/env node
import { Command } from "commander";
import { resolve } from "node:path";
import { defaultDbPath } from "./config.js";
import { runScan } from "./scan/runScan.js";
import { openDatabase } from "./store/open.js";
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

program.parse();
