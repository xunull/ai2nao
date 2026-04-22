import type { RagConfigV1 } from "./types.js";
import { readLlmChatConfig } from "../llmChat/config.js";

export type EmbeddingResult = { dim: number; vector: Float32Array };

/**
 * OpenAI-compatible POST /v1/embeddings. Uses rag embedding block or LLM config base + key.
 */
export async function fetchEmbedding(
  text: string,
  cfg: RagConfigV1
): Promise<EmbeddingResult> {
  const emb = cfg.embedding;
  if (!emb?.enabled) {
    throw new Error("embedding not enabled in rag.json");
  }
  const llm = readLlmChatConfig();
  const baseURL = (emb.baseURL || llm?.baseURL || "").replace(/\/$/, "");
  if (!baseURL) {
    throw new Error("embedding baseURL missing (set in rag.json or llm-chat.json)");
  }
  const apiKey =
    emb.apiKey?.trim() ||
    llm?.apiKey?.trim() ||
    process.env.AI2NAO_LLM_API_KEY?.trim() ||
    process.env.OPENAI_API_KEY?.trim() ||
    "local-no-key";
  const url = baseURL.includes("/v1")
    ? `${baseURL}/embeddings`
    : `${baseURL}/v1/embeddings`;
  const r = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: emb.model,
      input: text,
    }),
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`embeddings HTTP ${r.status}: ${t.slice(0, 200)}`);
  }
  const j = (await r.json()) as {
    data?: { embedding: number[] }[];
  };
  const vec = j.data?.[0]?.embedding;
  if (!Array.isArray(vec) || vec.length === 0) {
    throw new Error("embeddings: empty vector in response");
  }
  const f32 = new Float32Array(vec);
  return { dim: f32.length, vector: f32 };
}

/** Default cap: 通义等国内接口常限制每批 ≤10；OpenAI 可在 rag.json 里设大些。 */
const DEFAULT_EMBEDDINGS_MAX_BATCH = 10;

async function fetchEmbeddingsBatchOnce(
  texts: string[],
  emb: NonNullable<RagConfigV1["embedding"]>,
  baseURL: string,
  apiKey: string
): Promise<EmbeddingResult[]> {
  const url = baseURL.includes("/v1")
    ? `${baseURL}/embeddings`
    : `${baseURL}/v1/embeddings`;
  const r = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: emb.model,
      input: texts,
    }),
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`embeddings HTTP ${r.status}: ${t.slice(0, 200)}`);
  }
  const j = (await r.json()) as {
    data?: { index: number; embedding: number[] }[];
  };
  const rows = j.data;
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error("embeddings: empty data[]");
  }
  const sorted = [...rows].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  return sorted.map((row) => {
    const vec = row.embedding;
    if (!Array.isArray(vec) || vec.length === 0) {
      throw new Error("embeddings: bad row");
    }
    const f32 = new Float32Array(vec);
    return { dim: f32.length, vector: f32 };
  });
}

export async function fetchEmbeddingsBatch(
  texts: string[],
  cfg: RagConfigV1
): Promise<EmbeddingResult[]> {
  const emb = cfg.embedding;
  if (!emb?.enabled) {
    throw new Error("embedding not enabled in rag.json");
  }
  if (texts.length === 0) {
    return [];
  }
  const llm = readLlmChatConfig();
  const baseURL = (emb.baseURL || llm?.baseURL || "").replace(/\/$/, "");
  if (!baseURL) {
    throw new Error("embedding baseURL missing");
  }
  const apiKey =
    emb.apiKey?.trim() ||
    llm?.apiKey?.trim() ||
    process.env.AI2NAO_LLM_API_KEY?.trim() ||
    process.env.OPENAI_API_KEY?.trim() ||
    "local-no-key";
  const maxBatch = Math.min(
    2048,
    Math.max(
      1,
      emb.maxBatchSize ?? DEFAULT_EMBEDDINGS_MAX_BATCH
    )
  );
  const out: EmbeddingResult[] = [];
  for (let i = 0; i < texts.length; i += maxBatch) {
    const slice = texts.slice(i, i + maxBatch);
    const part = await fetchEmbeddingsBatchOnce(slice, emb, baseURL, apiKey);
    if (part.length !== slice.length) {
      throw new Error(
        `embeddings: batch returned ${part.length} vectors, expected ${slice.length}`
      );
    }
    out.push(...part);
  }
  return out;
}

export function float32ToBlob(v: Float32Array): Buffer {
  return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
}

export function blobToFloat32(b: Buffer): Float32Array {
  return new Float32Array(b.buffer, b.byteOffset, b.length / 4);
}

export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) + 1e-8);
}
