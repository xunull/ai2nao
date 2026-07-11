import type Database from "better-sqlite3";
import {
  fetchEmbeddingsBatch,
  float32ToBlob,
  blobToFloat32,
  type EmbeddingResult,
} from "../rag/embeddings.js";
import { readRagConfig } from "../rag/config.js";
import type { RagConfigV1 } from "../rag/types.js";
import { stripControlTags } from "../workCosmos/summarize.js";
import { OTHER_CATEGORY, OTHER_COLOR } from "./classify.js";
import {
  CONVERSATION_SOURCE,
  CONVERSATION_PROFILE,
  CONVERSATION_RULE_VERSION,
  persistTopicStream,
  upsertState,
  derivedCount,
  nowIso,
  localDayFromIso,
  type TopicStreamEvent,
  type TopicRebuildDiagnostic,
  type RebuildTopicStreamResult,
} from "./rebuild.js";

/** Chat sources that carry human messages in agent_user_messages. */
export const CONVERSATION_SOURCES = ["claude", "codex", "opencode"] as const;
/** Fixed cluster count (config-overridable later); 12 + 其他 keeps bands readable. */
export const CONVERSATION_K = 12;
/** far-drift threshold: nearest-centroid cosine distance > τ → 其他 (probe: ~0.30). */
export const CONVERSATION_TAU = 0.3;
/** Skip a session with less than this much aggregated human text. */
export const CONVERSATION_MIN_CHARS = 20;
/** Below this many eligible sessions the clusters are meaningless — don't build. */
export const CONVERSATION_COLD_FLOOR = 120;
/** Cap per-session text fed to the embedder (avoid pathological huge inputs). */
const CONVERSATION_MAX_TEXT = 8000;
/**
 * Bump when aggregation/noise-filtering changes, so cached vectors (which were
 * embedded from the old text) are recomputed. Part of the embed cache key.
 */
const CONVERSATION_PREP_VERSION = "conv-prep-v2";
/** Deterministic k-means seed so a freeze is reproducible / assertable in tests. */
const CONVERSATION_KMEANS_SEED = 42;

/** Band palette (matches the river page's fallback). color = PALETTE[cluster_id % len]. */
const CONVERSATION_PALETTE = [
  "#4f9dff", "#3fb98f", "#a06bff", "#e0a33a", "#ff8a5c", "#c98bdb",
  "#6c9fb8", "#e5688a", "#5cc2a8", "#b7a13a", "#8a7dff", "#d9744f",
  "#3f9dc0", "#cc6b9a", "#7fae54", "#b06be0",
];

/** Latin stopwords dropped from the TF-IDF placeholder labels. */
const LABEL_STOPWORDS = new Set([
  "the", "and", "for", "you", "this", "that", "with", "are", "can", "how",
  "what", "why", "not", "但是", "现在", "这个", "如何", "还有", "一下", "一个",
  "使用", "怎么", "是否", "需要", "可以",
  // command / tool / control-echo noise that leaks into cleaned_text
  "x00", "cmd", "stdout", "stderr", "bash-input", "bash", "input", "modified",
  "requested", "attached", "null", "undefined", "please",
]);

export type ConversationSession = {
  key: string; // `${source}:${sessionId}` — unique across sources
  source: string;
  sessionId: string;
  eventTime: number; // Unix ms = MIN(event_at_utc), real conversation start
  text: string; // aggregated, scrubbed human text (embed input)
  msgCount: number;
  textSample: string;
};

export type ClusterModel = {
  centroids: Float32Array[]; // unit vectors
  labels: string[];
  clusterIds: number[];
  dim: number;
};

type AgentMessageRow = {
  source: string;
  source_session_id: string;
  event_at_utc: string;
  cleaned_text: string | null;
};

// ---------------------------------------------------------------------------
// Pure helpers (testable without a DB)
// ---------------------------------------------------------------------------

/** Injected boilerplate / non-user echoes that pollute topic clustering. */
export function isInjectedNoise(text: string): boolean {
  const t = text.trimStart();
  if (t.length === 0) return true;
  return (
    t.startsWith("(Re-invocation of /") ||
    t.startsWith("Base directory for this skill:") ||
    t.startsWith("# AGENTS.md instructions for") ||
    t.startsWith("Caveat: The messages below were generated") ||
    t.startsWith("Please analyze this codebase and create a CLAUDE.md") ||
    t.startsWith("Your tool call was malformed") ||
    t.includes('"type": "permission-mode"') ||
    t.includes('"permissionMode"') ||
    /^<command-(name|message|args|stdout)>/.test(t)
  );
}

/** Strip real home paths so nothing leaks into labels or payloads (public repo). */
export function scrubPaths(s: string): string {
  return (s ?? "").replace(/\/(Users|home)\/[^/\s]+/g, "/$1/*");
}

function l2normalize(v: Float32Array): Float32Array {
  let norm = 0;
  for (let i = 0; i < v.length; i++) norm += v[i]! * v[i]!;
  norm = Math.sqrt(norm) || 1;
  const u = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) u[i] = v[i]! / norm;
  return u;
}

function dot(a: Float32Array, b: Float32Array): number {
  let d = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) d += a[i]! * b[i]!;
  return d;
}

/**
 * Fixed-seed k-means over unit vectors (cosine == euclidean on the sphere).
 * k-means++ init + Lloyd iterations. Returns unit centroids + per-point cluster.
 */
export function kmeans(
  unitVecs: Float32Array[],
  k: number,
  seed: number
): { centroids: Float32Array[]; assign: number[] } {
  const n = unitVecs.length;
  const K = Math.max(1, Math.min(k, n));
  const D = unitVecs[0]!.length;
  let s = seed >>> 0;
  const rand = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);

  const centroids: Float32Array[] = [new Float32Array(unitVecs[Math.floor(rand() * n)]!)];
  const d2 = new Float64Array(n).fill(Infinity);
  while (centroids.length < K) {
    const c = centroids[centroids.length - 1]!;
    let sum = 0;
    for (let i = 0; i < n; i++) {
      const dist = 2 - 2 * dot(unitVecs[i]!, c); // ||u-v||^2 on unit vectors
      if (dist < d2[i]!) d2[i] = dist;
      sum += d2[i]!;
    }
    let r = rand() * sum;
    let pick = 0;
    for (let i = 0; i < n; i++) {
      r -= d2[i]!;
      if (r <= 0) { pick = i; break; }
    }
    centroids.push(new Float32Array(unitVecs[pick]!));
  }

  const assign = new Array<number>(n).fill(0);
  for (let iter = 0; iter < 30; iter++) {
    let moved = 0;
    for (let i = 0; i < n; i++) {
      let best = 0;
      let bestDot = -Infinity;
      for (let c = 0; c < K; c++) {
        const dv = dot(unitVecs[i]!, centroids[c]!);
        if (dv > bestDot) { bestDot = dv; best = c; }
      }
      if (assign[i] !== best) { assign[i] = best; moved++; }
    }
    const sums = Array.from({ length: K }, () => new Float64Array(D));
    const cnt = new Int32Array(K);
    for (let i = 0; i < n; i++) {
      const a = assign[i]!;
      cnt[a]++;
      const sv = sums[a]!;
      const v = unitVecs[i]!;
      for (let d = 0; d < D; d++) sv[d]! += v[d]!;
    }
    for (let c = 0; c < K; c++) {
      if (cnt[c] === 0) continue;
      const sv = sums[c]!;
      let norm = 0;
      for (let d = 0; d < D; d++) { sv[d]! /= cnt[c]!; norm += sv[d]! * sv[d]!; }
      norm = Math.sqrt(norm) || 1;
      const nc = centroids[c]!;
      for (let d = 0; d < D; d++) nc[d] = sv[d]! / norm;
    }
    if (moved === 0) break;
  }
  return { centroids, assign };
}

/** Nearest unit centroid + cosine distance (1 - dot) for a unit vector. */
export function nearestCentroid(
  unitVec: Float32Array,
  centroids: Float32Array[]
): { cluster: number; dist: number } {
  let best = -1;
  let bestDot = -Infinity;
  for (let c = 0; c < centroids.length; c++) {
    const dv = dot(unitVec, centroids[c]!);
    if (dv > bestDot) { bestDot = dv; best = c; }
  }
  return { cluster: best, dist: 1 - bestDot };
}

function tokenize(text: string): string[] {
  const out: string[] = [];
  const latin = text.toLowerCase().match(/[a-z][a-z0-9+.#_-]{2,}/g) ?? [];
  for (const t of latin) if (!LABEL_STOPWORDS.has(t)) out.push(t);
  return out;
}

/**
 * TF-IDF placeholder label per cluster (top distinctive latin terms). Real
 * naming is the LLM namer; this is the offline fallback (design step 4).
 */
export function tfidfLabels(clusterTexts: string[][]): string[] {
  const K = clusterTexts.length;
  const tfs: Map<string, number>[] = [];
  const df = new Map<string, number>();
  for (const texts of clusterTexts) {
    const tf = new Map<string, number>();
    for (const t of texts) for (const tok of tokenize(t)) tf.set(tok, (tf.get(tok) ?? 0) + 1);
    tfs.push(tf);
    for (const tok of tf.keys()) df.set(tok, (df.get(tok) ?? 0) + 1);
  }
  return tfs.map((tf, ci) => {
    const scored = [...tf.entries()]
      .map(([tok, f]) => [tok, f * Math.log(K / (df.get(tok) ?? 1))] as [string, number])
      .filter(([, sc]) => sc > 0)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    const top = scored.slice(0, 3).map(([tok]) => tok);
    return top.length > 0 ? top.join("·") : `主题${ci + 1}`;
  });
}

export type ClusterNamer = (clusterTexts: string[][]) => Promise<string[]> | string[];

// ---------------------------------------------------------------------------
// DB IO
// ---------------------------------------------------------------------------

/** Group human messages into per-session aggregated text + real start time. */
export function aggregateConversationSessions(db: Database.Database): ConversationSession[] {
  const rows = db
    .prepare(
      `SELECT source, source_session_id, event_at_utc, cleaned_text
         FROM agent_user_messages
        WHERE is_human = 1 AND source IN ('claude', 'codex', 'opencode')
        ORDER BY source, source_session_id, event_at_utc`
    )
    .all() as AgentMessageRow[];

  const groups = new Map<string, AgentMessageRow[]>();
  for (const r of rows) {
    const key = `${r.source}:${r.source_session_id}`;
    const g = groups.get(key);
    if (g) g.push(r);
    else groups.set(key, [r]);
  }

  const out: ConversationSession[] = [];
  for (const [key, group] of groups) {
    let minTime = Infinity;
    const kept: string[] = [];
    for (const r of group) {
      const ms = Date.parse(r.event_at_utc);
      if (Number.isFinite(ms)) minTime = Math.min(minTime, ms);
      const cleaned = (r.cleaned_text ?? "").trim();
      if (cleaned && !isInjectedNoise(cleaned)) {
        const scrubbed = stripControlTags(scrubPaths(cleaned)).trim();
        if (scrubbed) kept.push(scrubbed);
      }
    }
    if (kept.length === 0 || !Number.isFinite(minTime)) continue;
    const text = kept.join("\n").slice(0, CONVERSATION_MAX_TEXT);
    if (text.replace(/\s+/g, "").length < CONVERSATION_MIN_CHARS) continue;
    out.push({
      key,
      source: group[0]!.source,
      sessionId: group[0]!.source_session_id,
      eventTime: minTime,
      text,
      msgCount: kept.length,
      textSample: kept[0]!.replace(/\s+/g, " ").slice(0, 140),
    });
  }
  // Deterministic order → stable k-means input across rebuilds.
  out.sort((a, b) => a.key.localeCompare(b.key));
  return out;
}

/** Cache key: any change to prep or embedding model invalidates cached vectors. */
export function embedKey(cfg: RagConfigV1 | null): string {
  return `${CONVERSATION_PREP_VERSION}|${cfg?.embedding?.model ?? "none"}`;
}

function loadCachedVectors(
  db: Database.Database,
  ek: string
): Map<string, { vector: Float32Array; dim: number }> {
  const rows = db
    .prepare(
      `SELECT source, session_id, vector, dim FROM topic_conversation_vectors WHERE embed_key = ?`
    )
    .all(ek) as { source: string; session_id: string; vector: Buffer; dim: number }[];
  const map = new Map<string, { vector: Float32Array; dim: number }>();
  for (const r of rows) {
    map.set(`${r.source}:${r.session_id}`, {
      vector: l2normalize(blobToFloat32(r.vector)),
      dim: r.dim,
    });
  }
  return map;
}

/** Text → vectors. Real one wraps rag's fetchEmbeddingsBatch; tests inject a fake. */
export type Embedder = (texts: string[]) => Promise<EmbeddingResult[]>;

/**
 * Return unit vectors for every session that has one, embedding + caching any
 * that are missing. Sessions stay unembedded (absent from the map) only when
 * no embedder is available.
 */
export async function embedAndCacheMissing(
  db: Database.Database,
  sessions: ConversationSession[],
  embedder: Embedder | null,
  ek: string
): Promise<Map<string, { vector: Float32Array; dim: number }>> {
  const cached = loadCachedVectors(db, ek);
  const missing = sessions.filter((s) => !cached.has(s.key));
  if (missing.length === 0 || !embedder) return cached; // nothing to do / no embedder

  const results = await embedder(missing.map((s) => s.text));
  const updatedAt = nowIso();
  const insert = db.prepare(
    `INSERT INTO topic_conversation_vectors
       (source, session_id, event_time, msg_count, text_sample, vector, dim, embed_key, updated_at)
     VALUES (@source, @session_id, @event_time, @msg_count, @text_sample, @vector, @dim, @embed_key, @updated_at)
     ON CONFLICT(source, session_id) DO UPDATE SET
       event_time=excluded.event_time, msg_count=excluded.msg_count,
       text_sample=excluded.text_sample, vector=excluded.vector, dim=excluded.dim,
       embed_key=excluded.embed_key, updated_at=excluded.updated_at`
  );
  const writeAll = db.transaction(() => {
    for (let i = 0; i < missing.length; i++) {
      const s = missing[i]!;
      const res = results[i]!;
      insert.run({
        source: s.source,
        session_id: s.sessionId,
        event_time: s.eventTime,
        msg_count: s.msgCount,
        text_sample: s.textSample,
        vector: float32ToBlob(res.vector),
        dim: res.dim,
        embed_key: ek,
        updated_at: updatedAt,
      });
      cached.set(s.key, { vector: l2normalize(res.vector), dim: res.dim });
    }
  });
  writeAll();
  return cached;
}

export function loadCodebook(db: Database.Database, ruleVersion: string): ClusterModel | null {
  const rows = db
    .prepare(
      `SELECT cluster_id, centroid, dim, label FROM topic_codebook
        WHERE rule_version = ? ORDER BY cluster_id`
    )
    .all(ruleVersion) as { cluster_id: number; centroid: Buffer; dim: number; label: string }[];
  if (rows.length === 0) return null;
  return {
    centroids: rows.map((r) => l2normalize(blobToFloat32(r.centroid))),
    labels: rows.map((r) => r.label),
    clusterIds: rows.map((r) => r.cluster_id),
    dim: rows[0]!.dim,
  };
}

function persistCodebook(
  db: Database.Database,
  ruleVersion: string,
  model: ClusterModel,
  sizes: number[],
  updatedAt: string
): void {
  const write = db.transaction(() => {
    db.prepare(`DELETE FROM topic_codebook WHERE rule_version = ?`).run(ruleVersion);
    const insert = db.prepare(
      `INSERT INTO topic_codebook (rule_version, cluster_id, centroid, dim, label, member_count, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    for (let c = 0; c < model.centroids.length; c++) {
      insert.run(
        ruleVersion,
        model.clusterIds[c],
        float32ToBlob(model.centroids[c]!),
        model.dim,
        model.labels[c],
        sizes[c] ?? 0,
        updatedAt
      );
    }
  });
  write();
}

/** Legend (name→color) for the conversation source; color keyed by frozen cluster_id. */
export function conversationLegend(db: Database.Database): { name: string; color: string }[] {
  const rows = db
    .prepare(
      `SELECT cluster_id, label FROM topic_codebook WHERE rule_version = ? ORDER BY cluster_id`
    )
    .all(CONVERSATION_RULE_VERSION) as { cluster_id: number; label: string }[];
  const seen = new Set<string>();
  const out: { name: string; color: string }[] = [];
  for (const r of rows) {
    if (seen.has(r.label)) continue;
    seen.add(r.label);
    out.push({ name: r.label, color: CONVERSATION_PALETTE[r.cluster_id % CONVERSATION_PALETTE.length]! });
  }
  out.push({ name: OTHER_CATEGORY, color: OTHER_COLOR });
  return out;
}

function buildConversationEvents(
  sessions: ConversationSession[],
  vectors: Map<string, { vector: Float32Array; dim: number }>,
  model: ClusterModel
): { events: TopicStreamEvent[]; diagnostic: TopicRebuildDiagnostic; unembedded: number } {
  const events: TopicStreamEvent[] = [];
  const categoryCounts: Record<string, number> = {};
  let unembedded = 0;
  for (const s of sessions) {
    const v = vectors.get(s.key);
    if (!v) { unembedded += 1; continue; }
    const { cluster, dist } = nearestCentroid(v.vector, model.centroids);
    const category = cluster < 0 || dist > CONVERSATION_TAU ? OTHER_CATEGORY : model.labels[cluster]!;
    categoryCounts[category] = (categoryCounts[category] ?? 0) + 1;
    events.push({
      sourceRef: s.key,
      sessionId: s.key,
      category,
      calendarDay: localDayFromIso(new Date(s.eventTime).toISOString()),
      eventTime: s.eventTime,
      payload: {
        title: s.textSample,
        host: category,
        url: null,
        chat_source: s.source,
        session_id: s.key,
        msg_count: s.msgCount,
        text_sample: s.textSample,
      },
    });
  }
  const totalKept = events.length;
  const otherShare = totalKept > 0 ? (categoryCounts[OTHER_CATEGORY] ?? 0) / totalKept : 0;
  return {
    events,
    unembedded,
    diagnostic: {
      total_source: sessions.length,
      total_kept: totalKept,
      filtered_non_web: unembedded,
      filtered_transition: {},
      category_counts: categoryCounts,
      other_share: otherShare,
      top_unmatched_domains: [],
    },
  };
}

export type RebuildConversationOptions = {
  /** Re-derive the codebook (bump / first build). Otherwise assign to frozen centroids. */
  recluster?: boolean;
  /** Override rag config (tests). Defaults to readRagConfig(). */
  cfg?: RagConfigV1 | null;
  /** Override the embedder (tests). Defaults to rag's HTTP embedder when cfg enables it. */
  embedder?: Embedder;
  /** Override the cluster namer (LLM). Defaults to the offline TF-IDF namer. */
  namer?: ClusterNamer;
  /** Min eligible sessions before building (tests use a small floor). */
  coldFloor?: number;
  /** Cluster count (tests use a small K). Defaults to CONVERSATION_K. */
  k?: number;
};

/**
 * Rebuild the conversation topic stream. Aggregate cleaned human messages →
 * embed (cached) → build-or-load the frozen codebook → assign each session to
 * its nearest centroid (τ overflow → 其他) → persist. Idempotent given a frozen
 * codebook: same sessions + same centroids ⇒ same bands.
 */
export async function rebuildConversationTopicStream(
  db: Database.Database,
  opts: RebuildConversationOptions = {}
): Promise<RebuildTopicStreamResult> {
  const started = Date.now();
  const updatedAt = nowIso();
  const source = CONVERSATION_SOURCE;
  const profile = CONVERSATION_PROFILE;
  const ruleVersion = CONVERSATION_RULE_VERSION;

  const failState = (error: string): RebuildTopicStreamResult => {
    let derived = 0;
    try { derived = derivedCount(db, source, profile); } catch { derived = 0; }
    upsertState(db, source, profile, {
      ruleVersion, rebuiltAt: null, error,
      sourceCount: 0, derivedCount: derived,
      durationMs: Date.now() - started, updatedAt: nowIso(),
    });
    return {
      source, profile, ruleVersion, sourceCount: 0, derivedCount: derived,
      durationMs: Date.now() - started, ok: false, error, diagnostic: null,
    };
  };

  try {
    const coldFloor = opts.coldFloor ?? CONVERSATION_COLD_FLOOR;
    const k = opts.k ?? CONVERSATION_K;
    const sessions = aggregateConversationSessions(db);
    if (sessions.length < coldFloor) {
      return failState(`cold_start: ${sessions.length} < ${coldFloor} sessions`);
    }

    const cfg = opts.cfg !== undefined ? opts.cfg : readRagConfig();
    const ek = embedKey(cfg);
    const embedder: Embedder | null =
      opts.embedder ?? (cfg?.embedding?.enabled ? (texts) => fetchEmbeddingsBatch(texts, cfg) : null);
    const vectors = await embedAndCacheMissing(db, sessions, embedder, ek);
    const embedded = sessions.filter((s) => vectors.has(s.key));
    if (embedded.length < coldFloor) {
      return failState(
        `no_vectors: ${embedded.length}/${sessions.length} embedded (embedding not configured?)`
      );
    }

    let model = opts.recluster ? null : loadCodebook(db, ruleVersion);
    if (!model) {
      const unitVecs = embedded.map((s) => vectors.get(s.key)!.vector);
      const { centroids, assign } = kmeans(unitVecs, k, CONVERSATION_KMEANS_SEED);
      const clusterTexts: string[][] = centroids.map(() => []);
      const sizes = new Array<number>(centroids.length).fill(0);
      for (let i = 0; i < embedded.length; i++) {
        clusterTexts[assign[i]!]!.push(embedded[i]!.text);
        sizes[assign[i]!]! += 1;
      }
      const namer = opts.namer ?? tfidfLabels;
      const labels = await namer(clusterTexts);
      model = {
        centroids,
        labels: labels.map((l, i) => l || `主题${i + 1}`),
        clusterIds: centroids.map((_, i) => i),
        dim: centroids[0]!.length,
      };
      persistCodebook(db, ruleVersion, model, sizes, updatedAt);
    }

    const built = buildConversationEvents(sessions, vectors, model);
    const derived = persistTopicStream(db, {
      source, profile, ruleVersion,
      events: built.events, sourceCount: sessions.length, started, updatedAt,
    });
    return {
      source, profile, ruleVersion,
      sourceCount: sessions.length, derivedCount: derived,
      durationMs: Date.now() - started, ok: true, error: null,
      diagnostic: built.diagnostic,
    };
  } catch (e) {
    return failState(e instanceof Error ? e.message : String(e));
  }
}
