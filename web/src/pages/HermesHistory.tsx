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
 * hermes 会话列表。
 *
 * 与另外六家历史页对齐,但多一个**来源筛选**,因为 hermes 的数据形状跟它们都不一样:
 * 真库 120 场里 94 场是 cron 定时任务自己跑的,只有 26 场是人发起的(cli 15 + 飞书 11)。
 * 不筛的话首屏全是机器日志,自己聊的那几场翻不到 —— 所以**默认只看人发起的**。
 *
 * 「标题」有 25 场是兜底来的(20 场源库为空 + 5 场存了模型的 `<think>` 原文),
 * 兜底的标灰,免得看起来像是 hermes 真的这么起名的。
 */

type HermesOrigin = "cron" | "cli" | "feishu" | "other";

type HermesSession = {
  id: string;
  sourceRaw: string;
  origin: HermesOrigin;
  title: string;
  titleFallback: boolean;
  model: string | null;
  startedAtIso: string | null;
  endedAtIso: string | null;
  endReason: string | null;
  messageCount: number;
  toolCallCount: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
};

type HermesSessionsResponse = {
  hermesHome: string;
  dbPath: string;
  sessions: HermesSession[];
  diagnostic?: { kind: string; message: string; path?: string };
};

const ORIGIN_LABEL: Record<HermesOrigin, string> = {
  cli: "命令行",
  feishu: "飞书",
  cron: "定时任务",
  other: "其他",
};

function parseTime(value: string | null): number {
  if (!value) return 0;
  const t = new Date(value).getTime();
  return Number.isFinite(t) ? t : 0;
}

type Scope = "human" | "cron" | "all";

const SCOPES: { key: Scope; label: string; hint: string }[] = [
  { key: "human", label: "我发起的", hint: "命令行 + 飞书" },
  { key: "cron", label: "定时任务", hint: "cron 自己跑的" },
  { key: "all", label: "全部", hint: "两者都看" },
];

export default function HermesHistory() {
  const queryClient = useQueryClient();
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<Scope>("human");

  const list = useQuery({
    queryKey: ["hermes-history-sessions"],
    queryFn: () => apiGet<HermesSessionsResponse>("/api/hermes-history/sessions"),
  });

  const sessions = list.data?.sessions ?? [];

  const counts = useMemo(() => {
    let human = 0;
    let cron = 0;
    for (const s of sessions) {
      if (s.origin === "cron") cron++;
      else human++;
    }
    return { human, cron, all: sessions.length };
  }, [sessions]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return sessions.filter((s) => {
      if (scope === "human" && s.origin === "cron") return false;
      if (scope === "cron" && s.origin !== "cron") return false;
      if (!q) return true;
      return `${s.title} ${s.model ?? ""} ${s.sourceRaw}`.toLowerCase().includes(q);
    });
  }, [sessions, query, scope]);

  const columns = useMemo<ColumnDef<HermesSession>[]>(
    () => [
      {
        accessorKey: "title",
        header: "会话",
        cell: ({ row }) => {
          const s = row.original;
          return (
            <Link to={`/hermes-history/s/${encodeURIComponent(s.id)}`} className="block min-w-0">
              <div
                className={`truncate font-medium hover:text-blue-700 ${
                  s.titleFallback ? "italic text-neutral-500" : "text-neutral-900"
                }`}
                title={s.titleFallback ? "源库没有可用标题，这是取首条提问兜底的" : s.title}
              >
                {s.title}
              </div>
              <div className="mt-0.5 truncate font-mono text-[11px] text-neutral-500">{s.id}</div>
            </Link>
          );
        },
      },
      {
        accessorKey: "origin",
        header: "来源",
        cell: ({ row }) => (
          <span
            className={
              row.original.origin === "cron" ? "text-neutral-500" : "text-neutral-800"
            }
          >
            {ORIGIN_LABEL[row.original.origin]}
          </span>
        ),
      },
      {
        accessorKey: "model",
        header: "模型",
        cell: ({ row }) => (
          <span className="truncate text-xs text-neutral-600">{row.original.model ?? "—"}</span>
        ),
      },
      {
        accessorKey: "messageCount",
        header: "消息",
        meta: { align: "right", headerTitle: "源库记的消息总数（含工具往返）" },
        cell: ({ row }) => <span className="tabular-nums">{row.original.messageCount}</span>,
      },
      {
        accessorKey: "toolCallCount",
        header: "工具",
        meta: { align: "right", headerTitle: "这场会话调用工具的次数" },
        cell: ({ row }) => <span className="tabular-nums">{row.original.toolCallCount}</span>,
      },
      {
        accessorKey: "endedAtIso",
        header: "结束时间",
        meta: { align: "right" },
        cell: ({ row }) => (
          <span className="whitespace-nowrap text-xs text-neutral-500">
            {formatFileTimeMs(parseTime(row.original.endedAtIso ?? row.original.startedAtIso))}
          </span>
        ),
      },
    ],
    []
  );

  return (
    <Page
      title="Hermes 会话"
      subtitle="本机 Hermes Agent 的会话。默认只看你自己发起的——大多数会话是 cron 定时任务跑的。"
      fill
      actions={
        <button
          type="button"
          onClick={() =>
            void queryClient.invalidateQueries({ queryKey: ["hermes-history-sessions"] })
          }
          className="inline-flex h-9 items-center gap-2 rounded-lg border border-neutral-200 bg-white px-3 text-sm font-medium text-neutral-800 shadow-sm transition hover:border-blue-200 hover:bg-slate-50"
        >
          <RefreshCw className="h-4 w-4" aria-hidden="true" />
          刷新
        </button>
      }
      toolbar={
        <div className="flex items-end gap-4">
          <div>
            <span className="mb-1 block text-xs font-medium text-[var(--muted)]">来源</span>
            <div className="inline-flex overflow-hidden rounded-lg border border-neutral-200">
              {SCOPES.map((s) => (
                <button
                  key={s.key}
                  type="button"
                  data-testid={`scope-${s.key}`}
                  title={s.hint}
                  onClick={() => setScope(s.key)}
                  className={`h-9 px-3 text-sm transition ${
                    scope === s.key
                      ? "bg-blue-600 text-white"
                      : "bg-white text-neutral-700 hover:bg-slate-50"
                  }`}
                >
                  {s.label}
                  <span className="ml-1.5 tabular-nums opacity-70">{counts[s.key]}</span>
                </button>
              ))}
            </div>
          </div>
          <label className="block w-72">
            <span className="mb-1 block text-xs font-medium text-[var(--muted)]">搜索</span>
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="标题或模型"
              className="h-9 w-full rounded-lg border border-neutral-200 bg-white px-3 text-sm"
            />
          </label>
        </div>
      }
    >
      {list.isError && (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          {(list.error as Error).message}
        </div>
      )}
      {list.data?.diagnostic && (
        <div
          data-testid="hermes-diagnostic"
          className="mb-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-900"
        >
          读不到 Hermes 的 state.db（{list.data.diagnostic.kind}）：
          {list.data.diagnostic.message}
        </div>
      )}
      <DataTable
        columns={columns}
        data={filtered}
        title={`${filtered.length} 场会话`}
        emptyText={
          sessions.length === 0
            ? "还没有 Hermes 会话。没装 Hermes Agent 的话这里本来就是空的。"
            : scope === "human"
              ? "你自己发起的会话是空的——切到「定时任务」看 cron 跑了什么。"
              : "没有匹配的会话。"
        }
        clientSort
        hidePager
        fillHeight
      />
    </Page>
  );
}
