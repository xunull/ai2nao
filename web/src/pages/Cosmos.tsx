/**
 * /dashboard/cosmos —— Activity Cosmos.
 *
 * 把所有本地 AI session（Claude + Codex）的语义嵌入到 2D 空间，画成散点。
 * 颜色 = source（Claude 蓝 / Codex 橙），大小 = log(token 数)。
 *
 * P4 截屏即终产物：固定纵横比 + 清晰图例 + 标题，PNG 一键导出（D2-5 实现）。
 *
 * 永远不含 session 内容文本——sanitize gate 在后端 `json.ts` + 前端永远不
 * 渲染 summary 字段（它根本不在 API payload 里）。
 */
import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
  ZAxis,
} from "recharts";
import { Sparkles, RefreshCw, Camera } from "lucide-react";
import { apiGet, apiPost } from "../api";
import { exportElementToPng } from "../util/exportPng";

type CosmosSource = "claude" | "codex";

type CosmosPointDTO = {
  sessionId: string;
  source: CosmosSource;
  projectKey: string;
  projectPath: string;
  totalTokens: number;
  x: number;
  y: number;
  clusterId: string | null;
};

type CosmosPointsResponse = {
  ok: true;
  generatedAt: string;
  pointCount: number;
  projectionMethod: "umap" | "pca" | "none";
  embeddingModel: string | null;
  points: CosmosPointDTO[];
};

type CosmosRefreshStatus = {
  phase: "idle" | "scanning" | "embedding" | "projecting" | "done" | "failed";
  indexedCount: number;
  totalCount: number;
  embeddedCount: number;
  startedAt: string | null;
  finishedAt: string | null;
  lastError: string | null;
};

const SOURCE_COLOR: Record<CosmosSource, string> = {
  claude: "#6366f1", // indigo-500
  codex: "#f59e0b", // amber-500
};

const SOURCE_LABEL: Record<CosmosSource, string> = {
  claude: "Claude Code",
  codex: "Codex",
};

function fetchPoints() {
  return apiGet<CosmosPointsResponse>("/api/work-cosmos/points");
}

function fetchStatus() {
  return apiGet<CosmosRefreshStatus>("/api/work-cosmos/refresh-status");
}

function postRefresh() {
  return apiPost<{ ok: boolean }>("/api/work-cosmos/refresh", {});
}

function tokenSize(tokens: number): number {
  // ScatterChart wants a "z" scalar; map log10(tokens) into a visible range.
  if (tokens <= 0) return 60;
  const v = Math.log10(tokens + 1);
  return 60 + v * 80;
}

function pointsBySource(points: CosmosPointDTO[]): Record<CosmosSource, CosmosPointDTO[]> {
  return {
    claude: points.filter((p) => p.source === "claude"),
    codex: points.filter((p) => p.source === "codex"),
  };
}

export function Cosmos() {
  const chartRef = useRef<HTMLDivElement>(null);
  const [polling, setPolling] = useState(false);

  const pointsQuery = useQuery({
    queryKey: ["work-cosmos", "points"],
    queryFn: fetchPoints,
    refetchOnWindowFocus: false,
  });

  const statusQuery = useQuery({
    queryKey: ["work-cosmos", "refresh-status"],
    queryFn: fetchStatus,
    refetchOnWindowFocus: false,
    refetchInterval: polling ? 1000 : false,
  });

  // when polling detects 'done' or 'failed', stop polling and refetch points
  useEffect(() => {
    const s = statusQuery.data;
    if (!polling || !s) return;
    if (s.phase === "done" || s.phase === "failed") {
      setPolling(false);
      pointsQuery.refetch();
    }
  }, [polling, statusQuery.data, pointsQuery]);

  async function handleRefresh() {
    try {
      await postRefresh();
      setPolling(true);
      statusQuery.refetch();
    } catch (e) {
      console.error("cosmos refresh failed", e);
    }
  }

  async function handleExport() {
    const target = chartRef.current;
    if (!target) return;
    const filename = `cosmos-${new Date().toISOString().slice(0, 10)}.png`;
    await exportElementToPng(target, filename);
  }

  const points = pointsQuery.data?.points ?? [];
  const grouped = pointsBySource(points);
  const status = statusQuery.data;
  const isWorking =
    polling &&
    status &&
    status.phase !== "idle" &&
    status.phase !== "done" &&
    status.phase !== "failed";

  const phaseLabel: Record<CosmosRefreshStatus["phase"], string> = {
    idle: "空闲",
    scanning: "扫描 session",
    embedding: "调用 embedding",
    projecting: "降维投影",
    done: "完成",
    failed: "失败",
  };

  return (
    <div className="min-h-screen bg-slate-50 px-6 py-6">
      <div className="mx-auto max-w-[1400px]">
        <header className="mb-6 flex items-center justify-between">
          <div>
            <h1 className="flex items-center gap-2 text-2xl font-semibold text-slate-900">
              <Sparkles className="h-6 w-6 text-indigo-500" />
              对话宇宙
            </h1>
            <p className="mt-1 text-sm text-slate-500">
              本地 {pointsQuery.data?.pointCount ?? 0} 个 AI session 的语义地图。
              embedding {pointsQuery.data?.embeddingModel ?? "—"} · 投影{" "}
              {pointsQuery.data?.projectionMethod ?? "none"}
            </p>
          </div>
          <div className="flex gap-2">
            <button
              onClick={handleRefresh}
              disabled={isWorking}
              className="inline-flex items-center gap-2 rounded border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 shadow-sm transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60"
            >
              <RefreshCw
                className={`h-4 w-4 ${isWorking ? "animate-spin" : ""}`}
              />
              刷新
            </button>
            <button
              onClick={handleExport}
              disabled={points.length === 0}
              className="inline-flex items-center gap-2 rounded border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 shadow-sm transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60"
            >
              <Camera className="h-4 w-4" />
              导出 PNG
            </button>
          </div>
        </header>

        {isWorking && status && (
          <div className="mb-4 rounded border border-indigo-200 bg-indigo-50 px-3 py-2 text-sm text-indigo-800">
            {phaseLabel[status.phase]}
            {status.totalCount > 0 && (
              <span className="ml-2 font-mono">
                {status.indexedCount}/{status.totalCount}
                {status.phase === "embedding" &&
                  ` · embedded ${status.embeddedCount}`}
              </span>
            )}
          </div>
        )}

        {status?.phase === "failed" && status.lastError && (
          <div className="mb-4 rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
            刷新失败：{status.lastError}
          </div>
        )}

        <div
          ref={chartRef}
          className="rounded-lg border border-slate-200 bg-white p-6 shadow-sm"
          style={{ aspectRatio: "16 / 9" }}
        >
          {points.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center text-center text-slate-400">
              <Sparkles className="h-12 w-12 text-slate-300" />
              <p className="mt-3 text-sm">
                还没有 AI 对话被索引。点右上"刷新"开始构建语义地图。
              </p>
            </div>
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <ScatterChart margin={{ top: 20, right: 20, bottom: 40, left: 20 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                <XAxis
                  type="number"
                  dataKey="x"
                  name="x"
                  tick={false}
                  axisLine={{ stroke: "#cbd5e1" }}
                />
                <YAxis
                  type="number"
                  dataKey="y"
                  name="y"
                  tick={false}
                  axisLine={{ stroke: "#cbd5e1" }}
                />
                <ZAxis type="number" dataKey="z" range={[60, 400]} />
                <Tooltip
                  cursor={{ strokeDasharray: "3 3" }}
                  content={({ active, payload }) => {
                    if (!active || !payload || payload.length === 0) return null;
                    const p = payload[0]?.payload as
                      | (CosmosPointDTO & { z: number })
                      | undefined;
                    if (!p) return null;
                    return (
                      <div className="rounded border border-slate-200 bg-white px-3 py-2 text-xs shadow-md">
                        <div className="font-semibold text-slate-800">
                          {SOURCE_LABEL[p.source]}
                        </div>
                        <div className="mt-1 max-w-xs truncate text-slate-600">
                          {p.projectPath}
                        </div>
                        <div className="mt-1 font-mono text-slate-500">
                          {p.totalTokens.toLocaleString()} tokens
                        </div>
                      </div>
                    );
                  }}
                />
                <Legend
                  iconType="circle"
                  wrapperStyle={{ paddingTop: 16 }}
                  formatter={(value: string) => (
                    <span className="text-sm text-slate-600">{value}</span>
                  )}
                />
                {(Object.keys(grouped) as CosmosSource[]).map((src) => (
                  <Scatter
                    key={src}
                    name={SOURCE_LABEL[src]}
                    data={grouped[src].map((p) => ({
                      ...p,
                      z: tokenSize(p.totalTokens),
                    }))}
                    fill={SOURCE_COLOR[src]}
                    fillOpacity={0.7}
                  />
                ))}
              </ScatterChart>
            </ResponsiveContainer>
          )}
        </div>

        <footer className="mt-4 text-center text-xs text-slate-400">
          embeddings via {pointsQuery.data?.embeddingModel ?? "DashScope"} ·
          生成于{" "}
          {pointsQuery.data?.generatedAt
            ? new Date(pointsQuery.data.generatedAt).toLocaleString()
            : "—"}
        </footer>
      </div>
    </div>
  );
}
