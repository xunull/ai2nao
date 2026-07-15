import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import type { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/serve/app.js";
import { migrateRagSettings } from "../src/settings/migrate.js";
import { patchSetting, settingDto } from "../src/settings/settingApi.js";
import { getConfigMeta, getSettingRaw, resetSettingsForTest, setConfigMeta } from "../src/settings/store.js";
import { openDatabase } from "../src/store/open.js";

let dir: string;
let db: Database.Database;
let app: Hono;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ai2nao-ragset-"));
  process.env.AI2NAO_CONFIG_DB = join(dir, "config.db");
  process.env.AI2NAO_RAG_CONFIG = join(dir, "rag.json");
  resetSettingsForTest();
  db = openDatabase(join(dir, "idx.db"));
  app = createApp({ db });
});
afterEach(() => {
  db.close();
  resetSettingsForTest();
  rmSync(dir, { recursive: true, force: true });
});

const RAG_JSON = () => join(dir, "rag.json");
const mkdir = (name: string) => {
  const p = join(dir, name);
  mkdirSync(p, { recursive: true });
  return p;
};
const patch = (name: string, body: unknown) =>
  app.request(`/api/settings/setting/${name}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

describe("rag-corpus setting API", () => {
  it("saves corpusRoots (must exist) and GET reflects source=db", async () => {
    const root = mkdir("code");
    const res = await patch("rag-corpus", { corpusRoots: [root] });
    expect(res.status).toBe(200);
    const dto = (await res.json()).setting;
    expect(dto.source).toBe("db");
    expect((dto.values as { corpusRoots: string[] }).corpusRoots).toEqual([root]);

    const all = await app.request("/api/settings").then((r) => r.json());
    expect(all.settings["rag-corpus"].source).toBe("db");
  });

  it("rejects a non-existent root with 400, does not save", async () => {
    const res = await patch("rag-corpus", { corpusRoots: [join(dir, "nope")] });
    expect(res.status).toBe(400);
    expect(getSettingRaw("rag-corpus")).toBeNull();
  });

  it("rejects a file (not a directory) and a relative path", async () => {
    const f = join(dir, "a-file");
    writeFileSync(f, "x");
    expect((await patch("rag-corpus", { corpusRoots: [f] })).status).toBe(400);
    expect((await patch("rag-corpus", { corpusRoots: ["relative/path"] })).status).toBe(400);
  });

  it("partial patch keeps existing roots when only maxFileBytes changes", async () => {
    const root = mkdir("code");
    await patch("rag-corpus", { corpusRoots: [root] });
    const res = await patch("rag-corpus", { maxFileBytes: 4096 });
    expect(res.status).toBe(200);
    const v = (await res.json()).setting.values as { corpusRoots: string[]; maxFileBytes: number };
    expect(v.corpusRoots).toEqual([root]); // survived
    expect(v.maxFileBytes).toBe(4096);
  });

  it("does NOT canonicalize (realpath) the roots — manifest keys stay stable", async () => {
    // A root that resolves fine but would change under realpath must be stored
    // verbatim (expandUserPath only), or ingest's source_root would drift and
    // trigger a full re-embed.
    const root = mkdir("code");
    await patch("rag-corpus", { corpusRoots: [root] });
    const stored = JSON.parse(getSettingRaw("rag-corpus")!) as { corpusRoots: string[] };
    expect(stored.corpusRoots).toEqual([root]); // exactly what we passed, not a realpath
  });

  it("DELETE clears the stored setting, falling back to rag.json", async () => {
    const root = mkdir("code");
    writeFileSync(RAG_JSON(), JSON.stringify({ version: 1, corpusRoots: [root] }));
    await patch("rag-corpus", { corpusRoots: [root] });
    expect(settingDto("rag-corpus").source).toBe("db");

    const del = await app.request("/api/settings/setting/rag-corpus", { method: "DELETE" });
    expect(del.status).toBe(200);
    expect(settingDto("rag-corpus").source).toBe("file"); // rag.json still there
  });

  it("unknown setting name is 404", async () => {
    expect((await patch("nope", { corpusRoots: ["/x"] })).status).toBe(404);
  });
});

describe("rag settings migration", () => {
  it("imports rag.json's corpus into config.db and does NOT rename the file", () => {
    const root = mkdir("notes");
    writeFileSync(
      RAG_JSON(),
      JSON.stringify({ version: 1, corpusRoots: [root], maxFileBytes: 555 })
    );
    const res = migrateRagSettings();
    expect(res.migrated).toBe(true);

    const stored = JSON.parse(getSettingRaw("rag-corpus")!) as { corpusRoots: string[]; maxFileBytes: number };
    expect(stored.corpusRoots).toEqual([root]);
    expect(stored.maxFileBytes).toBe(555);

    // rag.json is the live fallback — never renamed.
    expect(require("node:fs").existsSync(RAG_JSON())).toBe(true);
    expect(require("node:fs").existsSync(`${RAG_JSON()}.migrated`)).toBe(false);
  });

  it("CRITICAL: still runs on a machine where the CREDENTIAL marker is already set", () => {
    // This is the bug that only bites already-migrated machines: reusing
    // config.migratedAt would short-circuit and the rag import would never run.
    setConfigMeta("config.migratedAt", "2020-01-01"); // credential migration already done
    const root = mkdir("notes");
    writeFileSync(RAG_JSON(), JSON.stringify({ version: 1, corpusRoots: [root] }));

    const res = migrateRagSettings();
    expect(res.migrated).toBe(true); // its own marker is independent
    expect(getSettingRaw("rag-corpus")).not.toBeNull();
  });

  it("writes its marker even with nothing to import, so it doesn't re-run and re-clobber UI edits", () => {
    // No rag.json at all.
    const first = migrateRagSettings();
    expect(first.migrated).toBe(false);
    expect(getConfigMeta("config.ragSettingsMigratedAt")).not.toBeNull();

    // Now the user configures RAG via the UI...
    const root = mkdir("ui-set");
    patchSetting("rag-corpus", { corpusRoots: [root] });
    // ...and a later rag.json appears. Migration must NOT overwrite the UI value.
    writeFileSync(RAG_JSON(), JSON.stringify({ version: 1, corpusRoots: [join(dir, "from-file")] }));
    migrateRagSettings();
    const stored = JSON.parse(getSettingRaw("rag-corpus")!) as { corpusRoots: string[] };
    expect(stored.corpusRoots).toEqual([root]); // UI value preserved
  });

  it("is idempotent", () => {
    const root = mkdir("notes");
    writeFileSync(RAG_JSON(), JSON.stringify({ version: 1, corpusRoots: [root] }));
    expect(migrateRagSettings().migrated).toBe(true);
    expect(migrateRagSettings().migrated).toBe(false); // marker guards
  });
});
