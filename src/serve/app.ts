import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { cors } from "hono/cors";
import type Database from "better-sqlite3";
import {
  listAtuinHistoryForDay,
  listAtuinHistoryMonthCounts,
} from "../atuin/queries.js";
import {
  generateDailySummary,
  getDailySummaryStatus,
  type DailySummaryRuntimeOptions,
} from "../dailySummary/service.js";
import {
  defaultDownloadRoots,
  isDownloadsIndexingSupported,
} from "../downloads/roots.js";
import {
  listDownloadsForDay,
  listDownloadsMonthCounts,
} from "../downloads/queries.js";
import { scanDownloads } from "../downloads/scan.js";
import { registerChromeHistoryRoutes } from "../chromeHistory/routes.js";
import {
  getManifestByRepoAndRelPath,
  getRepoById,
  listManifestsForRepo,
  listRepos,
} from "../read/queries.js";
import { getStatusSummary, searchManifests } from "../store/operations.js";
import {
  expandPath,
  findWorkspaces,
  getCursorDataPath,
  getSession,
  listSessions,
  listWorkspaces,
  searchSessions,
} from "../cursorHistory/index.js";
import {
  searchResultToJson,
  sessionSummaryToJson,
  sessionToJson,
  workspaceToJson,
} from "../cursorHistory/json.js";
import {
  ClaudeTranscriptTooLargeError,
  listProjects,
  listSessionSummaries,
  loadSessionDetail,
  resolveClaudeProjectsRoot,
} from "../claudeCodeHistory/index.js";
import { registerLlmChatRoutes } from "../llmChat/routes.js";
import { registerGithubRoutes } from "../github/routes.js";
import { registerRagRoutes } from "../rag/routes.js";
import { registerSoftwareRoutes } from "../software/routes.js";

const MAX_SEARCH_QUERY_LEN = 4000;
const MAX_SEARCH_LIMIT = 100;

function cursorHistoryDataPath(raw: string | undefined): string | undefined {
  const t = (raw ?? "").trim();
  return t.length > 0 ? expandPath(t) : undefined;
}

function cursorHistoryIdentifier(param: string): number | string {
  const t = param.trim();
  if (/^\d+$/.test(t)) return parseInt(t, 10);
  try {
    return decodeURIComponent(t);
  } catch {
    return t;
  }
}

function cursorHistoryErr(e: unknown) {
  const msg = String(e);
  if (/SQLITE_BUSY|database is locked/i.test(msg)) {
    return jsonErr(
      503,
      "Cursor SQLite database is locked; close Cursor IDE and retry."
    );
  }
  return jsonErr(500, msg);
}

function claudeCodeHistoryRoot(raw: string | undefined): string {
  const t = (raw ?? "").trim();
  return resolveClaudeProjectsRoot(t.length > 0 ? t : undefined);
}

function claudeCodeHistoryErr(e: unknown) {
  if (e instanceof ClaudeTranscriptTooLargeError) {
    return jsonErr(413, e.message);
  }
  return jsonErr(500, String(e));
}

export type ServeOptions = {
  db: Database.Database;
  /** Absolute path to `web/dist` when serving production build; omit in dev (Vite handles UI). */
  staticRoot?: string;
  /** Optional read-only Atuin `history.db` (separate SQLite file). */
  atuin?: { db: Database.Database; path: string };
  dailySummary?: {
    cacheDb: Database.Database | null;
    runtime: DailySummaryRuntimeOptions;
  };
  /** Optional RAG chunk index (`~/.ai2nao/rag.db`). */
  rag?: { db: Database.Database; path: string };
};

function jsonErr(status: number, message: string) {
  return Response.json({ error: { message } }, { status });
}

export function createApp(opts: ServeOptions): Hono {
  const { db, atuin, dailySummary, rag } = opts;
  const app = new Hono();

  app.use(
    "/api/*",
    cors({
      origin: ["http://127.0.0.1:5173", "http://localhost:5173"],
      allowMethods: ["GET", "POST", "OPTIONS"],
    })
  );

  registerLlmChatRoutes(app, { ragDb: rag?.db });
  registerRagRoutes(app, rag ? { db: rag.db, dbPath: rag.path } : undefined);
  registerGithubRoutes(app, db);
  registerSoftwareRoutes(app, db);
  registerChromeHistoryRoutes(app, db);

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

  app.get("/api/atuin/status", (c) => {
    try {
      if (!atuin) {
        return c.json({ enabled: false as const });
      }
      return c.json({ enabled: true as const, path: atuin.path });
    } catch (e) {
      return jsonErr(500, String(e));
    }
  });

  app.get("/api/atuin/month", (c) => {
    try {
      if (!atuin) return jsonErr(503, "Atuin history not configured");
      const y = parseInt(c.req.query("year") ?? "", 10);
      const m = parseInt(c.req.query("month") ?? "", 10);
      if (Number.isNaN(y) || y < 1970 || y > 2100) {
        return jsonErr(400, "invalid year");
      }
      if (Number.isNaN(m) || m < 1 || m > 12) {
        return jsonErr(400, "invalid month");
      }
      const days = listAtuinHistoryMonthCounts(atuin.db, y, m);
      return c.json({
        year: y,
        month: m,
        days,
        timezone: "local",
      });
    } catch (e) {
      return jsonErr(500, String(e));
    }
  });

  app.get("/api/atuin/day", (c) => {
    try {
      if (!atuin) return jsonErr(503, "Atuin history not configured");
      const date = (c.req.query("date") ?? "").trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return jsonErr(400, "invalid date (use YYYY-MM-DD)");
      }
      const entries = listAtuinHistoryForDay(atuin.db, date);
      return c.json({ date, entries, timezone: "local" });
    } catch (e) {
      if (e instanceof Error && e.message === "invalid date") {
        return jsonErr(400, "invalid date");
      }
      return jsonErr(500, String(e));
    }
  });

  app.get("/api/daily-summary/status", (c) => {
    if (!dailySummary) {
      return c.json({
        enabled: false as const,
        modelConfigured: false as const,
        model: null,
        cacheDbPath: null,
      });
    }
    return c.json(getDailySummaryStatus(dailySummary.runtime));
  });

  app.post("/api/daily-summary", async (c) => {
    try {
      if (!dailySummary?.runtime.enabled) {
        return jsonErr(503, "Daily summary is not enabled for this server");
      }
      if (!atuin) return jsonErr(503, "Atuin history not configured");

      const body = (await c.req.json().catch(() => ({}))) as {
        date?: unknown;
        refresh?: unknown;
      };
      const date = typeof body.date === "string" ? body.date.trim() : "";
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return jsonErr(400, "invalid date (use YYYY-MM-DD)");
      }

      const entries = listAtuinHistoryForDay(atuin.db, date);
      const payload = await generateDailySummary({
        date,
        refresh: body.refresh === true,
        indexDb: db,
        atuinEntries: entries,
        cacheDb: dailySummary.cacheDb,
        runtime: dailySummary.runtime,
      });
      return c.json(payload);
    } catch (e) {
      return jsonErr(500, String(e));
    }
  });

  app.get("/api/downloads/status", (c) => {
    const supported = isDownloadsIndexingSupported();
    const defaultRoots = defaultDownloadRoots();
    return c.json({
      supported,
      defaultRoots,
      platform: process.platform,
    });
  });

  app.get("/api/downloads/month", (c) => {
    try {
      const y = parseInt(c.req.query("year") ?? "", 10);
      const m = parseInt(c.req.query("month") ?? "", 10);
      if (Number.isNaN(y) || y < 1970 || y > 2100) {
        return jsonErr(400, "invalid year");
      }
      if (Number.isNaN(m) || m < 1 || m > 12) {
        return jsonErr(400, "invalid month");
      }
      const days = listDownloadsMonthCounts(db, y, m);
      return c.json({
        year: y,
        month: m,
        days,
        timezone: "local",
      });
    } catch (e) {
      return jsonErr(500, String(e));
    }
  });

  app.get("/api/downloads/day", (c) => {
    try {
      const date = (c.req.query("date") ?? "").trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return jsonErr(400, "invalid date (use YYYY-MM-DD)");
      }
      const entries = listDownloadsForDay(db, date);
      return c.json({ date, entries, timezone: "local" });
    } catch (e) {
      return jsonErr(500, String(e));
    }
  });

  app.get("/api/cursor-history/status", (c) => {
    try {
      const dataPath = cursorHistoryDataPath(c.req.query("dataPath"));
      const base = getCursorDataPath(dataPath);
      return c.json({
        platform: process.platform,
        workspaceStorage: base,
        envCursorDataPath: Boolean(process.env.CURSOR_DATA_PATH),
      });
    } catch (e) {
      return cursorHistoryErr(e);
    }
  });

  app.get("/api/cursor-history/discover", async (c) => {
    try {
      const dataPath = cursorHistoryDataPath(c.req.query("dataPath"));
      const workspaces = await findWorkspaces(dataPath);
      return c.json({
        ok: true,
        workspaceStorage: getCursorDataPath(dataPath),
        workspaceCount: workspaces.length,
        workspaces: workspaces.map(workspaceToJson),
      });
    } catch (e) {
      return cursorHistoryErr(e);
    }
  });

  app.get("/api/cursor-history/workspaces", async (c) => {
    try {
      const dataPath = cursorHistoryDataPath(c.req.query("dataPath"));
      const rows = await listWorkspaces(dataPath);
      return c.json({ ok: true, workspaces: rows.map(workspaceToJson) });
    } catch (e) {
      return cursorHistoryErr(e);
    }
  });

  app.get("/api/cursor-history/sessions", async (c) => {
    try {
      const dataPath = cursorHistoryDataPath(c.req.query("dataPath"));
      const all = c.req.query("all") === "1" || c.req.query("all") === "true";
      const limit = Math.min(
        500,
        Math.max(1, parseInt(c.req.query("limit") ?? "50", 10) || 50)
      );
      const offset = Math.max(
        0,
        Math.min(1_000_000, parseInt(c.req.query("offset") ?? "0", 10) || 0)
      );
      const workspacePath = (c.req.query("workspace") ?? "").trim() || undefined;
      if (all) {
        const sessions = await listSessions(
          { limit: 0, all: true, workspacePath },
          dataPath
        );
        return c.json({
          ok: true,
          sessions: sessions.map(sessionSummaryToJson),
          total: sessions.length,
          offset: 0,
          limit: sessions.length,
        });
      }
      const full = await listSessions(
        { limit: 0, all: true, workspacePath },
        dataPath
      );
      const lastPageStart =
        full.length === 0
          ? 0
          : Math.max(0, (Math.ceil(full.length / limit) - 1) * limit);
      const safeOffset = Math.min(offset, lastPageStart);
      const page = full.slice(safeOffset, safeOffset + limit);
      return c.json({
        ok: true,
        sessions: page.map(sessionSummaryToJson),
        total: full.length,
        offset: safeOffset,
        limit,
      });
    } catch (e) {
      return cursorHistoryErr(e);
    }
  });

  app.get("/api/cursor-history/sessions/:sessionId", async (c) => {
    try {
      const dataPath = cursorHistoryDataPath(c.req.query("dataPath"));
      const session = await getSession(
        cursorHistoryIdentifier(c.req.param("sessionId")),
        dataPath
      );
      if (!session) {
        return jsonErr(404, "session not found");
      }
      return c.json({ ok: true, session: sessionToJson(session) });
    } catch (e) {
      return cursorHistoryErr(e);
    }
  });

  app.get("/api/cursor-history/search", async (c) => {
    try {
      const q = (c.req.query("q") ?? "").trim();
      if (!q) return jsonErr(400, "missing q");
      if (q.length > MAX_SEARCH_QUERY_LEN) {
        return jsonErr(400, "query too long");
      }
      const dataPath = cursorHistoryDataPath(c.req.query("dataPath"));
      const limit = Math.min(
        200,
        Math.max(1, parseInt(c.req.query("limit") ?? "30", 10) || 30)
      );
      const contextChars = Math.min(
        500,
        Math.max(10, parseInt(c.req.query("context") ?? "80", 10) || 80)
      );
      const workspacePath = (c.req.query("workspace") ?? "").trim() || undefined;
      const results = await searchSessions(
        q,
        { limit, contextChars, workspacePath },
        dataPath
      );
      return c.json({
        ok: true,
        q,
        results: results.map(searchResultToJson),
      });
    } catch (e) {
      return cursorHistoryErr(e);
    }
  });

  app.get("/api/claude-code-history/status", (c) => {
    try {
      const root = claudeCodeHistoryRoot(c.req.query("projectsRoot"));
      return c.json({
        platform: process.platform,
        projectsRoot: root,
        envClaudeCodeProjectsRoot: Boolean(
          process.env.CLAUDE_CODE_PROJECTS_ROOT
        ),
      });
    } catch (e) {
      return claudeCodeHistoryErr(e);
    }
  });

  app.get("/api/claude-code-history/projects", async (c) => {
    try {
      const root = claudeCodeHistoryRoot(c.req.query("projectsRoot"));
      const projects = await listProjects(root);
      return c.json({
        ok: true,
        projectsRoot: root,
        projects: projects.map((p) => ({
          id: p.id,
          path: p.path,
          sessionCount: p.sessionCount,
          decodedWorkspacePath: p.decodedWorkspacePath,
          slugDecodeIncomplete: p.slugDecodeIncomplete,
        })),
      });
    } catch (e) {
      return claudeCodeHistoryErr(e);
    }
  });

  app.get("/api/claude-code-history/projects/:projectId/sessions", async (c) => {
    try {
      const root = claudeCodeHistoryRoot(c.req.query("projectsRoot"));
      const projectId = decodeURIComponent(c.req.param("projectId"));
      const rows = await listSessionSummaries(root, projectId);
      return c.json({
        ok: true,
        sessions: rows.map(sessionSummaryToJson),
      });
    } catch (e) {
      return claudeCodeHistoryErr(e);
    }
  });

  app.get(
    "/api/claude-code-history/projects/:projectId/sessions/:sessionId",
    async (c) => {
      try {
        const root = claudeCodeHistoryRoot(c.req.query("projectsRoot"));
        const projectId = decodeURIComponent(c.req.param("projectId"));
        const sessionId = decodeURIComponent(c.req.param("sessionId"));
        const detail = await loadSessionDetail(root, projectId, sessionId);
        if (!detail) {
          return jsonErr(404, "session not found");
        }
        const idx = Math.max(
          0,
          parseInt(c.req.query("index") ?? "0", 10) || 0
        );
        detail.session.index = idx;
        return c.json({
          ok: true,
          session: sessionToJson(detail.session),
          warnings: detail.warnings,
        });
      } catch (e) {
        return claudeCodeHistoryErr(e);
      }
    }
  );

  app.post("/api/downloads/scan", async (c) => {
    try {
      const body = (await c.req.json().catch(() => ({}))) as {
        roots?: unknown;
      };
      let roots: string[] = defaultDownloadRoots();
      if (Array.isArray(body.roots) && body.roots.length > 0) {
        roots = body.roots
          .filter((x): x is string => typeof x === "string")
          .map((r) => resolve(r.trim()))
          .filter((r) => r.length > 0);
      }
      if (roots.length === 0) {
        return jsonErr(
          400,
          "no download roots (unsupported platform or empty roots); pass { \"roots\": [\"/path\"] } to override"
        );
      }
      const result = scanDownloads(db, roots);
      return c.json({ ok: true, ...result });
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
