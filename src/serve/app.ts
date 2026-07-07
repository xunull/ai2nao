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
import { registerAtuinDirectoryActivityRoutes } from "../atuin/directoryActivity/routes.js";
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
  createBashApprovalStore,
  createSqliteBashPermissionRuleStore,
} from "../bashTool/index.js";
import { registerBashApprovalRoutes } from "../bashTool/routes.js";
import { registerCodeRunnerRoutes } from "../codeRunner/routes.js";
import {
  getManifestByRepoAndRelPath,
  getRepoById,
  listManifestsForRepo,
  listRepos,
} from "../read/queries.js";
import { getStatusSummary, searchManifests } from "../store/operations.js";
import { parseListQuery } from "./listQuery.js";
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
  messageToJson,
  searchResultToJson,
  sessionSummaryToJson,
  sessionToJson,
  workspaceToJson,
} from "../cursorHistory/json.js";
import {
  ClaudeTranscriptTooLargeError,
  computeProjectLastActive,
  listProjects,
  listSessionSummaries,
  loadClaudeMyMessages,
  loadClaudeSessionMessagePage,
  loadClaudeSessionMeta,
  loadSessionDetail,
  resolveClaudeProjectsRoot,
} from "../claudeCodeHistory/index.js";
import type { SessionHeader } from "../claudeCodeHistory/index.js";
import { projectSessionTimes } from "../claudeTokenUsage/queries.js";
import { createMcpHandler } from "../mcp/server.js";
import {
  codexStateDbPath,
  listCodexProjects,
  listCodexSessionSummaries,
  loadCodexMyMessages,
  loadCodexSessionDetail,
  resolveCodexRoot,
} from "../codexHistory/index.js";
import { isCodexHistoryError } from "../codexHistory/errors.js";
import {
  listOpencodeProjects,
  listOpencodeSessionSummaries,
  loadOpencodeSessionDetail,
  loadOpencodeMyMessages,
  opencodeDbPath,
  resolveOpencodeDataDir,
} from "../opencodeHistory/index.js";
import { isOpencodeHistoryError } from "../opencodeHistory/errors.js";
import {
  getCherryStudioStatus,
  listCherryStudioSessions,
  loadCherryStudioSession,
  resolveCherryStudioExportRoot,
  resolveCherryStudioRoot,
  searchCherryStudioSessions,
} from "../cherryStudioHistory/index.js";
import { registerLlmChatRoutes } from "../llmChat/routes.js";
import { registerLmStudioRoutes } from "../lmstudio/routes.js";
import { registerGithubRoutes } from "../github/routes.js";
import { registerHuggingfaceRoutes } from "../huggingface/routes.js";
import { registerRagRoutes } from "../rag/routes.js";
import { registerSoftwareRoutes } from "../software/routes.js";
import { registerSchedulerRoutes } from "../scheduler/routes.js";
import { SchedulerRuntime } from "../scheduler/runner.js";
import { registerVscodeRoutes } from "../vscode/routes.js";
import { registerWebSearchRoutes } from "../webSearch/routes.js";
import { registerWorkCosmosRoutes } from "../workCosmos/routes.js";
import { registerProviderRoutes } from "./providerRoutes.js";
import { registerWorkDashboardRoutes } from "../workDashboard/routes.js";
import { registerWorkRecapRoutes } from "../workRecap/routes.js";
import { registerWorkTokensTrendRoutes } from "../workTokensTrend/routes.js";
import { registerAgentUserMessagesRoutes } from "../agentUserMessages/routes.js";
import { registerAiRhythmRoutes } from "../aiRhythm/routes.js";
import { registerCommitBridgeRoutes } from "../commitBridge/routes.js";
import { registerReplayRoutes } from "../replay/routes.js";
import { registerGitChurnRoutes } from "../gitChurn/routes.js";
import { registerSettingsRoutes } from "./settingsRoutes.js";
import { registerCodexTokenUsageRoutes } from "../codexTokenUsage/routes.js";
import { registerProjectOpenerRoutes } from "../projectOpeners/routes.js";

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

/** 序列化 SessionHeader(Date → ISO),用于详情页 ?meta=1 的头部响应。 */
function claudeSessionHeaderToJson(h: SessionHeader) {
  return {
    messageCount: h.messageCount,
    createdAt: h.createdAt.toISOString(),
    lastUpdatedAt: h.lastUpdatedAt.toISOString(),
    firstUserText: h.firstUserText,
    title: h.title,
    preview: h.preview,
    workspacePath: h.workspacePath,
    warnings: h.warnings,
  };
}

function codexHistoryRoot(raw: string | undefined): string {
  const t = (raw ?? "").trim();
  return resolveCodexRoot(t.length > 0 ? t : undefined);
}

function cherryStudioHistoryRoot(raw: string | undefined): string {
  const t = (raw ?? "").trim();
  return resolveCherryStudioRoot(t.length > 0 ? t : undefined);
}

function cherryStudioExportRoot(raw: string | undefined): string | undefined {
  const t = (raw ?? "").trim();
  return resolveCherryStudioExportRoot(t.length > 0 ? t : undefined);
}

function boolQuery(raw: string | undefined): boolean | undefined {
  if (raw == null) return undefined;
  const t = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(t)) return true;
  if (["0", "false", "no", "off"].includes(t)) return false;
  return undefined;
}

function intQuery(raw: string | undefined, fallback: number): number {
  const n = parseInt(raw ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function codexHistoryErr(e: unknown) {
  if (isCodexHistoryError(e)) {
    const status = e.kind === "transcript-too-large" ? 413 : 500;
    return jsonErr(status, e.message);
  }
  return jsonErr(500, String(e));
}

function opencodeHistoryErr(e: unknown) {
  if (isOpencodeHistoryError(e)) return jsonErr(500, e.message);
  return jsonErr(500, String(e));
}

export type ServeOptions = {
  db: Database.Database;
  /**
   * Read-only index DB handle for the MCP server. When provided, `/mcp` is mounted
   * (Streamable HTTP); when omitted (the ~30 test callers), `/mcp` is absent → 404.
   * Caller owns + closes this handle (runServe), so MCP gets read-only enforcement
   * without reusing the read-write `db`.
   */
  mcpDb?: Database.Database;
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
  schedulerRuntime?: SchedulerRuntime;
};

function jsonErr(status: number, message: string) {
  return Response.json({ error: { message } }, { status });
}

export function createApp(opts: ServeOptions): Hono {
  const { db, atuin, dailySummary, rag, mcpDb } = opts;
  const app = new Hono();

  // MCP server (Streamable HTTP) — only when a read-only handle is supplied.
  // Without it (test callers), /mcp is never registered and resolves to 404.
  if (mcpDb) {
    const mcpHandler = createMcpHandler(mcpDb);
    app.all("/mcp", (c) => mcpHandler(c.req.raw));
  }
  const bashPermissionRules = createSqliteBashPermissionRuleStore(db);
  const bashApprovalStore = createBashApprovalStore({ ruleStore: bashPermissionRules });

  app.use(
    "/api/*",
    cors({
      origin: ["http://127.0.0.1:5173", "http://localhost:5173"],
      allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    })
  );

  registerLlmChatRoutes(app, {
    db,
    ragDb: rag?.db,
    bashApprovalStore,
    bashPermissionRules,
  });
  registerBashApprovalRoutes(app, bashApprovalStore);
  registerCodeRunnerRoutes(app);
  registerRagRoutes(app, rag ? { db: rag.db, dbPath: rag.path } : undefined);
  registerWebSearchRoutes(app);
  registerGithubRoutes(app, db);
  registerHuggingfaceRoutes(app, db);
  registerLmStudioRoutes(app, db);
  registerSoftwareRoutes(app, db);
  registerChromeHistoryRoutes(app, db);
  registerVscodeRoutes(app, db);
  registerAtuinDirectoryActivityRoutes(app, db, atuin);
  registerWorkDashboardRoutes(app, db);
  registerWorkRecapRoutes(app, db);
  registerWorkTokensTrendRoutes(app, db);
  registerGitChurnRoutes(app, db);
  registerSettingsRoutes(app, db);
  registerWorkCosmosRoutes(app, db, opts.schedulerRuntime);
  registerProviderRoutes(app, db);
  registerAgentUserMessagesRoutes(app, db);
  registerAiRhythmRoutes(app, db);
  registerCommitBridgeRoutes(app, db);
  registerReplayRoutes(app, db);
  registerCodexTokenUsageRoutes(app, db);
  registerProjectOpenerRoutes(app);
  if (opts.schedulerRuntime) {
    registerSchedulerRoutes(app, opts.schedulerRuntime);
  }

  app.get("/api/status", (c) => {
    try {
      return c.json(getStatusSummary(db));
    } catch (e) {
      return jsonErr(500, String(e));
    }
  });

  app.get("/api/repos", (c) => {
    const parsed = parseListQuery((k) => c.req.query(k), {
      defaultLimit: 25,
      maxLimit: 100,
    });
    if ("error" in parsed) return jsonErr(400, parsed.error);
    try {
      const { rows, total } = listRepos(db, {
        limit: parsed.limit,
        offset: parsed.offset,
        q: parsed.q,
        sort: parsed.sort,
        dir: parsed.dir,
        includeMissing: parsed.includeMissing,
      });
      return c.json({
        repos: rows,
        total,
        limit: parsed.limit,
        offset: parsed.offset,
        q: parsed.q ?? "",
        sort: parsed.sort ?? null,
        dir: parsed.dir ?? null,
      });
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

      // Recency sort: upgrade each project's "last active" with parsed times from
      // the token DB (accurate), falling back to current file mtime (cold/unsynced).
      // listProjects stays alpha-stable for its other consumers; we re-sort here.
      const timesByProject = projectSessionTimes(
        db,
        projects.map((p) => p.id)
      );
      const lastActive = new Map<string, string | null>();
      for (const p of projects) {
        lastActive.set(
          p.id,
          computeProjectLastActive(p.sessionFiles, timesByProject.get(p.id) ?? new Map())
        );
      }
      const sorted = [...projects].sort((a, b) => {
        const ta = lastActive.get(a.id) ?? null;
        const tb = lastActive.get(b.id) ?? null;
        if (ta && tb) {
          if (ta !== tb) return ta < tb ? 1 : -1; // DESC (newer first)
          return a.id.localeCompare(b.id);
        }
        if (ta) return -1; // time-bearing before null
        if (tb) return 1;
        return a.id.localeCompare(b.id); // both null -> stable by id
      });

      return c.json({
        ok: true,
        projectsRoot: root,
        projects: sorted.map((p) => ({
          id: p.id,
          path: p.path,
          sessionCount: p.sessionCount,
          decodedWorkspacePath: p.decodedWorkspacePath,
          slugDecodeIncomplete: p.slugDecodeIncomplete,
          lastActiveAt: lastActive.get(p.id) ?? null,
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

        // 分页路径(T1b):?meta=1 只回头部;?cursor=&limit= 回一页消息(均走 sessionIndex,
        // 不整文件重读)。缺省(无 meta / 无 cursor)仍走旧的整会话加载,保持向后兼容(整文件读)。
        if (boolQuery(c.req.query("meta"))) {
          const meta = await loadClaudeSessionMeta(root, projectId, sessionId);
          if (!meta) return jsonErr(404, "session not found");
          return c.json({ ok: true, header: claudeSessionHeaderToJson(meta.header) });
        }

        const cursorRaw = c.req.query("cursor");
        if (cursorRaw != null) {
          const cursor = Math.max(0, parseInt(cursorRaw, 10) || 0);
          const limit = intQuery(c.req.query("limit"), 50);
          const page = await loadClaudeSessionMessagePage(root, projectId, sessionId, {
            cursor,
            limit,
          });
          if (!page) return jsonErr(404, "session not found");
          return c.json({
            ok: true,
            messages: page.messages.map(messageToJson),
            nextCursor: page.nextCursor,
            hasMore: page.hasMore,
          });
        }

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

  app.get(
    "/api/claude-code-history/projects/:projectId/sessions/:sessionId/my-messages",
    async (c) => {
      try {
        const root = claudeCodeHistoryRoot(c.req.query("projectsRoot"));
        const projectId = decodeURIComponent(c.req.param("projectId"));
        const sessionId = decodeURIComponent(c.req.param("sessionId"));
        const result = await loadClaudeMyMessages(root, projectId, sessionId);
        if (!result) return jsonErr(404, "session not found");
        return c.json({ ok: true, ...result });
      } catch (e) {
        return claudeCodeHistoryErr(e);
      }
    }
  );

  app.get("/api/codex-history/status", (c) => {
    try {
      const root = codexHistoryRoot(c.req.query("codexRoot"));
      return c.json({
        platform: process.platform,
        codexRoot: root,
        sessionsRoot: join(root, "sessions"),
        stateDbPath: codexStateDbPath(root),
        envCodexHome: Boolean(process.env.CODEX_HOME),
      });
    } catch (e) {
      return codexHistoryErr(e);
    }
  });

  app.get("/api/codex-history/projects", async (c) => {
    try {
      // D1:项目列表只受 archived 影响;branch/model 是 session 级细化,不在此。
      const result = await listCodexProjects(c.req.query("codexRoot"), {
        archived: boolQuery(c.req.query("archived")) ?? false,
      });
      return c.json(result);
    } catch (e) {
      return codexHistoryErr(e);
    }
  });

  app.get("/api/codex-history/sessions", async (c) => {
    try {
      const root = c.req.query("codexRoot");
      const result = await listCodexSessionSummaries(root, {
        archived: boolQuery(c.req.query("archived")) ?? false,
        cwd: c.req.query("cwd"),
        gitBranch: c.req.query("gitBranch"),
        model: c.req.query("model"),
        limit: intQuery(c.req.query("limit"), 200),
        maxFiles: intQuery(c.req.query("maxFiles"), 1000),
      });
      return c.json({
        ...result,
        sessions: result.sessions.map(sessionSummaryToJson),
      });
    } catch (e) {
      return codexHistoryErr(e);
    }
  });

  app.get("/api/codex-history/sessions/:sessionId", async (c) => {
    try {
      const root = c.req.query("codexRoot");
      const sessionId = decodeURIComponent(c.req.param("sessionId"));
      const detail = await loadCodexSessionDetail(root, sessionId);
      if (!detail) {
        return jsonErr(404, "session not found");
      }
      const idx = Math.max(0, parseInt(c.req.query("index") ?? "0", 10) || 0);
      detail.session.index = idx;
      return c.json({
        ok: true,
        session: sessionToJson(detail.session),
        warnings: detail.warnings,
        metrics: detail.metrics,
      });
    } catch (e) {
      return codexHistoryErr(e);
    }
  });

  app.get("/api/codex-history/sessions/:sessionId/my-messages", async (c) => {
    try {
      const root = c.req.query("codexRoot");
      const sessionId = decodeURIComponent(c.req.param("sessionId"));
      const result = await loadCodexMyMessages(root, sessionId);
      if (!result) return jsonErr(404, "session not found");
      return c.json({ ok: true, ...result });
    } catch (e) {
      return codexHistoryErr(e);
    }
  });

  app.get("/api/opencode-history/status", (c) => {
    try {
      const dataDir = resolveOpencodeDataDir(c.req.query("opencodeRoot"));
      return c.json({
        platform: process.platform,
        opencodeRoot: dataDir,
        dbPath: opencodeDbPath(dataDir),
        envOpencodeDataDir: Boolean(process.env.OPENCODE_DATA_DIR),
      });
    } catch (e) {
      return opencodeHistoryErr(e);
    }
  });

  app.get("/api/opencode-history/projects", async (c) => {
    try {
      // 项目列表只受 archived 影响（agent/model 是 session 级细化，不在此）。
      const result = await listOpencodeProjects(c.req.query("opencodeRoot"), {
        archived: boolQuery(c.req.query("archived")) ?? false,
      });
      return c.json(result);
    } catch (e) {
      return opencodeHistoryErr(e);
    }
  });

  app.get("/api/opencode-history/sessions", async (c) => {
    try {
      const result = await listOpencodeSessionSummaries(c.req.query("opencodeRoot"), {
        projectId: c.req.query("projectId"),
        agent: c.req.query("agent"),
        model: c.req.query("model"),
        archived: boolQuery(c.req.query("archived")) ?? false,
        limit: intQuery(c.req.query("limit"), 200),
      });
      return c.json({
        ...result,
        sessions: result.sessions.map(sessionSummaryToJson),
      });
    } catch (e) {
      return opencodeHistoryErr(e);
    }
  });

  app.get("/api/opencode-history/sessions/:sessionId", async (c) => {
    try {
      const sessionId = decodeURIComponent(c.req.param("sessionId"));
      const detail = await loadOpencodeSessionDetail(c.req.query("opencodeRoot"), sessionId);
      if (!detail) return jsonErr(404, "session not found");
      const idx = Math.max(0, parseInt(c.req.query("index") ?? "0", 10) || 0);
      detail.session.index = idx;
      return c.json({
        ok: true,
        session: sessionToJson(detail.session),
        warnings: detail.warnings,
      });
    } catch (e) {
      return opencodeHistoryErr(e);
    }
  });

  app.get("/api/opencode-history/sessions/:sessionId/my-messages", async (c) => {
    try {
      const sessionId = decodeURIComponent(c.req.param("sessionId"));
      const messages = await loadOpencodeMyMessages(c.req.query("opencodeRoot"), sessionId);
      if (messages === null) return jsonErr(404, "session not found");
      return c.json({ ok: true, messages });
    } catch (e) {
      return opencodeHistoryErr(e);
    }
  });

  app.get("/api/cherry-studio-history/status", async (c) => {
    try {
      const cherryRoot = cherryStudioHistoryRoot(c.req.query("cherryRoot"));
      const exportRoot = cherryStudioExportRoot(c.req.query("exportRoot"));
      return c.json(await getCherryStudioStatus(cherryRoot, exportRoot));
    } catch (e) {
      return jsonErr(500, String(e));
    }
  });

  app.get("/api/cherry-studio-history/sessions", async (c) => {
    try {
      const cherryRoot = cherryStudioHistoryRoot(c.req.query("cherryRoot"));
      const exportRoot = cherryStudioExportRoot(c.req.query("exportRoot"));
      const limit = Math.min(200, Math.max(1, intQuery(c.req.query("limit"), 50)));
      const parsedOffset = parseInt(c.req.query("offset") ?? "0", 10);
      const offset = Number.isFinite(parsedOffset) && parsedOffset > 0 ? parsedOffset : 0;
      const result = await listCherryStudioSessions(cherryRoot, exportRoot, { limit, offset });
      return c.json({
        ...result,
        sessions: result.sessions.map(sessionSummaryToJson),
      });
    } catch (e) {
      return jsonErr(500, String(e));
    }
  });

  app.get("/api/cherry-studio-history/sessions/:sessionId", async (c) => {
    try {
      const cherryRoot = cherryStudioHistoryRoot(c.req.query("cherryRoot"));
      const exportRoot = cherryStudioExportRoot(c.req.query("exportRoot"));
      const sessionId = decodeURIComponent(c.req.param("sessionId"));
      const detail = await loadCherryStudioSession(sessionId, cherryRoot, exportRoot);
      if (!detail.session) {
        return jsonErr(404, "session not found");
      }
      return c.json({
        ok: true,
        session: sessionToJson(detail.session),
        warnings: detail.warnings,
      });
    } catch (e) {
      return jsonErr(500, String(e));
    }
  });

  app.get("/api/cherry-studio-history/search", async (c) => {
    try {
      const q = (c.req.query("q") ?? "").trim();
      if (!q) return jsonErr(400, "missing q");
      if (q.length > MAX_SEARCH_QUERY_LEN) {
        return jsonErr(400, "query too long");
      }
      const cherryRoot = cherryStudioHistoryRoot(c.req.query("cherryRoot"));
      const exportRoot = cherryStudioExportRoot(c.req.query("exportRoot"));
      const results = await searchCherryStudioSessions(q, {
        root: cherryRoot,
        exportRoot,
        limit: Math.min(200, Math.max(1, intQuery(c.req.query("limit"), 30))),
        contextChars: Math.min(500, Math.max(20, intQuery(c.req.query("context"), 120))),
      });
      return c.json({
        ok: true,
        q,
        results: results.map(searchResultToJson),
      });
    } catch (e) {
      return jsonErr(500, String(e));
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
