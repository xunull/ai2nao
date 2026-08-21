import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { RefreshCw } from "lucide-react";
import type { ColumnDef } from "@tanstack/react-table";
import { apiGet } from "../api";
import { Page } from "../components/Page";
import { DataTable } from "../components/DataTable";
import { formatFileTimeMs } from "../util/formatDisplay";

/**
 * kimi 会话列表。
 *
 * 与另外三家的历史页对齐,但后端薄得多 —— kimi 的数据已在 index.db 里
 * (V55 的 token 索引 + agent_user_messages 的正文),不需要解析层。
 *
 * 「问了 N 次」数的是**真人提问**,不是消息总数。真库里 kimi 的消息 92% 是
 * AI 正文,数全部会显示成「303 条」这种比实际互动量大一个量级的数字。
 */

type KimiSession = {
  sessionId: string;
  title: string | null;
  projectKey: string;
  projectPath: string;
  identityConfidence: "high" | "low";
  model: string | null;
  createdAt: string;
  lastUpdatedAt: string;
  agentCount: number;
  humanMessageCount: number;
  totalMessageCount: number;
  preview: string;
};

type KimiSessionsResponse = {
  ok: true;
  sessions: KimiSession[];
  diagnostics: { kind: string; message: string; count?: number }[];
};

function parseTime(value: string): number {
  const t = new Date(value).getTime();
  return Number.isFinite(t) ? t : 0;
}

export default function KimiHistory() {
  const queryClient = useQueryClient();
  const [query, setQuery] = useState("");

  const list = useQuery({
    queryKey: ["kimi-history-sessions"],
    queryFn: () => apiGet<KimiSessionsResponse>("/api/kimi-history/sessions"),
  });

  const sessions = list.data?.sessions ?? [];
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return sessions;
    return sessions.filter((s) =>
      `${s.title ?? ""} ${s.projectPath} ${s.preview}`.toLowerCase().includes(q)
    );
  }, [sessions, query]);

  const columns = useMemo<ColumnDef<KimiSession>[]>(
    () => [
      {
        accessorKey: "title",
        header: "会话",
        cell: ({ row }) => {
          const s = row.original;
          return (
            <Link
              to={`/kimi-history/s/${encodeURIComponent(s.sessionId)}`}
              className="block min-w-0"
            >
              <div className="truncate font-medium text-neutral-900 hover:text-blue-700">
                {s.title?.trim() || "无标题会话"}
              </div>
              <div className="mt-0.5 truncate text-xs text-neutral-500">{s.preview}</div>
            </Link>
          );
        },
      },
      {
        accessorKey: "projectPath",
        header: "项目",
        cell: ({ row }) => (
          <span
            className="block truncate font-mono text-[11px] text-neutral-600"
            title={row.original.projectPath}
          >
            {row.original.projectPath.split("/").slice(-2).join("/")}
          </span>
        ),
      },
      {
        accessorKey: "agentCount",
        header: "agent",
        meta: { align: "right", headerTitle: "这场会话下有几个 agents/<x>/wire.jsonl" },
        cell: ({ row }) => <span className="tabular-nums">{row.original.agentCount}</span>,
      },
      {
        accessorKey: "humanMessageCount",
        header: "提问",
        meta: {
          align: "right",
          headerTitle: "真人提问条数（不含 AI 正文与工具输出）",
        },
        cell: ({ row }) => (
          <span className="tabular-nums">{row.original.humanMessageCount}</span>
        ),
      },
      {
        accessorKey: "lastUpdatedAt",
        header: "更新时间",
        meta: { align: "right" },
        cell: ({ row }) => (
          <span className="whitespace-nowrap text-xs text-neutral-500">
            {formatFileTimeMs(parseTime(row.original.lastUpdatedAt))}
          </span>
        ),
      },
    ],
    []
  );

  return (
    <Page
      title="Kimi 会话"
      subtitle="本机 kimi 的会话记录。「提问」数的是真人发言，不含 AI 正文。"
      fill
      actions={
        <button
          type="button"
          onClick={() => void queryClient.invalidateQueries({ queryKey: ["kimi-history-sessions"] })}
          className="inline-flex h-9 items-center gap-2 rounded-lg border border-neutral-200 bg-white px-3 text-sm font-medium text-neutral-800 shadow-sm transition hover:border-blue-200 hover:bg-slate-50"
        >
          <RefreshCw className="h-4 w-4" aria-hidden="true" />
          刷新
        </button>
      }
      toolbar={
        <label className="block w-72">
          <span className="mb-1 block text-xs font-medium text-[var(--muted)]">搜索</span>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="标题、项目或首句"
            className="h-9 w-full rounded-lg border border-neutral-200 bg-white px-3 text-sm"
          />
        </label>
      }
    >
      {list.isError && (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          {(list.error as Error).message}
        </div>
      )}
      {(list.data?.diagnostics ?? []).length > 0 && (
        <ul className="mb-3 space-y-1 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-900">
          {list.data!.diagnostics.map((d) => (
            <li key={d.kind}>{d.message}</li>
          ))}
        </ul>
      )}
      <DataTable
        columns={columns}
        data={filtered}
        title={`${filtered.length} 场会话`}
        emptyText={
          sessions.length === 0
            ? "还没有 kimi 会话。若刚装上 kimi，等一次 kimi.tokens.refresh 后再来。"
            : "没有匹配的会话。"
        }
        clientSort
        hidePager
        fillHeight
      />
    </Page>
  );
}
