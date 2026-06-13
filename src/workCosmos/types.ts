/**
 * Activity Cosmos `/dashboard/cosmos` 的派生索引类型。
 *
 * 设计文档：
 *   ~/.gstack/projects/xunull-ai2nao/you-main-design-20260612-193633-activity-cosmos.md
 * Eng review 报告即设计文档末尾 `## GSTACK REVIEW REPORT`。
 *
 * 数据从两张已有 token usage 表（`claude_session_token_usage` /
 * `codex_session_token_usage`）拉 session_id + project_key，加上从 jsonl 抽
 * 出来的 session-level summary 做 embedding，再 UMAP 投到 2D 画散点。
 *
 * 关键 schema 决策（D3）：
 *   summary 在 `work_cosmos_embeddings` 里，**不**在 points 表。这样 API
 *   只会返回 points 行，session 文本不会无意中进 JSON payload。
 *
 * rule_version：每次改变"什么参与 embedding / 投影"的语义都要 bump。
 * 第一次 ship 是 v1。
 */

export const COSMOS_RULE_VERSION = 1;

/** 当前能进 cosmos 的 source —— Phase 2 会加 cursor / cherry / llm-chat。 */
export type CosmosSource = "claude" | "codex";

/** 每个 source × session 是否进入 cosmos / 失败原因（per D2 / Day 1 fallback）。 */
export type CosmosTokenStatus = "full" | "unknown" | "error";

/**
 * embedding pipeline 单 session 状态：
 *  - `ok`             —— 成功生成 vector
 *  - `pending`        —— 还没 embed（首次插入时）
 *  - `no_summary`     —— session 没 user/assistant 文本可摘要（skip）
 *  - `rate_limited`   —— provider 返 429（下次 refresh 自动重试）
 *  - `auth_failed`    —— provider 返 401/403（用户要去改 rag.json）
 *  - `provider_error` —— 其它 5xx / 网络错（下次自动重试）
 */
export type CosmosEmbeddingStatus =
  | "ok"
  | "pending"
  | "no_summary"
  | "rate_limited"
  | "auth_failed"
  | "provider_error";

/**
 * `work_cosmos_points` 行。**不含** summary 文本（per D3 default-safe schema）。
 * x/y 在 Day 1 写入时为 null，Day 2 projection 步骤填上。
 */
export type CosmosPointRow = {
  session_id: string;
  source: CosmosSource;
  /** session 源文件路径，跟 token_usage 表的 file_path / rollout_path 一致。 */
  source_path: string;
  /** Day 2: D2 三元组增量 skip 判据之一。 */
  source_mtime_ms: number;
  source_size_bytes: number;
  /** 跨 source 对齐的 normalized 项目 key / 显示路径（同 token usage 表语义）。 */
  project_key: string;
  project_path: string;
  /** session 总 token；用于散点 size 映射（NULL = 缺数据）。 */
  total_tokens: number;
  /** UMAP 投影后的二维坐标；refresh 完 embedding 但还没 projection 时为 null。 */
  x: number | null;
  y: number | null;
  /** Phase 2 才填，MVP NULL。 */
  cluster_id: string | null;
  token_status: CosmosTokenStatus;
  embedding_status: CosmosEmbeddingStatus;
  /** 跟 token_usage 一致：source 文件本轮 refresh 没出现 → 标 missing。 */
  missing_since: string | null;
  source_seen_at: string;
  updated_at: string;
};

/**
 * `work_cosmos_embeddings` 行（sidecar）。summary 文本与 vector BLOB 在一起，
 * 这张表**永远不进 API 输出**。
 */
export type CosmosEmbeddingRow = {
  session_id: string;
  /** embedding provider 报出来的维度（DashScope text-embedding-v4 默认 1024）。 */
  embedding_dim: number;
  /** Float32Array.buffer 的 byte view（dim * 4 bytes）。 */
  vector: Buffer;
  /** session-level summary 文本（首条 user + 最后一条 assistant 拼接，≤2K 字符）。 */
  summary: string;
  updated_at: string;
};

/** state 表单例行——每次 refresh 重写。 */
export type CosmosStateRow = {
  id: number;
  rule_version: number;
  last_rebuilt_at: string | null;
  last_error: string | null;
  source_session_count: number;
  indexed_session_count: number;
  embedded_session_count: number;
  no_summary_session_count: number;
  error_session_count: number;
  skipped_unchanged_count: number;
  projection_method: "umap" | "pca" | "none";
  projected_session_count: number;
  duration_ms: number | null;
  updated_at: string;
};

/** refresh 入口返回。 */
export type CosmosRefreshResult = {
  ok: boolean;
  status: "success" | "partial" | "failed";
  sourceSessionCount: number;
  indexedSessionCount: number;
  embeddedSessionCount: number;
  noSummarySessionCount: number;
  errorSessionCount: number;
  skippedUnchangedCount: number;
  missingMarkedCount: number;
  projectionMethod: "umap" | "pca" | "none";
  projectedSessionCount: number;
  durationMs: number;
  errors: string[];
};

/** API DTO —— 给 `/dashboard/cosmos` 页面用。绝不含 summary。 */
export type CosmosPointDTO = {
  sessionId: string;
  source: CosmosSource;
  projectKey: string;
  projectPath: string;
  totalTokens: number;
  x: number;
  y: number;
  /** Phase 2 cluster_id，MVP 永远 null。 */
  clusterId: string | null;
};

export type CosmosPointsResponse = {
  ok: true;
  generatedAt: string;
  pointCount: number;
  projectionMethod: "umap" | "pca" | "none";
  embeddingModel: string | null;
  points: CosmosPointDTO[];
};

/** GET /api/work-cosmos/refresh-status —— 前端 1s 轮询进度。 */
export type CosmosRefreshPhase =
  | "idle"
  | "scanning"
  | "embedding"
  | "projecting"
  | "done"
  | "failed";

export type CosmosRefreshStatus = {
  phase: CosmosRefreshPhase;
  indexedCount: number;
  totalCount: number;
  embeddedCount: number;
  startedAt: string | null;
  finishedAt: string | null;
  lastError: string | null;
};
