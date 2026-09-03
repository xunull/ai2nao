import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, statSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Hono } from "hono";
import type Database from "better-sqlite3";
import { createApp } from "../src/serve/app.js";
import { openDatabase } from "../src/store/open.js";
import { canonicalizePath } from "../src/path/canonical.js";
import { resetSettingsForTest } from "../src/settings/store.js";

let base: string;
let db: Database.Database;
let app: Hono;
let tokenPath: string;
let savedEnvToken: string | undefined;
let savedEnvPath: string | undefined;
let savedConfigDb: string | undefined;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "ai2nao-set-"));
  db = openDatabase(join(base, "idx.db"));
  app = createApp({ db });
  tokenPath = join(base, "github.json");
  savedEnvToken = process.env.GITHUB_TOKEN;
  savedEnvPath = process.env.AI2NAO_GITHUB_CONFIG;
  savedConfigDb = process.env.AI2NAO_CONFIG_DB;
  delete process.env.GITHUB_TOKEN;
  process.env.AI2NAO_GITHUB_CONFIG = tokenPath;
  // A fresh credential db per test — otherwise a token written by one case
  // leaks into the next (and the shared singleton would keep it open).
  process.env.AI2NAO_CONFIG_DB = join(base, "config.db");
  resetSettingsForTest();
});
afterEach(() => {
  db.close();
  resetSettingsForTest();
  rmSync(base, { recursive: true, force: true });
  if (savedEnvToken === undefined) delete process.env.GITHUB_TOKEN;
  else process.env.GITHUB_TOKEN = savedEnvToken;
  if (savedEnvPath === undefined) delete process.env.AI2NAO_GITHUB_CONFIG;
  else process.env.AI2NAO_GITHUB_CONFIG = savedEnvPath;
  if (savedConfigDb === undefined) delete process.env.AI2NAO_CONFIG_DB;
  else process.env.AI2NAO_CONFIG_DB = savedConfigDb;
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

  it("PATCH token stores it in config.db (source:db, no JSON file); DELETE clears", async () => {
    const res = await patch("/api/settings/secret/github", { token: "ghp_secret" });
    expect(res.status).toBe(200);
    // The token now lives in config.db, so the legacy 0600 JSON is never written.
    expect(existsSync(tokenPath)).toBe(false);
    expect((await get()).github).toEqual({ set: true, source: "db" });
    expect(statSync(join(base, "config.db")).mode & 0o777).toBe(0o600);

    const del = await app.request("/api/settings/secret/github", { method: "DELETE" });
    expect(del.status).toBe(200);
    expect((await get()).github).toEqual({ set: false, source: null });
  });

  it("PATCH token rejects an empty token with 400", async () => {
    const res = await patch("/api/settings/secret/github", { token: "  " });
    expect(res.status).toBe(400);
  });

  it("GITHUB_TOKEN env takes precedence (source:env) over the stored token", async () => {
    await patch("/api/settings/secret/github", { token: "ghp_stored" });
    process.env.GITHUB_TOKEN = "ghp_fromenv";
    expect((await get()).github).toEqual({ set: true, source: "env" });
  });

  it("a token still in the legacy JSON file is read (source:file) until migration", async () => {
    writeFileSync(tokenPath, JSON.stringify({ token: "ghp_legacy" }), { mode: 0o600 });
    expect((await get()).github).toEqual({ set: true, source: "file" });
    // …and config.db out-ranks it once a token is stored there.
    await patch("/api/settings/secret/github", { token: "ghp_stored" });
    expect((await get()).github).toEqual({ set: true, source: "db" });
  });

  it("GET never returns a plaintext secret — not even the last 4 chars", async () => {
    await patch("/api/settings/secret/github", { token: "ghp_supersecret_zqx9" });
    const body = await get();
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("ghp_supersecret_zqx9");
    expect(serialized).not.toContain("zqx9"); // no last-4 tail either
    expect(body.credentials.github).toMatchObject({ set: true, source: "db" });
  });

  /**
   * 新形状下 PATCH 的词汇表是 `providers.<id>.<字段>`,不再是顶层扁平字段。
   * mergePatch 会递归进对象(credentialApi.ts:117),所以「只改一个实例的一个字段」
   * 天然是安全的;而顶层写 `{model:"x"}` 会被 parse 当成陌生字段丢掉 —— 那正是
   * 前端必须与后端同批上线的原因。
   */
  const seedProviders = () =>
    patch("/api/settings/secret/llm-chat", {
      providers: {
        deepseek: {
          provider: "deepseek",
          label: "DeepSeek 官方",
          baseURL: "https://api.deepseek.com",
          apiKey: "sk-live-key",
          models: [{ model: "deepseek-chat", label: "DeepSeek Chat" }],
        },
      },
    });

  it("a partial PATCH keeps the stored key — changing only the label cannot wipe it", async () => {
    await seedProviders();
    expect((await get()).credentials["llm-chat"]).toMatchObject({ set: true, source: "db" });

    // The form shows a masked key and posts back only the field the user edited.
    const res = await patch("/api/settings/secret/llm-chat", {
      providers: { deepseek: { label: "DeepSeek 代理" } },
    });
    expect(res.status).toBe(200);
    const dto = (await res.json()).credential;
    expect(dto.set).toBe(true); // key survived
    expect(dto.values.providers.deepseek.label).toBe("DeepSeek 代理");
    // 没碰的字段一个都不能掉。
    expect(dto.values.providers.deepseek.models).toHaveLength(1);
    expect(dto.values.providers.deepseek.hasKey).toBe(true);
    expect(JSON.stringify(dto)).not.toContain("sk-live-key");
  });

  it("PATCH refuses a masked placeholder rather than overwriting the key with asterisks", async () => {
    await seedProviders();
    const res = await patch("/api/settings/secret/llm-chat", {
      providers: { deepseek: { apiKey: "********" } },
    });
    expect(res.status).toBe(400);
    // and the real key is untouched
    expect((await get()).credentials["llm-chat"].set).toBe(true);
  });

  it("PATCH null clears a single field without dropping the rest", async () => {
    await seedProviders();
    const res = await patch("/api/settings/secret/llm-chat", {
      providers: { deepseek: { apiKey: null } },
    });
    expect(res.status).toBe(200);
    const dto = (await res.json()).credential;
    expect(dto.set).toBe(false); // key gone
    expect(dto.values.providers.deepseek.models).toHaveLength(1); // rest intact
    expect(dto.values.providers.deepseek.baseURL).toBe("https://api.deepseek.com");
  });

  it("★ 删一个厂商靠显式 null,不靠省略 —— providers 是 map,省略等于「别动」", async () => {
    await seedProviders();
    const added = await patch("/api/settings/secret/llm-chat", {
      providers: { minimax: { provider: "minimax", baseURL: "https://api.minimaxi.com/v1", apiKey: "sk-mm", models: [] } },
    });
    // 上一句只提了 minimax,deepseek 必须还在 —— 这正是 map 相对数组的语义差别:
    // 旧的 models[] 是整块替换,「删一条」靠发一个短数组;providers 省略即保留。
    const afterAdd = (await added.json()).credential.values.providers;
    expect(Object.keys(afterAdd).sort()).toEqual(["deepseek", "minimax"]);

    const res = await patch("/api/settings/secret/llm-chat", { providers: { deepseek: null } });
    expect(res.status).toBe(200);
    const values = (await res.json()).credential.values;
    expect(values.providers.deepseek).toBeUndefined();
    expect(values.providers.minimax).toBeDefined();
  });

  it("PATCH to an unknown credential is 404", async () => {
    expect((await patch("/api/settings/secret/nope", { token: "x" })).status).toBe(404);
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

  it("GET exposes replayGapMinutes (default 120); PATCH sets it", async () => {
    expect((await get()).replayGapMinutes).toBe(120);
    const res = await patch("/api/settings", { replayGapMinutes: 45 });
    expect(res.status).toBe(200);
    expect((await res.json()).replayGapMinutes).toBe(45);
    expect((await get()).replayGapMinutes).toBe(45);
  });

  it("PATCH rejects an out-of-range replayGapMinutes with 400", async () => {
    expect((await patch("/api/settings", { replayGapMinutes: 0 })).status).toBe(400);
    expect((await patch("/api/settings", { replayGapMinutes: 1441 })).status).toBe(400);
  });
});
