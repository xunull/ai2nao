import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { defaultRagConfigPath } from "../config.js";
import { expandUserPath } from "../path/expandUserPath.js";
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

export function parseRagConfigJson(raw: string): RagConfigV1 | null {
  let data: unknown;
  try {
    data = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
  if (!isRecord(data)) return null;
  if (data.version !== 1) return null;
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

  return {
    version: 1,
    corpusRoots,
    includeExtensions,
    maxFileBytes,
    respectDefaultExcludes,
    embedding,
  };
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

export function readRagConfig(): RagConfigV1 | null {
  const path = configPathFromEnv();
  if (!existsSync(path)) {
    return null;
  }
  try {
    const raw = readFileSync(path, "utf8");
    const cfg = parseRagConfigJson(raw);
    if (!cfg) return null;
    return mergeEnvCorpusRoot(cfg);
  } catch {
    return null;
  }
}

/** Read a specific `rag.json` (e.g. `ai2nao rag ingest --config ./rag.json`). */
export function readRagConfigFile(path: string): RagConfigV1 | null {
  const p = resolve(path.trim());
  if (!existsSync(p)) {
    return null;
  }
  try {
    const raw = readFileSync(p, "utf8");
    const cfg = parseRagConfigJson(raw);
    if (!cfg) return null;
    return mergeEnvCorpusRoot(cfg);
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
      "No corpus roots. Add corpusRoots to ~/.ai2nao/rag.json, or pass --root <path>, or set AI2NAO_RAG_CORPUS_ROOT.",
  };
}
