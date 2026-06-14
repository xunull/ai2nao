/**
 * Cosmos service layer：组装给前端的响应 DTO。
 *
 * 这层做两件事：
 *   1) 调 queries 拿原始 row
 *   2) 调 json 把内部 row 转成 API DTO（沿途 sanitize 掉 summary / 内部
 *      字段）
 *
 * 不直接访问 work_cosmos_embeddings 表 —— 那是 refresh.ts / project.ts
 * 的专属责任域，避免任何 API path 意外读到 summary 文本。
 */
import type Database from "better-sqlite3";
import { readRagConfig } from "../rag/config.js";
import { listCosmosPointsForApi, getCosmosState } from "./queries.js";
import { toPointsResponse } from "./json.js";
import type { CosmosPointsResponse, CosmosRefreshStatus } from "./types.js";
import { getCosmosProgress } from "./progress.js";

export function buildCosmosPointsResponse(
  db: Database.Database
): CosmosPointsResponse {
  const rows = listCosmosPointsForApi(db);
  const state = getCosmosState(db);
  const cfg = readRagConfig();
  return toPointsResponse({
    rows,
    projectionMethod: state?.projection_method ?? "none",
    embeddingModel: cfg?.embedding?.model ?? null,
  });
}

export function buildCosmosRefreshStatus(): CosmosRefreshStatus {
  return getCosmosProgress();
}
