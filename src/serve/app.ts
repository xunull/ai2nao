import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { cors } from "hono/cors";
import type Database from "better-sqlite3";
import {
  getManifestByRepoAndRelPath,
  getRepoById,
  listManifestsForRepo,
  listRepos,
} from "../read/queries.js";
import { getStatusSummary, searchManifests } from "../store/operations.js";

const MAX_SEARCH_QUERY_LEN = 4000;
const MAX_SEARCH_LIMIT = 100;

export type ServeOptions = {
  db: Database.Database;
  /** Absolute path to `web/dist` when serving production build; omit in dev (Vite handles UI). */
  staticRoot?: string;
};

function jsonErr(status: number, message: string) {
  return Response.json({ error: { message } }, { status });
}

export function createApp(opts: ServeOptions): Hono {
  const { db } = opts;
  const app = new Hono();

  app.use(
    "/api/*",
    cors({
      origin: ["http://127.0.0.1:5173", "http://localhost:5173"],
      allowMethods: ["GET", "OPTIONS"],
    })
  );

  app.get("/api/status", (c) => {
    try {
      return c.json(getStatusSummary(db));
    } catch (e) {
      return jsonErr(500, String(e));
    }
  });

  app.get("/api/repos", (c) => {
    try {
      const page = Math.max(1, parseInt(c.req.query("page") ?? "1", 10) || 1);
      const limit = Math.min(
        100,
        Math.max(1, parseInt(c.req.query("limit") ?? "50", 10) || 50)
      );
      const { rows, total } = listRepos(db, page, limit);
      return c.json({ repos: rows, total, page, limit });
    } catch (e) {
      return jsonErr(500, String(e));
    }
  });

  app.get("/api/repos/:id", (c) => {
    try {
      const id = parseInt(c.req.param("id"), 10);
      if (Number.isNaN(id)) return jsonErr(400, "invalid repo id");
      const repo = getRepoById(db, id);
      if (!repo) return jsonErr(404, "repo not found");
      const manifests = listManifestsForRepo(db, id);
      return c.json({ repo, manifests });
    } catch (e) {
      return jsonErr(500, String(e));
    }
  });

  app.get("/api/repos/:id/manifest", (c) => {
    try {
      const id = parseInt(c.req.param("id"), 10);
      if (Number.isNaN(id)) return jsonErr(400, "invalid repo id");
      const raw = (c.req.query("path") ?? "").trim();
      if (!raw) return jsonErr(400, "missing path query");
      const repo = getRepoById(db, id);
      if (!repo) return jsonErr(404, "repo not found");
      const manifest = getManifestByRepoAndRelPath(db, id, raw);
      if (!manifest) return jsonErr(404, "manifest not found");
      return c.json({ repo, manifest });
    } catch (e) {
      return jsonErr(500, String(e));
    }
  });

  app.get("/api/search", (c) => {
    try {
      const raw = c.req.query("q") ?? "";
      const q = raw.trim();
      if (!q) return jsonErr(400, "missing q");
      if (q.length > MAX_SEARCH_QUERY_LEN) return jsonErr(400, "query too long");
      const limit = Math.min(
        MAX_SEARCH_LIMIT,
        Math.max(1, parseInt(c.req.query("limit") ?? "30", 10) || 30)
      );
      let hits;
      try {
        hits = searchManifests(db, q, limit);
      } catch (e) {
        return jsonErr(400, `invalid search: ${String(e)}`);
      }
      return c.json({ hits, q, limit });
    } catch (e) {
      return jsonErr(500, String(e));
    }
  });

  const staticRoot = opts.staticRoot;
  if (staticRoot && existsSync(staticRoot)) {
    app.use("/assets/*", serveStatic({ root: staticRoot }));
    app.get("*", async (c) => {
      if (c.req.path.startsWith("/api")) return c.notFound();
      const indexPath = join(staticRoot, "index.html");
      if (!existsSync(indexPath)) return c.notFound();
      const html = await readFile(indexPath, "utf8");
      return c.html(html);
    });
  }

  return app;
}

/** Resolve `web/dist` from project root (cwd). */
export function resolveWebDist(cwd: string = process.cwd()): string {
  return join(cwd, "web", "dist");
}
