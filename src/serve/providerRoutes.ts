import type { Hono } from "hono";
import type Database from "better-sqlite3";
import { ensureProviderConfigs, listProviders, setProviderConfig } from "../providers/store.js";
import { getProviderSource } from "../providers/registry.js";
import { syncProvider } from "../providers/sync.js";

/**
 * External-provider management routes.
 *
 * SECURITY: the API key is write-only. GET/PATCH responses NEVER echo it — the
 * list view exposes only `hasKey`. PATCH accepts `apiKey` to set/clear it.
 */
export function registerProviderRoutes(app: Hono, db: Database.Database): void {
  app.get("/api/providers", (c) => {
    try {
      ensureProviderConfigs(db, new Date().toISOString());
      return c.json({ ok: true, providers: listProviders(db) });
    } catch (e) {
      return c.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, 500);
    }
  });

  app.patch("/api/providers/:id", async (c) => {
    const id = c.req.param("id");
    if (!getProviderSource(id)) {
      return c.json({ ok: false, error: "unknown provider" }, 404);
    }
    const body = (await c.req.json().catch(() => ({}))) as {
      enabled?: boolean;
      apiKey?: string;
    };
    try {
      setProviderConfig(
        db,
        id,
        { enabled: body.enabled, apiKey: body.apiKey },
        new Date().toISOString()
      );
      // Return the masked list (never the key).
      return c.json({ ok: true, providers: listProviders(db) });
    } catch (e) {
      return c.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, 500);
    }
  });

  app.post("/api/providers/:id/sync", async (c) => {
    const id = c.req.param("id");
    if (!getProviderSource(id)) {
      return c.json({ ok: false, error: "unknown provider" }, 404);
    }
    try {
      const result = await syncProvider(db, id);
      return c.json({ ok: true, result, providers: listProviders(db) });
    } catch (e) {
      return c.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, 500);
    }
  });
}
