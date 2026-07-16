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
 * The `--config <file>` path only. The named file is authoritative for the
 * embedding — its model/baseURL win — and the store lends ONLY the API key, and
 * only when the file's block has none (the key is no longer allowed in the file).
 *
 * This differs from the default path on purpose: `--config` means "use this
 * file". Overriding the file's model with the db's would change the vector space
 * silently (`markVectorSync` in rag/meta.ts records the model but rejects no
 * mismatch → a quietly-garbage index). The default path, by contrast, takes the
 * embedding wholly from db — see `resolveStoredEmbedding`.
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
 * The corpus config in effect: config.db → rag.json, WHOLE, never field-mixed.
 * db wins entirely; the file is read only when db has no `rag-corpus` row (or it
 * is corrupt — then the file is the safety net rather than a wiped RAG).
 */
function resolveRagCorpus(): RagConfigV1 | null {
  const storedRaw = getSettingRaw("rag-corpus");
  if (storedRaw) {
    const corpus = parseRagCorpusJson(storedRaw);
    if (corpus) return corpus; // embedding stays undefined; resolved separately
    // corrupt stored row → fall through to the file rather than take RAG down
  }
  return readRagFileConfig();
}

/**
 * The embedding config in effect for the DEFAULT path: the db `rag-embedding`
 * credential, WHOLE (model + baseURL + key). The file's embedding block is used
 * only when db has no credential. No field-level mixing — that split ("model
 * from the file, key from db") was the source of the "以什么为准" confusion.
 */
function resolveStoredEmbedding(fileEmbedding: RagConfigV1["embedding"]): RagConfigV1["embedding"] {
  const raw = getCredentialRaw("rag-embedding");
  const stored = raw ? parseRagEmbeddingJson(raw) : null;
  return stored ?? fileEmbedding;
}

/**
 * Effective RAG config for the default (no `--config`) path. ONE source of
 * truth: config.db. corpus and embedding each come wholly from the db when the
 * db has them; rag.json is touched only for the parts the db lacks. So on a
 * machine whose db holds both, rag.json is never read.
 *
 * `mergeEnvCorpusRoot` APPENDS `AI2NAO_RAG_CORPUS_ROOT`, so it runs AFTER the
 * corpus is resolved — appending before a wholesale db corpus would drop it.
 */
export function readRagConfig(): RagConfigV1 | null {
  const corpus = resolveRagCorpus();
  if (!corpus) return null;
  const withEnv = mergeEnvCorpusRoot(corpus);
  return { ...withEnv, embedding: resolveStoredEmbedding(withEnv.embedding) };
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
