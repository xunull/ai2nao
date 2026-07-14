import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseRagConfigJson, readRagConfig, readRagConfigFile } from "../src/rag/config.js";
import { resetSettingsForTest, setCredentialRaw } from "../src/settings/store.js";

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

  it("REGRESSION: the stored key does NOT override the config's model or baseURL", () => {
    // A silently-swapped embedding model changes the vector space; nothing in the
    // index rejects the mismatch, so the result is quietly-garbage vectors.
    writeFileSync(
      RAG_JSON(),
      JSON.stringify(withEmbedding({ enabled: true, baseURL: "https://file.example.com/v1", model: "file-model" }))
    );
    storeEmbedding({ enabled: true, baseURL: "https://db.example.com/v1", model: "db-model", apiKey: "sk-stored" });

    for (const cfg of [readRagConfig(), readRagConfigFile(RAG_JSON())]) {
      expect(cfg?.embedding?.model).toBe("file-model");
      expect(cfg?.embedding?.baseURL).toBe("https://file.example.com/v1");
      expect(cfg?.embedding?.apiKey).toBe("sk-stored"); // only the secret comes from the store
    }
  });

  it("a key written in the config file wins over the stored one (explicit beats implicit)", () => {
    writeFileSync(
      RAG_JSON(),
      JSON.stringify(
        withEmbedding({ enabled: true, baseURL: "https://api.example.com/v1", model: "emb-1", apiKey: "sk-from-file" })
      )
    );
    storeEmbedding({ enabled: true, baseURL: "https://api.example.com/v1", model: "emb-1", apiKey: "sk-stored" });
    expect(readRagConfig()?.embedding?.apiKey).toBe("sk-from-file");
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
