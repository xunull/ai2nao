import type { Hono } from "hono";
import type Database from "better-sqlite3";
import {
  DEFAULT_WORK_DASHBOARD_OPTIONS,
  DEFAULT_WORK_TOKEN_RANKING_OPTIONS,
  buildWorkTokenRanking,
  buildWorkDashboard,
  defaultDashboardCollectors,
  normalizeDashboardOptions,
  normalizeTokenRankingOptions,
} from "./aggregate.js";
import { dashboardResponseToJson, tokenRankingResponseToJson } from "./json.js";
import { DASHBOARD_SOURCES, isDashboardSource } from "./types.js";
import type { DashboardSource, WorkDashboardOptions, WorkTokenRankingOptions } from "./types.js";

function jsonErr(status: number, message: string) {
  return Response.json({ error: { message } }, { status });
}

function parsePositiveInt(raw: string | undefined, name: string): number | undefined {
  if (raw == null || raw.trim() === "") return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return n;
}

function parseRangeDays(raw: string | undefined): number | "all" | undefined {
  if (raw == null || raw.trim() === "") return undefined;
  const t = raw.trim().toLowerCase();
  if (t === "all") return "all";
  if (!["7", "30", "90"].includes(t)) {
    throw new Error("rangeDays must be one of 7, 30, 90, all");
  }
  return Number(t);
}

function parseRangeMonths(raw: string | undefined): 1 | 3 | 6 | 12 | "all" | undefined {
  if (raw == null || raw.trim() === "") return undefined;
  const t = raw.trim().toLowerCase();
  if (t === "all") return "all";
  if (!["1", "3", "6", "12"].includes(t)) {
    throw new Error("rangeMonths must be one of 1, 3, 6, 12, all");
  }
  return Number(t) as 1 | 3 | 6 | 12;
}

function parseSources(raw: string | undefined): DashboardSource[] | undefined {
  if (raw == null || raw.trim() === "") return undefined;
  const values = raw.split(",").map((s) => s.trim()).filter(Boolean);
  const out: DashboardSource[] = [];
  for (const value of values) {
    if (!isDashboardSource(value)) {
      throw new Error(`sources must contain only ${DASHBOARD_SOURCES.join(",")}`);
    }
    out.push(value);
  }
  return out.length > 0 ? out : undefined;
}

function parseOptions(query: (key: string) => string | undefined): WorkDashboardOptions {
  return normalizeDashboardOptions({
    rangeDays: parseRangeDays(query("rangeDays")) ?? DEFAULT_WORK_DASHBOARD_OPTIONS.rangeDays,
    sources: parseSources(query("sources")) ?? DEFAULT_WORK_DASHBOARD_OPTIONS.sources,
    limitProjects: parsePositiveInt(query("limitProjects"), "limitProjects") ?? DEFAULT_WORK_DASHBOARD_OPTIONS.limitProjects,
    sessionsPerProject: parsePositiveInt(query("sessionsPerProject"), "sessionsPerProject") ?? DEFAULT_WORK_DASHBOARD_OPTIONS.sessionsPerProject,
    tokenSessionsPerProject: parsePositiveInt(query("tokenSessionsPerProject"), "tokenSessionsPerProject") ?? DEFAULT_WORK_DASHBOARD_OPTIONS.tokenSessionsPerProject,
    claudeProjectLimit: parsePositiveInt(query("claudeProjectLimit"), "claudeProjectLimit") ?? DEFAULT_WORK_DASHBOARD_OPTIONS.claudeProjectLimit,
    claudeSessionsPerProject: parsePositiveInt(query("claudeSessionsPerProject"), "claudeSessionsPerProject") ?? DEFAULT_WORK_DASHBOARD_OPTIONS.claudeSessionsPerProject,
    codexSessionLimit: parsePositiveInt(query("codexSessionLimit"), "codexSessionLimit") ?? DEFAULT_WORK_DASHBOARD_OPTIONS.codexSessionLimit,
    codexFallbackFiles: parsePositiveInt(query("codexFallbackFiles"), "codexFallbackFiles") ?? DEFAULT_WORK_DASHBOARD_OPTIONS.codexFallbackFiles,
  });
}

function parseRankingOptions(query: (key: string) => string | undefined): WorkTokenRankingOptions {
  return normalizeTokenRankingOptions({
    rangeMonths: parseRangeMonths(query("rangeMonths")) ?? DEFAULT_WORK_TOKEN_RANKING_OPTIONS.rangeMonths,
    sources: parseSources(query("sources")) ?? DEFAULT_WORK_TOKEN_RANKING_OPTIONS.sources,
    limit: parsePositiveInt(query("limit"), "limit") ?? DEFAULT_WORK_TOKEN_RANKING_OPTIONS.limit,
    claudeProjectLimit: parsePositiveInt(query("claudeProjectLimit"), "claudeProjectLimit") ?? DEFAULT_WORK_TOKEN_RANKING_OPTIONS.claudeProjectLimit,
    claudeSessionsPerProject: parsePositiveInt(query("claudeSessionsPerProject"), "claudeSessionsPerProject") ?? DEFAULT_WORK_TOKEN_RANKING_OPTIONS.claudeSessionsPerProject,
    codexSessionLimit: parsePositiveInt(query("codexSessionLimit"), "codexSessionLimit") ?? DEFAULT_WORK_TOKEN_RANKING_OPTIONS.codexSessionLimit,
    codexFallbackFiles: parsePositiveInt(query("codexFallbackFiles"), "codexFallbackFiles") ?? DEFAULT_WORK_TOKEN_RANKING_OPTIONS.codexFallbackFiles,
  });
}

export function registerWorkDashboardRoutes(app: Hono, db?: Database.Database) {
  app.get("/api/work-dashboard", async (c) => {
    try {
      const options = parseOptions((key) => c.req.query(key));
      const dashboard = await buildWorkDashboard(options, defaultDashboardCollectors(db));
      return c.json(dashboardResponseToJson(dashboard));
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (/must be/.test(message)) return jsonErr(400, message);
      return jsonErr(500, message);
    }
  });

  app.get("/api/work-dashboard/token-projects", async (c) => {
    try {
      const options = parseRankingOptions((key) => c.req.query(key));
      const ranking = await buildWorkTokenRanking(options, defaultDashboardCollectors(db));
      return c.json(tokenRankingResponseToJson(ranking));
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (/must be/.test(message)) return jsonErr(400, message);
      return jsonErr(500, message);
    }
  });
}
