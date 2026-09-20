import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { RefreshCw } from "lucide-react";
import type { ColumnDef } from "@tanstack/react-table";
import { apiGet } from "../api";
import { Page } from "../components/Page";
import { DataTable } from "../components/DataTable";
import { formatFileTimeMs } from "../util/formatDisplay";
import {
  ALL_PROJECTS,
  matchesQuery,
  PENDING_PROJECT_LABEL,
  projectPanel,
  sessionsForProject,
} from "../kimiHistory/grouping";

/**
 * kimi 会话列表。左栏项目、右栏会话 —— 与 claude/codex/opencode 的历史页同一形态。
 *
 * 两处有意与它们不同:
 *  - 不选项目时右栏显示**全部**会话(它们是「请先在左侧选择一个项目」的空态)。
 *    kimi 一共 30 场上下,一屏看完比强制两次点击有用。
 *  - 左栏用一行式而不是卡片。codex 有 43 个项目、claude 有 109 个,它们那个卡片左栏
 *    本来就是个已知的长滚动,不值得照抄。
 *
 * 后端比另外三家薄得多 —— kimi 的数据已在 index.db 里(V55 的 token 索引 +
 * agent_user_messages 的正文),分组在前端一次算完,不另开 /projects 接口。
 *
 * 「问了 N 次」数的是**真人提问**,不是消息总数。真库里 kimi 的消息 92% 是 AI 正文,
 * 数全部会显示成「303 条」这种比实际互动量大一个量级的数字。
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
  /** false = 只有正文,还没进 token 索引 —— 标题/项目归属暂缺,收进「待索引」。 */
  tokenIndexed: boolean;
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
  // 选中的项目与搜索词都进 URL:点进一场会话再返回时,不用重新找那个目录。
  const [searchParams, setSearchParams] = useSearchParams();
  const project = searchParams.get("project") ?? ALL_PROJECTS;
  const query = searchParams.get("q") ?? "";

  const patchParams = (patch: Record<string, string>) => {
    const next = new URLSearchParams(searchParams);
    for (const [k, v] of Object.entries(patch)) {
      if (v) next.set(k, v);
      else next.delete(k);
    }
    setSearchParams(next, { replace: true });
  };

  const list = useQuery({
    queryKey: ["kimi-history-sessions"],
    queryFn: () => apiGet<KimiSessionsResponse>("/api/kimi-history/sessions"),
  });

  const sessions = useMemo(() => list.data?.sessions ?? [], [list.data]);
  const matched = useMemo(
    () => sessions.filter((s) => matchesQuery(s, query)),
    [sessions, query]
  );
  const groups = useMemo(
    () => projectPanel(sessions, matched, project),
    [sessions, matched, project]
  );
  const rows = useMemo(() => sessionsForProject(matched, project), [matched, project]);

  const selectedGroup = groups.find((g) => g.key === project);
  const showProjectColumn = project === ALL_PROJECTS;

  const columns = useMemo<ColumnDef<KimiSession>[]>(() => {
    const projectColumn: ColumnDef<KimiSession> = {
      accessorKey: "projectPath",
      header: "项目",
      cell: ({ row }) => (
        <span
          className="block truncate font-mono text-[11px] text-neutral-600"
          title={row.original.projectPath}
        >
          {!row.original.tokenIndexed
            ? PENDING_PROJECT_LABEL
            : row.original.projectPath === ""
              ? "—"
              : row.original.projectPath.split("/").slice(-2).join("/")}
        </span>
      ),
    };
    return [
      {
        accessorKey: "title",
        header: "会话",
        cell: ({ row }) => {
          const s = row.original;
          return (
            <Link
              to={`/kimi-history/s/${encodeURIComponent(s.sessionId)}${
                project ? `?project=${encodeURIComponent(project)}` : ""
              }`}
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
      // 选中具体项目后整列是同一个值,纯占宽度 —— 这张表横向本来就紧,而仓库禁止横向滚动条。
      ...(showProjectColumn ? [projectColumn] : []),
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
    ];
  }, [project, showProjectColumn]);

  return (
    <Page
      title="Kimi 会话"
      subtitle="本机 kimi 的会话记录，按工作目录分组。「提问」数的是真人发言，不含 AI 正文。"
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
            onChange={(e) => patchParams({ q: e.target.value })}
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

      {/* min-w-0 / min-h-0:grid 子项默认 min-width:auto,长路径(font-mono 不换行)会顶破
          列宽让 truncate 失效 → 整页横向滚动条。高度同理,不归 0 表格撑不开内部滚动。 */}
      <div className="grid min-h-0 flex-1 gap-4 lg:grid-cols-[minmax(0,240px)_minmax(0,1fr)]">
        <aside className="flex min-h-0 min-w-0 flex-col">
          <h2 className="text-xs font-medium text-[var(--muted)]">项目</h2>
          <ul className="mt-1.5 min-h-0 flex-1 space-y-0.5 overflow-y-auto pr-1">
            <ProjectRow
              label="全部"
              title="所有工作目录的会话"
              count={matched.length}
              active={project === ALL_PROJECTS}
              onClick={() => patchParams({ project: "" })}
            />
            {groups.map((g) => (
              <ProjectRow
                key={g.key}
                label={g.label}
                title={
                  g.isPending
                    ? "只有正文、还没进 token 索引的会话 —— 看上面的诊断"
                    : g.path || "确定不属于任何工作目录的会话"
                }
                count={g.sessionCount}
                active={g.key === project}
                muted={g.isUnknown || g.isPending}
                onClick={() => patchParams({ project: g.key })}
              />
            ))}
          </ul>
        </aside>

        <div className="flex min-h-0 min-w-0 flex-col">
          <DataTable
            columns={columns}
            data={rows}
            title={
              project === ALL_PROJECTS
                ? `${rows.length} 场会话`
                : `${selectedGroup?.label ?? "该目录"} · ${rows.length} 场会话`
            }
            emptyText={emptyTextFor(sessions.length, query, project)}
            clientSort
            hidePager
            fillHeight
          />
        </div>
      </div>
    </Page>
  );
}

function emptyTextFor(total: number, query: string, project: string): string {
  if (total === 0) return "还没有 kimi 会话。若刚装上 kimi，等一次 kimi.tokens.refresh 后再来。";
  if (query.trim() && project !== ALL_PROJECTS) return "这个目录里没有匹配的会话。";
  if (query.trim()) return "没有匹配的会话。";
  return "这个目录下没有会话。";
}

function ProjectRow({
  label,
  title,
  count,
  active,
  muted = false,
  onClick,
}: {
  label: string;
  title: string;
  count: number;
  active: boolean;
  muted?: boolean;
  onClick: () => void;
}) {
  return (
    <li>
      <button
        type="button"
        onClick={onClick}
        title={title}
        className={[
          "flex w-full items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-left transition",
          active ? "bg-blue-50 text-blue-900 ring-1 ring-blue-200" : "hover:bg-slate-100",
        ].join(" ")}
      >
        <span
          className={[
            "min-w-0 truncate text-sm",
            muted ? "italic text-neutral-500" : "text-neutral-800",
          ].join(" ")}
        >
          {label}
        </span>
        <span className="shrink-0 tabular-nums text-[11px] text-neutral-500">{count}</span>
      </button>
    </li>
  );
}
