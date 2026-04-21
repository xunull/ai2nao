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
import {
  defaultChromeHistoryPath,
  isChromeHistoryIndexingSupported,
} from "../chromeHistory/paths.js";
import {
  listChromeDownloadsForDay,
  listChromeDownloadsMonthCounts,
  listChromeHistoryForDay,
  listChromeHistoryMonthCounts,
} from "../chromeHistory/queries.js";
import { syncChromeHistory } from "../chromeHistory/sync.js";
import {
  chromeDownloadTimeUnixMs,
  chromeWebkitUsToUnixMs,
} from "../chromeHistory/time.js";
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
import { registerLlmChatRoutes } from "../llmChat/routes.js";
import { registerGithubRoutes } from "../github/routes.js";

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
};

function jsonErr(status: number, message: string) {
  return Response.json({ error: { message } }, { status });
}

export function createApp(opts: ServeOptions): Hono {
  const { db, atuin, dailySummary } = opts;
  const app = new Hono();

  app.use(
    "/api/*",
    cors({
      origin: ["http://127.0.0.1:5173", "http://localhost:5173"],
      allowMethods: ["GET", "POST", "OPTIONS"],
    })
  );

  registerLlmChatRoutes(app);
  registerGithubRoutes(app, db);

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

  function chromeHistoryProfile(c: { req: { query: (k: string) => string | undefined } }): string {
    const p = (c.req.query("profile") ?? "Default").trim();
    return p.length > 0 ? p : "Default";
  }

  app.get("/api/chrome-history/status", (c) => {
    const supported = isChromeHistoryIndexingSupported();
    const profile = chromeHistoryProfile(c);
    const defaultHistoryPath = defaultChromeHistoryPath(profile);
    return c.json({
      supported,
      profile,
      defaultHistoryPath,
      platform: process.platform,
    });
  });

  app.get("/api/chrome-history/month", (c) => {
    try {
      const y = parseInt(c.req.query("year") ?? "", 10);
      const m = parseInt(c.req.query("month") ?? "", 10);
      if (Number.isNaN(y) || y < 1970 || y > 2100) {
        return jsonErr(400, "invalid year");
      }
      if (Number.isNaN(m) || m < 1 || m > 12) {
        return jsonErr(400, "invalid month");
      }
      const profile = chromeHistoryProfile(c);
      const days = listChromeHistoryMonthCounts(db, y, m, profile);
      return c.json({
        year: y,
        month: m,
        profile,
        days,
        timezone: "local",
      });
    } catch (e) {
      return jsonErr(500, String(e));
    }
  });

  app.get("/api/chrome-history/day", (c) => {
    try {
      const date = (c.req.query("date") ?? "").trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return jsonErr(400, "invalid date (use YYYY-MM-DD)");
      }
      const profile = chromeHistoryProfile(c);
      const rows = listChromeHistoryForDay(db, date, profile);
      const entries = rows.map((r) => ({
        ...r,
        visit_time_unix_ms: chromeWebkitUsToUnixMs(r.visit_time),
      }));
      return c.json({ date, profile, entries, timezone: "local" });
    } catch (e) {
      return jsonErr(500, String(e));
    }
  });

  app.post("/api/chrome-history/sync", async (c) => {
    try {
      const body = (await c.req.json().catch(() => ({}))) as {
        profile?: unknown;
        historyPath?: unknown;
      };
      const profile =
        typeof body.profile === "string" && body.profile.trim().length > 0
          ? body.profile.trim()
          : "Default";
      let historyPath: string | null = null;
      if (typeof body.historyPath === "string" && body.historyPath.trim().length > 0) {
        historyPath = resolve(body.historyPath.trim());
      } else {
        historyPath = defaultChromeHistoryPath(profile);
      }
      if (!historyPath) {
        return jsonErr(
          400,
          "no default Chrome History path on this platform; pass { \"historyPath\": \"...\" }"
        );
      }
      const result = syncChromeHistory(db, historyPath, profile);
      return c.json({ ok: true, ...result });
    } catch (e) {
      return jsonErr(500, String(e));
    }
  });

  app.get("/api/chrome-downloads/status", (c) => {
    const supported = isChromeHistoryIndexingSupported();
    const profile = chromeHistoryProfile(c);
    const defaultHistoryPath = defaultChromeHistoryPath(profile);
    return c.json({
      supported,
      profile,
      defaultHistoryPath,
      platform: process.platform,
    });
  });

  app.get("/api/chrome-downloads/month", (c) => {
    try {
      const y = parseInt(c.req.query("year") ?? "", 10);
      const m = parseInt(c.req.query("month") ?? "", 10);
      if (Number.isNaN(y) || y < 1970 || y > 2100) {
        return jsonErr(400, "invalid year");
      }
      if (Number.isNaN(m) || m < 1 || m > 12) {
        return jsonErr(400, "invalid month");
      }
      const profile = chromeHistoryProfile(c);
      const days = listChromeDownloadsMonthCounts(db, y, m, profile);
      return c.json({
        year: y,
        month: m,
        profile,
        days,
        timezone: "local",
      });
    } catch (e) {
      return jsonErr(500, String(e));
    }
  });

  app.get("/api/chrome-downloads/day", (c) => {
    try {
      const date = (c.req.query("date") ?? "").trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return jsonErr(400, "invalid date (use YYYY-MM-DD)");
      }
      const profile = chromeHistoryProfile(c);
      const rows = listChromeDownloadsForDay(db, date, profile);
      const entries = rows.map((r) => {
        const end = r.end_time ?? 0;
        const endOk = Number.isFinite(end) && end > 0;
        return {
          ...r,
          start_time_unix_ms: chromeWebkitUsToUnixMs(r.start_time),
          end_time_unix_ms: endOk ? chromeWebkitUsToUnixMs(end) : null,
          time_unix_ms: chromeDownloadTimeUnixMs(r.end_time, r.start_time),
        };
      });
      return c.json({ date, profile, entries, timezone: "local" });
    } catch (e) {
      return jsonErr(500, String(e));
    }
  });

  app.post("/api/chrome-downloads/sync", async (c) => {
    try {
      const body = (await c.req.json().catch(() => ({}))) as {
        profile?: unknown;
        historyPath?: unknown;
      };
      const profile =
        typeof body.profile === "string" && body.profile.trim().length > 0
          ? body.profile.trim()
          : "Default";
      let historyPath: string | null = null;
      if (typeof body.historyPath === "string" && body.historyPath.trim().length > 0) {
        historyPath = resolve(body.historyPath.trim());
      } else {
        historyPath = defaultChromeHistoryPath(profile);
      }
      if (!historyPath) {
        return jsonErr(
          400,
          "no default Chrome History path on this platform; pass { \"historyPath\": \"...\" }"
        );
      }
      const result = syncChromeHistory(db, historyPath, profile);
      return c.json({ ok: true, ...result });
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
