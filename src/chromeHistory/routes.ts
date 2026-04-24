import { resolve } from "node:path";
import type { Hono } from "hono";
import type Database from "better-sqlite3";
import {
  defaultChromeHistoryPath,
  isChromeHistoryIndexingSupported,
} from "./paths.js";
import {
  listChromeDownloadsForDay,
  listChromeDownloadsMonthCounts,
  listChromeHistoryForDay,
  listChromeHistoryMonthCounts,
} from "./queries.js";
import { syncChromeHistory } from "./sync.js";
import {
  getChromeHistoryDomainStatus,
  getChromeHistoryDomainSummary,
  getChromeHistoryDomainTimeline,
  getTopChromeHistoryDomains,
  listChromeHistoryDomainVisits,
  rebuildChromeHistoryVisitDomains,
  type ChromeHistoryDomainKind,
  type ChromeHistoryTimelineGrain,
} from "./domainPivot.js";
import {
  chromeDownloadTimeUnixMs,
  chromeWebkitUsToUnixMs,
} from "./time.js";

function jsonErr(status: number, message: string) {
  return Response.json({ error: { message } }, { status });
}

function chromeHistoryProfile(c: {
  req: { query: (k: string) => string | undefined };
}): string {
  const p = (c.req.query("profile") ?? "Default").trim();
  return p.length > 0 ? p : "Default";
}

function dateQuery(c: { req: { query: (k: string) => string | undefined } }, key: string) {
  const raw = (c.req.query(key) ?? "").trim();
  if (!raw) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) throw new Error(`invalid ${key} (use YYYY-MM-DD)`);
  return raw;
}

function localDay(d: Date): string {
  const y = d.getFullYear();
  const m = `${d.getMonth() + 1}`.padStart(2, "0");
  const day = `${d.getDate()}`.padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function addDays(day: string, n: number): string {
  const [y, m, d] = day.split("-").map(Number);
  const date = new Date(y, m - 1, d + n);
  return localDay(date);
}

function defaultTimelineFrom(): string {
  const d = new Date();
  d.setDate(d.getDate() - 90);
  return localDay(d);
}

function parseKind(raw: string | undefined): ChromeHistoryDomainKind {
  const v = (raw ?? "web").trim();
  if (
    v === "all" ||
    v === "web" ||
    v === "localhost" ||
    v === "chrome" ||
    v === "extension" ||
    v === "file" ||
    v === "invalid"
  ) {
    return v;
  }
  return "web";
}

function parseGrain(raw: string | undefined): ChromeHistoryTimelineGrain {
  return raw === "week" || raw === "month" ? raw : "day";
}

function csv(raw: string | undefined): string[] | undefined {
  const parts = (raw ?? "")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
  return parts.length > 0 ? parts : undefined;
}

export function registerChromeHistoryRoutes(
  app: Hono,
  db: Database.Database
): void {
  app.get("/api/chrome-history/status", (c) => {
    const supported = isChromeHistoryIndexingSupported();
    const profile = chromeHistoryProfile(c);
    const defaultHistoryPath = defaultChromeHistoryPath(profile);
    return c.json({
      supported,
      profile,
      defaultHistoryPath,
      platform: process.platform,
      domainStatus: getChromeHistoryDomainStatus(db, profile),
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
      return c.json({ year: y, month: m, profile, days, timezone: "local" });
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
      const historyPath =
        typeof body.historyPath === "string" && body.historyPath.trim().length > 0
          ? resolve(body.historyPath.trim())
          : defaultChromeHistoryPath(profile);
      if (!historyPath) {
        return jsonErr(
          400,
          "no default Chrome History path on this platform; pass { \"historyPath\": \"...\" }"
        );
      }
      const result = syncChromeHistory(db, historyPath, profile);
      return c.json({
        ok: true,
        ...result,
        domainStatus: getChromeHistoryDomainStatus(db, profile),
      });
    } catch (e) {
      return jsonErr(500, String(e));
    }
  });

  app.get("/api/chrome-downloads/status", (c) => {
    const supported = isChromeHistoryIndexingSupported();
    const profile = chromeHistoryProfile(c);
    const defaultHistoryPath = defaultChromeHistoryPath(profile);
    return c.json({ supported, profile, defaultHistoryPath, platform: process.platform });
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
      return c.json({ year: y, month: m, profile, days, timezone: "local" });
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
      const historyPath =
        typeof body.historyPath === "string" && body.historyPath.trim().length > 0
          ? resolve(body.historyPath.trim())
          : defaultChromeHistoryPath(profile);
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

  app.get("/api/chrome-history/domains/status", (c) => {
    try {
      const profile = chromeHistoryProfile(c);
      return c.json({
        supported: isChromeHistoryIndexingSupported(),
        profile,
        defaultHistoryPath: defaultChromeHistoryPath(profile),
        platform: process.platform,
        domainStatus: getChromeHistoryDomainStatus(db, profile),
      });
    } catch (e) {
      return jsonErr(500, String(e));
    }
  });

  app.post("/api/chrome-history/domains/rebuild", async (c) => {
    try {
      const body = (await c.req.json().catch(() => ({}))) as { profile?: unknown };
      const profile =
        typeof body.profile === "string" && body.profile.trim().length > 0
          ? body.profile.trim()
          : "Default";
      const result = rebuildChromeHistoryVisitDomains(db, profile);
      return c.json({
        ok: result.ok,
        result,
        domainStatus: getChromeHistoryDomainStatus(db, profile),
      });
    } catch (e) {
      return jsonErr(500, String(e));
    }
  });

  app.get("/api/chrome-history/domains/summary", (c) => {
    try {
      const profile = chromeHistoryProfile(c);
      const from = dateQuery(c, "from");
      const to = dateQuery(c, "to");
      const kind = parseKind(c.req.query("kind"));
      return c.json({
        profile,
        from,
        to,
        kind,
        timezone: "local",
        ...getChromeHistoryDomainSummary(db, { profile, from, to, kind }),
      });
    } catch (e) {
      return jsonErr(e instanceof Error && /^invalid /.test(e.message) ? 400 : 500, String(e));
    }
  });

  app.get("/api/chrome-history/domains/top", (c) => {
    try {
      const profile = chromeHistoryProfile(c);
      const from = dateQuery(c, "from");
      const to = dateQuery(c, "to");
      const kind = parseKind(c.req.query("kind"));
      const limit = parseInt(c.req.query("limit") ?? "50", 10) || 50;
      return c.json({ items: getTopChromeHistoryDomains(db, { profile, from, to, kind, limit }) });
    } catch (e) {
      return jsonErr(e instanceof Error && /^invalid /.test(e.message) ? 400 : 500, String(e));
    }
  });

  app.get("/api/chrome-history/domains/timeline", (c) => {
    try {
      const profile = chromeHistoryProfile(c);
      const from = dateQuery(c, "from") ?? defaultTimelineFrom();
      const to = dateQuery(c, "to");
      const kind = parseKind(c.req.query("kind"));
      const grain = parseGrain(c.req.query("grain"));
      const top = parseInt(c.req.query("top") ?? "15", 10) || 15;
      return c.json(
        getChromeHistoryDomainTimeline(db, {
          profile,
          from,
          to,
          kind,
          grain,
          top,
          domains: csv(c.req.query("domains")),
        })
      );
    } catch (e) {
      return jsonErr(e instanceof Error && /^invalid /.test(e.message) ? 400 : 500, String(e));
    }
  });

  app.get("/api/chrome-history/domains/visits", (c) => {
    try {
      const profile = chromeHistoryProfile(c);
      const day = dateQuery(c, "date");
      const from = day ? day : dateQuery(c, "from");
      const to = day ? addDays(day, 1) : dateQuery(c, "to");
      const kind = parseKind(c.req.query("kind"));
      const perPage = parseInt(c.req.query("per_page") ?? "50", 10) || 50;
      const result = listChromeHistoryDomainVisits(db, {
        profile,
        from,
        to,
        kind,
        perPage,
        domain: (c.req.query("domain") ?? "").trim() || null,
        q: (c.req.query("q") ?? "").trim() || null,
        cursor: (c.req.query("cursor") ?? "").trim() || null,
      });
      return c.json({
        items: result.items.map((r) => ({
          ...r,
          visit_time_unix_ms: chromeWebkitUsToUnixMs(r.visit_time),
        })),
        next_cursor: result.nextCursor,
      });
    } catch (e) {
      return jsonErr(e instanceof Error && /^invalid /.test(e.message) ? 400 : 500, String(e));
    }
  });
}
