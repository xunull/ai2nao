import type { Hono } from "hono";
import type Database from "better-sqlite3";
import {
  getScanRoots,
  setScanRoots,
  getScanMaxDepth,
  setScanMaxDepth,
  getScanMaxDocs,
  setScanMaxDocs,
  getScanConcurrency,
  setScanConcurrency,
} from "../appConfig/index.js";
import { githubTokenStatus } from "../github/config.js";
import {
  allCredentialDtos,
  clearCredential,
  CredentialPatchError,
  isCredentialName,
  patchCredential,
} from "../settings/credentialApi.js";
import {
  allSettingDtos,
  clearSetting,
  isSettingName,
  patchSetting,
} from "../settings/settingApi.js";

function jsonErr(status: number, message: string) {
  return Response.json({ error: { message } }, { status });
}

/** Narrow secret DTO — only set/source, NEVER the token or the local file path. */
function githubDto(): { set: boolean; source: "env" | "db" | "file" | null } {
  const s = githubTokenStatus();
  return { set: s.configured, source: s.source };
}

/**
 * Settings API. Non-secret config (scan roots) lives in app_config; the GitHub
 * token lives in its 0600 file (writeGithubConfig). The token is never returned;
 * only `{ set, source }`. Uses PATCH (CORS allowMethods has no PUT).
 */
export function registerSettingsRoutes(app: Hono, db: Database.Database): void {
  const settingsDto = () => ({
    scanRoots: getScanRoots(db),
    scanMaxDepth: getScanMaxDepth(db),
    scanMaxDocs: getScanMaxDocs(db),
    scanConcurrency: getScanConcurrency(db),
    // Kept for the shipped GitHub section of the settings page; `credentials`
    // below is the general form and includes github too.
    github: githubDto(),
    credentials: allCredentialDtos(),
    // Non-secret settings (rag corpus). Same shape as credentials but `values`
    // is returned verbatim — nothing to redact.
    settings: allSettingDtos(),
  });

  app.get("/api/settings", (c) => c.json(settingsDto()));

  // PATCH /api/settings { scanRoots?: string[]; scanMaxDepth?: number } — partial.
  // scanRoots is a full-array replace ([] clears); scanMaxDepth is the depth brake.
  app.patch("/api/settings", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return jsonErr(400, "invalid JSON body");
    }
    const { scanRoots, scanMaxDepth, scanMaxDocs, scanConcurrency } = body as {
      scanRoots?: unknown;
      scanMaxDepth?: unknown;
      scanMaxDocs?: unknown;
      scanConcurrency?: unknown;
    };
    try {
      if (scanRoots !== undefined) {
        if (!Array.isArray(scanRoots)) return jsonErr(400, "scanRoots must be an array");
        // setScanRoots error messages echo the user's own paths (not server paths) — safe.
        setScanRoots(db, scanRoots as string[]);
      }
      if (scanMaxDepth !== undefined) {
        if (typeof scanMaxDepth !== "number") return jsonErr(400, "scanMaxDepth must be a number");
        setScanMaxDepth(db, scanMaxDepth);
      }
      if (scanMaxDocs !== undefined) {
        if (typeof scanMaxDocs !== "number") return jsonErr(400, "scanMaxDocs must be a number");
        setScanMaxDocs(db, scanMaxDocs);
      }
      if (scanConcurrency !== undefined) {
        if (typeof scanConcurrency !== "number") return jsonErr(400, "scanConcurrency must be a number");
        setScanConcurrency(db, scanConcurrency);
      }
    } catch (e) {
      return jsonErr(400, e instanceof Error ? e.message : "invalid settings");
    }
    return c.json(settingsDto());
  });

  // PATCH /api/settings/secret/:name — partial update, merged over the stored
  // value. An absent field KEEPS its current value, so a form that shows a
  // masked key and posts back only `model` cannot wipe the key. `null` clears a
  // field. The shipped `/secret/github { token }` call is just this route.
  app.patch("/api/settings/secret/:name", async (c) => {
    const name = c.req.param("name");
    if (!isCredentialName(name)) return jsonErr(404, "unknown credential");

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return jsonErr(400, "invalid JSON body");
    }
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return jsonErr(400, "body must be an object");
    }

    try {
      const dto = patchCredential(name, body as Record<string, unknown>);
      return c.json({ credential: dto, github: githubDto() });
    } catch (e) {
      if (e instanceof CredentialPatchError) return jsonErr(400, e.message);
      // Generic — a raw error would leak the absolute config.db path.
      return jsonErr(500, "failed to save credential");
    }
  });

  // DELETE /api/settings/secret/:name — forget the stored value. A legacy file
  // or an env var may still supply it; the returned `source` says so rather than
  // claiming the feature is off.
  app.delete("/api/settings/secret/:name", (c) => {
    const name = c.req.param("name");
    if (!isCredentialName(name)) return jsonErr(404, "unknown credential");
    try {
      const dto = clearCredential(name);
      return c.json({ credential: dto, github: githubDto() });
    } catch {
      return jsonErr(500, "failed to delete credential");
    }
  });

  // PATCH /api/settings/setting/:name — non-secret settings (rag-corpus).
  // Same merge semantics as /secret/:name; corpusRoots is existence-validated.
  // PATCH not PUT: PUT is absent from the CORS allowMethods list.
  app.patch("/api/settings/setting/:name", async (c) => {
    const name = c.req.param("name");
    if (!isSettingName(name)) return jsonErr(404, "unknown setting");
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return jsonErr(400, "invalid JSON body");
    }
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return jsonErr(400, "body must be an object");
    }
    try {
      return c.json({ setting: patchSetting(name, body as Record<string, unknown>) });
    } catch (e) {
      if (e instanceof CredentialPatchError) return jsonErr(400, e.message);
      return jsonErr(500, "failed to save setting");
    }
  });

  // DELETE /api/settings/setting/:name — forget the stored setting; rag.json (if
  // present) still applies, and the returned `source` says so.
  app.delete("/api/settings/setting/:name", (c) => {
    const name = c.req.param("name");
    if (!isSettingName(name)) return jsonErr(404, "unknown setting");
    try {
      return c.json({ setting: clearSetting(name) });
    } catch {
      return jsonErr(500, "failed to delete setting");
    }
  });
}
