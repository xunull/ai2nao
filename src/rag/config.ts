import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { defaultRagConfigPath } from "../config.js";
import { expandUserPath } from "../path/expandUserPath.js";
import { getCredentialRaw, getSettingRaw } from "../settings/store.js";
import type { RagConfigV1 } from "./types.js";

function configPathFromEnv(): string {
  const raw = (process.env.AI2NAO_RAG_CONFIG ?? "").trim();
  return raw.length > 0 ? resolve(raw) : defaultRagConfigPath();
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

const DEFAULT_EXTS = [".md", ".mdx", ".txt"];

/** `md` / `.md` / `.MD` → `.md` */
function normalizeIncludeExtension(s: string): string | null {
  const t = s.trim().toLowerCase();
  if (t.length === 0) return null;
  if (t.startsWith(".")) return t;
  return `.${t}`;
}

/** The non-embedding half of a rag config: corpus roots, filters, vector store.
 * Shared by `parseRagConfigJson` (whole file) and `parseRagCorpusJson` (the
 * db-stored setting) so the two never drift. Returns null when corpusRoots is
 * missing/empty — a corpus config with no roots is not a config. */
type CorpusFields = Omit<RagConfigV1, "version" | "embedding">;

function parseCorpusFields(data: Record<string, unknown>): CorpusFields | null {
  const rootsRaw = data.corpusRoots;
  if (!Array.isArray(rootsRaw) || rootsRaw.length === 0) return null;
  const corpusRoots: string[] = [];
  for (const r of rootsRaw) {
    if (typeof r !== "string" || !r.trim()) return null;
    corpusRoots.push(expandUserPath(r));
  }
  let includeExtensions: string[];
  if (Array.isArray(data.includeExtensions)) {
    const parsed = (data.includeExtensions as unknown[])
      .map((x) => (typeof x === "string" ? normalizeIncludeExtension(x) : null))
      .filter((x): x is string => x !== null);
    includeExtensions = parsed.length > 0 ? parsed : DEFAULT_EXTS;
  } else {
    includeExtensions = [...DEFAULT_EXTS];
  }

  const maxFileBytes =
    typeof data.maxFileBytes === "number" && data.maxFileBytes > 0
      ? Math.min(data.maxFileBytes, 64 * 1024 * 1024)
      : 8 * 1024 * 1024;

  const respectDefaultExcludes =
    typeof data.respectDefaultExcludes === "boolean"
      ? data.respectDefaultExcludes
      : true;

  let vectorStore: RagConfigV1["vectorStore"];
  if (isRecord(data.vectorStore)) {
    const provider = data.vectorStore.provider;
    if (provider === "none") {
      vectorStore = { provider: "none" };
    } else if (provider === "lancedb") {
      const rawPath = data.vectorStore.path;
      vectorStore = {
        provider: "lancedb",
        ...(typeof rawPath === "string" && rawPath.trim()
          ? { path: expandUserPath(rawPath.trim()) }
          : {}),
      };
    }
  }

  return { corpusRoots, includeExtensions, maxFileBytes, respectDefaultExcludes, vectorStore };
}

/** Parse the db-stored `rag-corpus` setting (corpus fields only, no embedding). */
export function parseRagCorpusJson(raw: string): RagConfigV1 | null {
  let data: unknown;
  try {
    data = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
  if (!isRecord(data)) return null;
  const corpus = parseCorpusFields(data);
  if (!corpus) return null;
  return { version: 1, ...corpus, embedding: undefined };
}

export function parseRagConfigJson(raw: string): RagConfigV1 | null {
  let data: unknown;
  try {
    data = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
  if (!isRecord(data)) return null;
  if (data.version !== 1) return null;
  const corpus = parseCorpusFields(data);
  if (!corpus) return null;

  let embedding: RagConfigV1["embedding"];
  if (isRecord(data.embedding) && data.embedding.enabled === true) {
    const baseURL = data.embedding.baseURL;
    const model = data.embedding.model;
    if (typeof baseURL === "string" && baseURL.trim() && typeof model === "string" && model.trim()) {
      const apiKey =
        typeof data.embedding.apiKey === "string" && data.embedding.apiKey.trim()
          ? data.embedding.apiKey.trim()
          : undefined;
      const rawBatch = data.embedding.maxBatchSize;
      const maxBatchSize =
        typeof rawBatch === "number" &&
        Number.isFinite(rawBatch) &&
        rawBatch >= 1
          ? Math.min(Math.floor(rawBatch), 2048)
          : undefined;
      embedding = {
        enabled: true,
        baseURL: baseURL.trim(),
        model: model.trim(),
        apiKey,
        ...(maxBatchSize !== undefined ? { maxBatchSize } : {}),
      };
    }
    /* 若 embedding 写了一半（缺 baseURL/model），不再整表解析失败，只当作未启用 embedding */
  }

  return { version: 1, ...corpus, embedding };
}

/**
 * Load `~/.ai2nao/rag.json` (or `AI2NAO_RAG_CONFIG`), optionally add
 * `AI2NAO_RAG_CORPUS_ROOT` as a single extra root.
 */
function mergeEnvCorpusRoot(cfg: RagConfigV1): RagConfigV1 {
  const extra = (process.env.AI2NAO_RAG_CORPUS_ROOT ?? "").trim();
  if (!extra) return cfg;
  const r = expandUserPath(extra);
  if (cfg.corpusRoots.includes(r)) return cfg;
  return { ...cfg, corpusRoots: [...cfg.corpusRoots, r] };
}

/**
 * The `embedding` block of rag.json, parsed on its own so it can be stored as a
 * credential. Mirrors the checks `parseRagConfigJson` applies to that block, so
 * a value accepted here is one that function would also accept.
 */
export function parseRagEmbeddingJson(raw: string): RagConfigV1["embedding"] | null {
  let data: unknown;
  try {
    data = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
  if (!isRecord(data)) return null;
  if (data.enabled !== true) return null;
  const baseURL = typeof data.baseURL === "string" ? data.baseURL.trim() : "";
  const model = typeof data.model === "string" ? data.model.trim() : "";
  if (!baseURL || !model) return null;
  const apiKey =
    typeof data.apiKey === "string" && data.apiKey.trim() ? data.apiKey.trim() : undefined;
  const rawBatch = data.maxBatchSize;
  const maxBatchSize =
    typeof rawBatch === "number" && Number.isFinite(rawBatch) && rawBatch >= 1
      ? Math.min(Math.floor(rawBatch), 2048)
      : undefined;
  return {
    enabled: true,
    baseURL,
    model,
    apiKey,
    ...(maxBatchSize !== undefined ? { maxBatchSize } : {}),
  };
}

/**
 * Merge the stored embedding credential into a file-derived config.
 *
 * It fills in the API KEY and nothing else. Replacing the whole `embedding`
 * block (the original shape here) meant the stored `model` silently out-ranked
 * the file's — so `rag ingest --config other.json` would embed with a different
 * model than the file asked for, and hand-editing `embedding.model` in rag.json
 * became a no-op. The embedding model fixes the vector space and its dimension;
 * `markVectorSync` (rag/meta.ts) only RECORDS the model, nothing rejects a
 * mismatch, so a silently-swapped model produces an index that is quietly
 * garbage. baseURL and model stay whatever the config says; only the secret,
 * which the file is no longer allowed to hold, comes from the store.
 */
function mergeStoredEmbedding(cfg: RagConfigV1): RagConfigV1 {
  const stored = (() => {
    const raw = getCredentialRaw("rag-embedding");
    return raw ? parseRagEmbeddingJson(raw) : null;
  })();
  const fileEmb = cfg.embedding;

  // No embedding block in the config at all — the stored one IS the config. This
  // is the path for someone who configured embedding only in the settings page.
  if (!fileEmb?.enabled) {
    return stored ? { ...cfg, embedding: stored } : cfg;
  }
  // The config declares its own embedding: model and baseURL are its business.
  // Only the key — which the file is no longer allowed to hold — comes from the
  // store, and only when the config didn't supply one.
  if (fileEmb.apiKey || !stored?.apiKey) return cfg;
  return { ...cfg, embedding: { ...fileEmb, apiKey: stored.apiKey } };
}

/** The corpus config from rag.json, or null when the file is absent/invalid. */
function readRagFileConfig(): RagConfigV1 | null {
  const path = configPathFromEnv();
  if (!existsSync(path)) return null;
  try {
    return parseRagConfigJson(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

/** The file's corpus, embedding stripped — the settings-page fallback view when
 * no db `rag-corpus` row exists yet. */
export function readRagFileCorpus(): RagConfigV1 | null {
  const cfg = readRagFileConfig();
  return cfg ? { ...cfg, embedding: undefined } : null;
}

/**
 * The corpus config actually in effect: config.db → rag.json. Mirrors
 * `getTopicTaxonomy`'s precedence exactly — db wins, the file is the fallback,
 * and a CORRUPT db row falls through to the file rather than wiping RAG. (The
 * original shape here read the file FIRST and let the db only overlay, which
 * meant a machine with no rag.json could never turn RAG on from the settings
 * page — the db could never be authoritative.)
 *
 * The file's embedding block (model/baseURL) rides along regardless of where the
 * corpus came from; `mergeStoredEmbedding` then supplies the key.
 */
function resolveRagCorpus(): RagConfigV1 | null {
  const storedRaw = getSettingRaw("rag-corpus");
  const fileCfg = readRagFileConfig();
  if (storedRaw) {
    const corpus = parseRagCorpusJson(storedRaw);
    if (corpus) return { ...corpus, embedding: fileCfg?.embedding };
    // corrupt stored row → don't take RAG down, use the file
  }
  return fileCfg;
}

/**
 * Effective RAG config: db-or-file corpus → append env root → fill embedding key.
 *
 * Order is load-bearing. `mergeEnvCorpusRoot` APPENDS `AI2NAO_RAG_CORPUS_ROOT`,
 * so it must run AFTER the corpus is resolved — running it before a db overlay
 * that replaces `corpusRoots` wholesale would silently drop the env root.
 */
export function readRagConfig(): RagConfigV1 | null {
  const cfg = resolveRagCorpus();
  if (!cfg) return null;
  return mergeStoredEmbedding(mergeEnvCorpusRoot(cfg));
}

/**
 * Read a specific `rag.json` (`ai2nao rag ingest --config ./rag.json`).
 *
 * The stored embedding KEY is merged in here too. `--config` means "use this
 * corpus config", not "forget the key I saved" — and since the key is no longer
 * allowed to live in the file, skipping the store left this path with no key at
 * all: it fell through to the literal `"local-no-key"` placeholder
 * (rag/embeddings.ts) and got a 401 whose message pointed nowhere near the cause.
 */
export function readRagConfigFile(path: string): RagConfigV1 | null {
  const p = resolve(path.trim());
  if (!existsSync(p)) {
    return null;
  }
  try {
    const raw = readFileSync(p, "utf8");
    const cfg = parseRagConfigJson(raw);
    if (!cfg) return null;
    return mergeStoredEmbedding(mergeEnvCorpusRoot(cfg));
  } catch {
    return null;
  }
}

export function resolveRagConfigPath(): string {
  return configPathFromEnv();
}

/**
 * Merge CLI `--root` args over file config. Priority: CLI > file > env single root
 * (env is merged in readRagConfig).
 */
export function effectiveCorpusRoots(
  cfg: RagConfigV1 | null,
  cliRoots: string[]
): { roots: string[]; error: string | null } {
  const fromCli = cliRoots.map((r) => expandUserPath(r)).filter((p) => p.length > 0);
  if (fromCli.length > 0) {
    return { roots: fromCli, error: null };
  }
  if (cfg?.corpusRoots?.length) {
    return { roots: cfg.corpusRoots, error: null };
  }
  const one = (process.env.AI2NAO_RAG_CORPUS_ROOT ?? "").trim();
  if (one) {
    return { roots: [expandUserPath(one)], error: null };
  }
  return {
    roots: [],
    error:
      "No corpus roots. Add them in 设置 → RAG 知识库, or pass --root <path>, or set AI2NAO_RAG_CORPUS_ROOT (~/.ai2nao/rag.json also still works).",
  };
}
