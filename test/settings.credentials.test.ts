import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { migrateCredentials } from "../src/settings/migrate.js";
import {
  configDbPath,
  getCredentialRaw,
  resetSettingsForTest,
  setCredentialRaw,
} from "../src/settings/store.js";
import { openDatabase } from "../src/store/open.js";

let dir: string;
let db: Database.Database;

// The global setup (test/setup/isolateCredentials.ts) already redirects every
// AI2NAO_*_CONFIG path into a temp dir. Here we redirect them again, per test,
// so each case starts from an empty ~/.ai2nao equivalent.
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ai2nao-cred-"));
  process.env.AI2NAO_CONFIG_DB = join(dir, "config.db");
  process.env.AI2NAO_GITHUB_CONFIG = join(dir, "github.json");
  process.env.AI2NAO_LLM_CHAT_CONFIG = join(dir, "llm-chat.json");
  process.env.AI2NAO_WEB_SEARCH_CONFIG = join(dir, "web-search.json");
  process.env.AI2NAO_RAG_CONFIG = join(dir, "rag.json");
  process.env.AI2NAO_NOTIFY_CONFIG = join(dir, "notify.json");
  resetSettingsForTest();
  db = openDatabase(join(dir, "index.db"));
});

afterEach(() => {
  db.close();
  resetSettingsForTest();
});

describe("credential store", () => {
  it("round-trips a value and creates config.db as 0600", () => {
    setCredentialRaw("llm-chat", JSON.stringify({ provider: "openai", model: "gpt-4o" }));
    expect(JSON.parse(getCredentialRaw("llm-chat")!)).toEqual({
      provider: "openai",
      model: "gpt-4o",
    });
    expect(statSync(configDbPath()).mode & 0o777).toBe(0o600);
  });

  it("an unset credential is null, not a throw", () => {
    expect(getCredentialRaw("feishu")).toBeNull();
  });

  it("a corrupt config.db degrades to 'nothing configured' instead of bricking", () => {
    const path = join(dir, "corrupt.db");
    writeFileSync(path, "this is not a sqlite file at all");
    process.env.AI2NAO_CONFIG_DB = path;
    resetSettingsForTest();
    // Reading must not throw — every feature already handles "no config" as off.
    expect(getCredentialRaw("llm-chat")).toBeNull();
  });
});

describe("credential migration", () => {
  const GITHUB_JSON = () => join(dir, "github.json");
  const LLM_JSON = () => join(dir, "llm-chat.json");
  const RAG_JSON = () => join(dir, "rag.json");

  it("copies the JSON files in, renames them .migrated, and is idempotent", () => {
    writeFileSync(GITHUB_JSON(), JSON.stringify({ token: "ghp_from_file" }));
    writeFileSync(
      LLM_JSON(),
      JSON.stringify({ provider: "deepseek", model: "deepseek-chat", apiKey: "sk-file" })
    );

    const first = migrateCredentials(db);
    expect(first.migrated.sort()).toEqual(["github", "llm-chat"]);

    // Values landed. github is byte-identical in meaning (parsed, not translated).
    expect(JSON.parse(getCredentialRaw("github")!).token).toBe("ghp_from_file");
    // llm-chat **是**翻译过的:parse 把三种历史形状归一到 providers{}。
    // 归一的理由见 llmChat/document.ts —— 前端拿不到密钥原文,搬运只能在服务端做。
    // 这里守的是「搬家不丢东西」:那把 key 必须还在,只是换了住址。
    const llm = JSON.parse(getCredentialRaw("llm-chat")!);
    const insts = Object.values(llm.providers) as { apiKey?: string; models: unknown[] }[];
    expect(insts).toHaveLength(1);
    expect(insts[0].apiKey).toBe("sk-file");
    expect(llm.defaultModel).toEqual({
      providerId: Object.keys(llm.providers)[0],
      model: "deepseek-chat",
    });

    // Files retired, not deleted — a bad migration stays recoverable by hand.
    expect(existsSync(GITHUB_JSON())).toBe(false);
    expect(existsSync(`${GITHUB_JSON()}.migrated`)).toBe(true);

    // Second run does nothing (marker), and does not resurrect anything.
    const second = migrateCredentials(db);
    expect(second.migrated).toEqual([]);
    expect(second.skipped).toBe(true);
  });

  it("a file recreated after migration is ignored — the marker means db wins", () => {
    writeFileSync(GITHUB_JSON(), JSON.stringify({ token: "ghp_first" }));
    migrateCredentials(db);
    expect(JSON.parse(getCredentialRaw("github")!).token).toBe("ghp_first");

    writeFileSync(GITHUB_JSON(), JSON.stringify({ token: "ghp_second" }));
    migrateCredentials(db);
    // Still the migrated value: the marker guards the import, so hand-editing
    // the old file has no effect. The settings UI has to say so.
    expect(JSON.parse(getCredentialRaw("github")!).token).toBe("ghp_first");
  });

  it("takes ONLY the embedding block from rag.json and leaves the file untouched", () => {
    const ragBody = {
      version: 1,
      corpusRoots: ["~/notes"],
      embedding: {
        enabled: true,
        baseURL: "https://api.example.com/v1",
        model: "text-embed",
        apiKey: "sk-embed",
      },
    };
    writeFileSync(RAG_JSON(), JSON.stringify(ragBody));

    const res = migrateCredentials(db);
    expect(res.migrated).toContain("rag-embedding");
    expect(JSON.parse(getCredentialRaw("rag-embedding")!).apiKey).toBe("sk-embed");

    // rag.json also holds corpusRoots — losing it would break RAG entirely, so
    // the file is neither renamed nor rewritten.
    expect(existsSync(RAG_JSON())).toBe(true);
    expect(existsSync(`${RAG_JSON()}.migrated`)).toBe(false);
    expect(JSON.parse(readFileSync(RAG_JSON(), "utf8"))).toEqual(ragBody);
  });

  it("lifts the MiniMax key out of index.db and blanks the plaintext column", () => {
    db.prepare(
      `INSERT INTO provider_config (provider, enabled, history_enabled, api_key, updated_at)
       VALUES ('minimax', 1, 1, 'mm-secret-key', datetime('now'))`
    ).run();

    const res = migrateCredentials(db);
    expect(res.migrated).toContain("minimax");
    expect(JSON.parse(getCredentialRaw("minimax")!).apiKey).toBe("mm-secret-key");

    // The whole point: the key stops riding along inside the big index.db, which
    // is too large to exclude from a backup daemon.
    const row = db
      .prepare("SELECT api_key FROM provider_config WHERE provider = 'minimax'")
      .get() as { api_key: string | null };
    expect(row.api_key).toBeNull();
  });

  it("nothing to migrate → no marker-less rerun, no crash", () => {
    const res = migrateCredentials(db);
    expect(res.migrated).toEqual([]);
    // A second call is still cheap and still safe.
    expect(migrateCredentials(db).migrated).toEqual([]);
  });
});
