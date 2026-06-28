import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, statSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Hono } from "hono";
import type Database from "better-sqlite3";
import { createApp } from "../src/serve/app.js";
import { openDatabase } from "../src/store/open.js";
import { canonicalizePath } from "../src/path/canonical.js";

let base: string;
let db: Database.Database;
let app: Hono;
let tokenPath: string;
let savedEnvToken: string | undefined;
let savedEnvPath: string | undefined;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "ai2nao-set-"));
  db = openDatabase(join(base, "idx.db"));
  app = createApp({ db });
  tokenPath = join(base, "github.json");
  savedEnvToken = process.env.GITHUB_TOKEN;
  savedEnvPath = process.env.AI2NAO_GITHUB_CONFIG;
  delete process.env.GITHUB_TOKEN;
  process.env.AI2NAO_GITHUB_CONFIG = tokenPath;
});
afterEach(() => {
  db.close();
  rmSync(base, { recursive: true, force: true });
  if (savedEnvToken === undefined) delete process.env.GITHUB_TOKEN;
  else process.env.GITHUB_TOKEN = savedEnvToken;
  if (savedEnvPath === undefined) delete process.env.AI2NAO_GITHUB_CONFIG;
  else process.env.AI2NAO_GITHUB_CONFIG = savedEnvPath;
});

const get = () => app.request("/api/settings").then((r) => r.json());
const patch = (path: string, body: unknown) =>
  app.request(path, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

describe("settings routes", () => {
  it("GET returns a narrow secret DTO — no configPath / file path leak", async () => {
    const body = await get();
    expect(body.scanRoots).toEqual([]);
    expect(body.github).toEqual({ set: false, source: null });
    // the leaky githubTokenStatus fields must NOT be present
    expect(body.github.configPath).toBeUndefined();
    expect(body.github.envVar).toBeUndefined();
    expect(body.github.insecureFilePermissions).toBeUndefined();
  });

  it("PATCH scanRoots stores canonical dirs and GET reflects them", async () => {
    const d = join(base, "code");
    mkdirSync(d);
    const canon = canonicalizePath(d); // realpath resolves the macOS /var -> /private/var symlink
    const res = await patch("/api/settings", { scanRoots: [d] });
    expect(res.status).toBe(200);
    expect((await res.json()).scanRoots).toEqual([canon]);
    expect((await get()).scanRoots).toEqual([canon]);
  });

  it("PATCH rejects an invalid scan root with 400", async () => {
    const res = await patch("/api/settings", { scanRoots: [join(base, "nope")] });
    expect(res.status).toBe(400);
  });

  it("PATCH token writes a 0600 file; GET shows set:true source:file; DELETE clears", async () => {
    const res = await patch("/api/settings/secret/github", { token: "ghp_secret" });
    expect(res.status).toBe(200);
    expect(existsSync(tokenPath)).toBe(true);
    expect(statSync(tokenPath).mode & 0o777).toBe(0o600);
    expect((await get()).github).toEqual({ set: true, source: "file" });

    const del = await app.request("/api/settings/secret/github", { method: "DELETE" });
    expect(del.status).toBe(200);
    expect(existsSync(tokenPath)).toBe(false);
    expect((await get()).github).toEqual({ set: false, source: null });
  });

  it("PATCH token rejects an empty token with 400", async () => {
    const res = await patch("/api/settings/secret/github", { token: "  " });
    expect(res.status).toBe(400);
  });

  it("GITHUB_TOKEN env takes precedence (source:env) over the file", async () => {
    await patch("/api/settings/secret/github", { token: "ghp_file" });
    process.env.GITHUB_TOKEN = "ghp_fromenv";
    expect((await get()).github).toEqual({ set: true, source: "env" });
  });

  it("GET exposes scanMaxDepth (default 8); PATCH sets it", async () => {
    expect((await get()).scanMaxDepth).toBe(8);
    const res = await patch("/api/settings", { scanMaxDepth: 4 });
    expect(res.status).toBe(200);
    expect((await res.json()).scanMaxDepth).toBe(4);
    expect((await get()).scanMaxDepth).toBe(4);
  });

  it("PATCH rejects an out-of-range scanMaxDepth with 400", async () => {
    expect((await patch("/api/settings", { scanMaxDepth: -1 })).status).toBe(400);
    expect((await patch("/api/settings", { scanMaxDepth: 2.5 })).status).toBe(400);
  });

  it("GET exposes scanMaxDocs (default 100); PATCH sets it", async () => {
    expect((await get()).scanMaxDocs).toBe(100);
    const res = await patch("/api/settings", { scanMaxDocs: 250 });
    expect(res.status).toBe(200);
    expect((await res.json()).scanMaxDocs).toBe(250);
    expect((await get()).scanMaxDocs).toBe(250);
  });

  it("PATCH rejects an out-of-range scanMaxDocs with 400", async () => {
    expect((await patch("/api/settings", { scanMaxDocs: 0 })).status).toBe(400);
    expect((await patch("/api/settings", { scanMaxDocs: 99999 })).status).toBe(400);
  });

  it("GET exposes scanConcurrency (default 16); PATCH sets it", async () => {
    expect((await get()).scanConcurrency).toBe(16);
    const res = await patch("/api/settings", { scanConcurrency: 8 });
    expect(res.status).toBe(200);
    expect((await res.json()).scanConcurrency).toBe(8);
    expect((await get()).scanConcurrency).toBe(8);
  });

  it("PATCH rejects an out-of-range scanConcurrency with 400", async () => {
    expect((await patch("/api/settings", { scanConcurrency: 0 })).status).toBe(400);
    expect((await patch("/api/settings", { scanConcurrency: 100 })).status).toBe(400);
  });
});
