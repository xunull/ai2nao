/**
 * DTO 转换 + sanitize gate。
 *
 * 这层是 API 边界——任何字段在这里被显式选中才会出现在客户端 payload 里。
 * 默认排除一切：summary 文本（已经因为 schema D3 决策不在 points 表里）、
 * source_path（暴露文件系统结构）、source_mtime_ms / size（实现细节）、
 * source_seen_at / updated_at（内部 timestamps）。
 *
 * sanitize gate 单测验的就是：输入一个含 summary 的合成 row（即使技术上
 * 不应该出现），输出的 JSON 字符串里也找不到 summary 子串。
 */
import type {
  CosmosPointDTO,
  CosmosPointRow,
  CosmosPointsResponse,
} from "./types.js";

type ApiSafePointRow = Omit<
  CosmosPointRow,
  "source_path" | "source_mtime_ms" | "source_size_bytes"
>;

export function rowToDto(row: ApiSafePointRow): CosmosPointDTO {
  // explicit field-by-field copy — refuses to pass through unknown columns.
  // x and y are guaranteed non-null by the WHERE clause in listCosmosPointsForApi.
  return {
    sessionId: row.session_id,
    source: row.source,
    projectKey: row.project_key,
    projectPath: row.project_path,
    totalTokens: row.total_tokens,
    x: row.x!,
    y: row.y!,
    clusterId: row.cluster_id,
  };
}

export function toPointsResponse(args: {
  rows: ApiSafePointRow[];
  projectionMethod: "umap" | "pca" | "none";
  embeddingModel: string | null;
}): CosmosPointsResponse {
  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    pointCount: args.rows.length,
    projectionMethod: args.projectionMethod,
    embeddingModel: args.embeddingModel,
    points: args.rows.map(rowToDto),
  };
}
