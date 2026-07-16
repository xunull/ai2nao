import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseRagConfigJson, parseRagCorpusJson, readRagConfig, readRagConfigFile } from "../src/rag/config.js";
import { resetSettingsForTest, setCredentialRaw, setSettingRaw } from "../src/settings/store.js";

describe("parseRagConfigJson", () => {
  it("accepts includeExtensions without a leading dot (e.g. md → .md)", () => {
    const cfg = parseRagConfigJson(
      JSON.stringify({
        version: 1,
        corpusRoots: ["/tmp/n"],
        includeExtensions: ["md", ".TXT", "rtf"],
      })
    );
    expect(cfg).not.toBeNull();
    expect(cfg!.includeExtensions).toEqual([".md", ".txt", ".rtf"]);
  });

  it("falls back to default extensions when array is empty", () => {
    const cfg = parseRagConfigJson(
      JSON.stringify({
        version: 1,
        corpusRoots: ["/tmp/n"],
        includeExtensions: [],
      })
    );
    expect(cfg).not.toBeNull();
    expect(cfg!.includeExtensions).toEqual([".md", ".mdx", ".txt"]);
  });

  it("parses embedded LanceDB vector store config", () => {
    const cfg = parseRagConfigJson(
      JSON.stringify({
        version: 1,
        corpusRoots: ["/tmp/n"],
        vectorStore: { provider: "lancedb", path: "/tmp/rag-lance" },
      })
    );
    expect(cfg).not.toBeNull();
    expect(cfg!.vectorStore).toEqual({ provider: "lancedb", path: "/tmp/rag-lance" });
  });
});

describe("embedding key from config.db (regressions)", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ai2nao-ragcfg-"));
    process.env.AI2NAO_CONFIG_DB = join(dir, "config.db");
    process.env.AI2NAO_RAG_CONFIG = join(dir, "rag.json");
    resetSettingsForTest();
  });
  afterEach(() => {
    resetSettingsForTest();
    rmSync(dir, { recursive: true, force: true });
  });

  const RAG_JSON = () => join(dir, "rag.json");
  const withEmbedding = (emb: Record<string, unknown>) => ({
    version: 1,
    corpusRoots: [dir],
    embedding: emb,
  });

  function storeEmbedding(v: Record<string, unknown>) {
    setCredentialRaw("rag-embedding", JSON.stringify(v));
  }

  it("REGRESSION: `--config <path>` gets the stored key (it used to fall through to 'local-no-key')", () => {
    // The key is no longer allowed to live in the file, so the file has none…
    writeFileSync(
      RAG_JSON(),
      JSON.stringify(withEmbedding({ enabled: true, baseURL: "https://api.example.com/v1", model: "emb-1" }))
    );
    storeEmbedding({ enabled: true, baseURL: "https://api.example.com/v1", model: "emb-1", apiKey: "sk-stored" });

    // …and readRagConfigFile is the `--config` seam, which skipped the store entirely.
    const cfg = readRagConfigFile(RAG_JSON());
    expect(cfg?.embedding?.apiKey).toBe("sk-stored");
  });

  it("DEFAULT path: db embedding is authoritative WHOLE — model, baseURL and key all from db", () => {
    // One source of truth. When the db has the credential, the file's embedding
    // block is not consulted at all — no "model from file, key from db" split.
    writeFileSync(
      RAG_JSON(),
      JSON.stringify(withEmbedding({ enabled: true, baseURL: "https://file.example.com/v1", model: "file-model" }))
    );
    storeEmbedding({ enabled: true, baseURL: "https://db.example.com/v1", model: "db-model", apiKey: "sk-stored" });

    const cfg = readRagConfig();
    expect(cfg?.embedding?.model).toBe("db-model");
    expect(cfg?.embedding?.baseURL).toBe("https://db.example.com/v1");
    expect(cfg?.embedding?.apiKey).toBe("sk-stored");
  });

  it("--config path: the NAMED file's model/baseURL win; db lends only the key", () => {
    // `--config <file>` means "use this file". Overriding its model with the db's
    // would silently change the vector space of the resulting index.
    writeFileSync(
      RAG_JSON(),
      JSON.stringify(withEmbedding({ enabled: true, baseURL: "https://file.example.com/v1", model: "file-model" }))
    );
    storeEmbedding({ enabled: true, baseURL: "https://db.example.com/v1", model: "db-model", apiKey: "sk-stored" });

    const cfg = readRagConfigFile(RAG_JSON());
    expect(cfg?.embedding?.model).toBe("file-model");
    expect(cfg?.embedding?.baseURL).toBe("https://file.example.com/v1");
    expect(cfg?.embedding?.apiKey).toBe("sk-stored"); // key borrowed from db
  });

  it("no embedding block in the file → the stored block IS the config (settings-page-only setup)", () => {
    writeFileSync(RAG_JSON(), JSON.stringify({ version: 1, corpusRoots: [dir] }));
    storeEmbedding({ enabled: true, baseURL: "https://db.example.com/v1", model: "db-model", apiKey: "sk-stored" });

    const cfg = readRagConfig();
    expect(cfg?.embedding).toMatchObject({
      enabled: true,
      model: "db-model",
      baseURL: "https://db.example.com/v1",
      apiKey: "sk-stored",
    });
  });

  it("nothing stored → the file's embedding is left exactly as written", () => {
    writeFileSync(
      RAG_JSON(),
      JSON.stringify(withEmbedding({ enabled: true, baseURL: "https://f/v1", model: "m", apiKey: "sk-file" }))
    );
    expect(readRagConfig()?.embedding?.apiKey).toBe("sk-file");
  });
});

describe("corpus precedence: db-first, file-fallback (mirrors getTopicTaxonomy)", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ai2nao-ragcorp-"));
    process.env.AI2NAO_CONFIG_DB = join(dir, "config.db");
    process.env.AI2NAO_RAG_CONFIG = join(dir, "rag.json");
    delete process.env.AI2NAO_RAG_CORPUS_ROOT;
    resetSettingsForTest();
  });
  afterEach(() => {
    delete process.env.AI2NAO_RAG_CORPUS_ROOT;
    resetSettingsForTest();
    rmSync(dir, { recursive: true, force: true });
  });

  const RAG_JSON = () => join(dir, "rag.json");
  const storeCorpus = (v: Record<string, unknown>) => setSettingRaw("rag-corpus", JSON.stringify(v));

  it("db corpus wins over the file", () => {
    writeFileSync(RAG_JSON(), JSON.stringify({ version: 1, corpusRoots: ["/from/file"] }));
    storeCorpus({ corpusRoots: ["/from/db"], maxFileBytes: 123456 });

    const cfg = readRagConfig();
    expect(cfg?.corpusRoots).toEqual(["/from/db"]);
    expect(cfg?.maxFileBytes).toBe(123456);
  });

  it("NEW MACHINE: no rag.json, corpus only in db → RAG is still configured (the whole point of db-first)", () => {
    // The original file-first shape returned null here and RAG could never turn on.
    storeCorpus({ corpusRoots: ["/only/in/db"] });
    const cfg = readRagConfig();
    expect(cfg).not.toBeNull();
    expect(cfg?.corpusRoots).toEqual(["/only/in/db"]);
  });

  it("a corrupt db corpus row falls through to the file, it does NOT wipe RAG", () => {
    writeFileSync(RAG_JSON(), JSON.stringify({ version: 1, corpusRoots: ["/from/file"] }));
    setSettingRaw("rag-corpus", JSON.stringify({ corpusRoots: [] })); // empty roots = invalid
    expect(readRagConfig()?.corpusRoots).toEqual(["/from/file"]);
  });

  it("neither db nor file → null (nothing configured)", () => {
    expect(readRagConfig()).toBeNull();
  });

  it("ORDERING: the env root is appended AFTER the db corpus overlay, not wiped by it", () => {
    process.env.AI2NAO_RAG_CORPUS_ROOT = "/env/root";
    storeCorpus({ corpusRoots: ["/db/root"] });
    // If mergeEnv ran before the db overlay, /env/root would be gone.
    expect(readRagConfig()?.corpusRoots).toEqual(["/db/root", "/env/root"]);
  });

  it("ONE SOURCE OF TRUTH: when db has both, the file is not read for corpus OR embedding", () => {
    // The file says something different for every field; if any of it leaked into
    // the effective config, the assertions below would catch it.
    writeFileSync(
      RAG_JSON(),
      JSON.stringify({
        version: 1,
        corpusRoots: ["/from/file"],
        embedding: { enabled: true, baseURL: "https://file/v1", model: "file-model" },
      })
    );
    storeCorpus({ corpusRoots: ["/from/db"] });
    setCredentialRaw(
      "rag-embedding",
      JSON.stringify({ enabled: true, baseURL: "https://db/v1", model: "db-model", apiKey: "sk-stored" })
    );

    const cfg = readRagConfig();
    expect(cfg?.corpusRoots).toEqual(["/from/db"]); // corpus from db
    expect(cfg?.embedding?.model).toBe("db-model"); // embedding wholly from db
    expect(cfg?.embedding?.baseURL).toBe("https://db/v1");
    expect(cfg?.embedding?.apiKey).toBe("sk-stored");
  });
});

describe("parseRagCorpusJson", () => {
  it("parses corpus fields and leaves embedding undefined", () => {
    const cfg = parseRagCorpusJson(JSON.stringify({ corpusRoots: ["/a"], maxFileBytes: 999 }));
    expect(cfg?.corpusRoots).toEqual(["/a"]);
    expect(cfg?.embedding).toBeUndefined();
    expect(cfg?.version).toBe(1);
  });

  it("rejects empty/absent corpusRoots (a corpus with no roots is not a config)", () => {
    expect(parseRagCorpusJson(JSON.stringify({ corpusRoots: [] }))).toBeNull();
    expect(parseRagCorpusJson(JSON.stringify({ maxFileBytes: 1 }))).toBeNull();
    expect(parseRagCorpusJson("not json")).toBeNull();
  });
});
