import type Database from "better-sqlite3";
import type { Hono } from "hono";
import { listBrewPackages, getBrewStatus } from "./brew/queries.js";
import type { BrewPackageKind } from "./brew/parse.js";
import { syncBrewPackages } from "./brew/sync.js";
import { getMacAppsStatus, listMacApps } from "./macApps/queries.js";
import { syncMacApps } from "./macApps/sync.js";

const MAX_Q_LEN = 400;
const MAX_LIMIT = 100;

function jsonErr(status: number, message: string) {
  return Response.json({ error: { message } }, { status });
}

export function registerSoftwareRoutes(app: Hono, db: Database.Database): void {
  app.get("/api/apps/status", (c) => c.json(getMacAppsStatus(db)));

  app.get("/api/apps", (c) => {
    const parsed = parseListQuery((key) => c.req.query(key));
    if ("error" in parsed) return jsonErr(400, parsed.error);
    const root = cleanOptionalString(c.req.query("root"));
    return c.json(listMacApps(db, { ...parsed, root }));
  });

  app.post("/api/apps/sync", async (c) => {
    try {
      const result = await syncMacApps(db);
      if (!result.ok) return jsonErr(500, result.warnings[0]?.message ?? "apps sync failed");
      return c.json(result);
    } catch (e) {
      return jsonErr(500, e instanceof Error ? e.message : String(e));
    }
  });

  app.get("/api/brew/status", (c) => c.json(getBrewStatus(db)));

  app.get("/api/brew/packages", (c) => {
    const parsed = parseListQuery((key) => c.req.query(key));
    if ("error" in parsed) return jsonErr(400, parsed.error);
    const rawKind = cleanOptionalString(c.req.query("kind"));
    const kind =
      rawKind === "formula" || rawKind === "cask" ? (rawKind as BrewPackageKind) : undefined;
    if (rawKind && !kind) return jsonErr(400, "invalid kind");
    return c.json(listBrewPackages(db, { ...parsed, kind }));
  });

  app.post("/api/brew/sync", async (c) => {
    try {
      const result = await syncBrewPackages(db);
      if (!result.ok) return jsonErr(500, "brew sync failed");
      return c.json(result);
    } catch (e) {
      return jsonErr(500, e instanceof Error ? e.message : String(e));
    }
  });
}

function parseListQuery(query: (key: string) => string | undefined):
  | {
      q?: string;
      includeMissing: boolean;
      limit: number;
      offset: number;
    }
  | { error: string } {
  const q = cleanOptionalString(query("q"));
  if (q && q.length > MAX_Q_LEN) return { error: "query too long" };
  const limitParsed = parseNonNegativeInt(query("limit") ?? "50");
  const offsetParsed = parseNonNegativeInt(query("offset") ?? "0");
  if (limitParsed == null || limitParsed < 1) return { error: "invalid limit" };
  if (offsetParsed == null || offsetParsed < 0 || offsetParsed > 1_000_000) {
    return { error: "invalid offset" };
  }
  const includeRaw = query("includeMissing");
  const includeMissing = includeRaw === "1" || includeRaw === "true";
  return {
    q,
    includeMissing,
    limit: Math.min(MAX_LIMIT, limitParsed),
    offset: offsetParsed,
  };
}

function cleanOptionalString(v: string | undefined): string | undefined {
  const t = (v ?? "").trim();
  return t.length > 0 ? t : undefined;
}

function parseNonNegativeInt(v: string): number | null {
  const t = v.trim();
  if (!/^\d+$/.test(t)) return null;
  return Number(t);
}
