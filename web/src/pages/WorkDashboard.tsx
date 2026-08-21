import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { RefreshCw } from "lucide-react";
import { apiGet } from "../api";
import {
  formatFileTimeMs,
  formatTokenCount,
  formatTokenCoverage,
} from "../util/formatDisplay";
import {
  buildSourceOptions,
  sourceLabel,
  type DashboardSource,
} from "../util/sourceLabels";

type TokenCoverage = "full" | "partial" | "unknown";

type TokenUsage = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  coverage: TokenCoverage;
  coveredSessions: number;
  totalSessions: number;
  scannedSessions: number;
  scanLimit: number;
  truncated: boolean;
};

type Diagnostic = {
  source: DashboardSource;
  severity: "info" | "warning" | "error";
  kind: string;
  message: string;
  path?: string;
  count?: number;
};

type DashboardSession = {
  id: string;
  source: DashboardSource;
  projectPath: string;
  identityConfidence: "high" | "low";
  title: string;
  preview: string;
  createdAt: string;
  lastUpdatedAt: string;
  messageCount: number;
  model?: string;
  gitBranch?: string;
  detailHref: string;
};

type DashboardProject = {
  key: string;
  label: string;
  path: string;
  identityConfidence: "high" | "low";
  lastUpdatedAt: string;
  sessionCount: number;
  sourceCounts: Record<DashboardSource, number>;
  tokenUsage: TokenUsage;
  recentSessions: DashboardSession[];
};

type DashboardResponse = {
  ok: true;
  generatedAt: string;
  range: { from: string | null; to: string; days: number | "all" };
  /** 后端这次实际采用的源 —— 下拉选中态读它。 */
  sources: DashboardSource[];
  /** 后端支持的全部源 —— 下拉选项读它,前端不再自己维护一份列表。 */
  availableSources: DashboardSource[];
  diagnostics: Diagnostic[];
  totals: {
    projectCount: number;
    sessionCount: number;
    tokenUsage: TokenUsage;
    sourceCounts: Record<DashboardSource, number>;
  };
  projects: DashboardProject[];
};

const rangeOptions = [
  { value: "7", label: "最近 7 天" },
  { value: "30", label: "最近 30 天" },
  { value: "90", label: "最近 90 天" },
  { value: "all", label: "全部时间" },
];

function qs(params: Record<string, string | undefined>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v != null && v.trim() !== "") p.set(k, v.trim());
  }
  const q = p.toString();
  return q ? `?${q}` : "";
}

function coverageClass(coverage: TokenCoverage): string {
  if (coverage === "full") return "border-emerald-200 bg-emerald-50 text-emerald-800";
  if (coverage === "partial") return "border-amber-200 bg-amber-50 text-amber-900";
  return "border-neutral-200 bg-neutral-50 text-neutral-600";
}

function metricLabel(value: number, label: string): string {
  return `${value.toLocaleString("zh-CN")} ${label}`;
}

function parseTime(value: string): number {
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

function isBlockingDiagnostic(diagnostic: Diagnostic): boolean {
  return diagnostic.severity === "error";
}

function DiagnosticsPanel({
  diagnostics,
  blocking,
}: {
  diagnostics: Diagnostic[];
  blocking: boolean;
}) {
  if (diagnostics.length === 0) return null;
  return (
    <details
      open={blocking}
      className={[
        "rounded-lg border px-4 py-3 text-sm",
        blocking
          ? "mt-5 border-red-200 bg-red-50 text-red-950"
          : "mt-5 border-amber-200 bg-amber-50/70 text-amber-950",
      ].join(" ")}
    >
      <summary className="cursor-pointer font-medium">
        数据诊断 · {diagnostics.length} 条
      </summary>
      <ul className="mt-3 space-y-2">
        {diagnostics.map((d, idx) => (
          <li key={`${d.source}-${d.kind}-${idx}`}>
            <span className="font-semibold">{sourceLabel(d.source)} · {d.kind}</span>
            <span className="ml-2">{d.message}</span>
            {d.path && <span className="ml-2 break-all font-mono text-xs">{d.path}</span>}
          </li>
        ))}
      </ul>
    </details>
  );
}

export function WorkDashboard() {
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const rangeDays = searchParams.get("rangeDays") ?? "30";
  // 不带 fallback 字面量 —— 前端一旦总是显式发送,后端的 DEFAULT_*_OPTIONS.sources
  // 就永远不会生效。无参时交给后端定,下拉的选中态从响应回显读。
  const sources = searchParams.get("sources") ?? undefined;
  const [projectQuery, setProjectQuery] = useState("");
  const apiSuffix = useMemo(() => qs({ rangeDays, sources }), [rangeDays, sources]);

  const dashboard = useQuery({
    queryKey: ["work-dashboard", apiSuffix],
    queryFn: () => apiGet<DashboardResponse>(`/api/work-dashboard${apiSuffix}`),
  });

  const projects = dashboard.data?.projects ?? [];
  const filteredProjects = useMemo(() => {
    const q = projectQuery.trim().toLowerCase();
    if (!q) return projects;
    return projects.filter((p) =>
      `${p.label} ${p.path}`.toLowerCase().includes(q)
    );
  }, [projects, projectQuery]);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const selectedProject =
    filteredProjects.find((p) => p.key === selectedKey) ?? filteredProjects[0] ?? null;
  // URL 上有就用 URL 的(尊重老书签),否则用后端这次实际采用的那组。
  const selectedSources = sources ?? dashboard.data?.sources.join(",") ?? "";
  const sourceOptions = buildSourceOptions(
    dashboard.data?.availableSources ?? [],
    selectedSources
  );
  const blockingDiagnostics = (dashboard.data?.diagnostics ?? []).filter(isBlockingDiagnostic);
  const secondaryDiagnostics = (dashboard.data?.diagnostics ?? []).filter(
    (diagnostic) => !isBlockingDiagnostic(diagnostic)
  );

  function setParam(key: string, value: string) {
    const next = new URLSearchParams(searchParams);
    if (value.trim()) next.set(key, value);
    else next.delete(key);
    setSearchParams(next, { replace: true });
  }

  function refresh() {
    void queryClient.invalidateQueries({ queryKey: ["work-dashboard"] });
  }

  return (
    <div className="min-h-[70vh]">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-[var(--fg)]">最近工作</h1>
          <p className="mt-1 text-sm text-[var(--muted)]">
            从 Claude Code 与 Codex 本机会话判断最近活跃项目。
          </p>
        </div>
        <div className="text-right text-xs text-[var(--muted)]">
          <div>本机只读 · token 只统计真实 usage</div>
          {dashboard.data && (
            <div className="mt-1">
              扫描 {formatFileTimeMs(parseTime(dashboard.data.generatedAt))}
            </div>
          )}
        </div>
      </header>

      <section className="mt-5 grid grid-cols-[minmax(0,1fr)_160px_180px_auto] items-end gap-3 border-y border-[var(--border)] py-3">
        <label className="block min-w-0">
          <span className="mb-1 block text-xs font-medium text-[var(--muted)]">项目搜索</span>
          <input
            value={projectQuery}
            onChange={(e) => setProjectQuery(e.target.value)}
            placeholder="搜索项目路径或名称"
            className="h-10 w-full rounded-lg border border-neutral-200 bg-white px-3 text-sm outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-500/20"
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-[var(--muted)]">范围</span>
          <select
            value={rangeDays}
            onChange={(e) => setParam("rangeDays", e.target.value)}
            className="h-10 w-full rounded-lg border border-neutral-200 bg-white px-3 text-sm"
          >
            {rangeOptions.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-[var(--muted)]">来源</span>
          <select
            value={selectedSources}
            onChange={(e) => setParam("sources", e.target.value)}
            className="h-10 w-full rounded-lg border border-neutral-200 bg-white px-3 text-sm"
          >
            {sourceOptions.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
        </label>
        <button
          type="button"
          onClick={refresh}
          className="inline-flex h-10 items-center gap-2 rounded-lg border border-neutral-200 bg-white px-3 text-sm font-medium text-neutral-800 shadow-sm transition hover:border-blue-200 hover:bg-slate-50"
        >
          <RefreshCw className="h-4 w-4" aria-hidden="true" />
          刷新
        </button>
      </section>

      {dashboard.isError && (
        <div className="mt-5 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-900" role="alert">
          {(dashboard.error as Error).message}
        </div>
      )}

      {dashboard.isLoading && (
        <div className="mt-8 grid animate-pulse gap-4">
          <div className="h-20 rounded-lg bg-neutral-200/70" />
          <div className="h-96 rounded-lg bg-neutral-100" />
        </div>
      )}

      {dashboard.data && (
        <>
          <section className="mt-5 flex flex-wrap items-center gap-x-5 gap-y-2 border-b border-[var(--border)] pb-3 text-sm">
            <span className="text-[var(--muted)]">当前范围</span>
            <span><strong className="font-semibold text-neutral-950">{dashboard.data.totals.projectCount}</strong> 活跃项目</span>
            <span><strong className="font-semibold text-neutral-950">{dashboard.data.totals.sessionCount}</strong> 会话</span>
            <span><strong className="font-semibold text-neutral-950">{formatTokenCount(dashboard.data.totals.tokenUsage.totalTokens)}</strong> 真实 token</span>
            <span className={`rounded-full border px-2 py-0.5 text-xs ${coverageClass(dashboard.data.totals.tokenUsage.coverage)}`}>
              {formatTokenCoverage(dashboard.data.totals.tokenUsage.coverage)}
            </span>
            {secondaryDiagnostics.length > 0 && (
              <span className="text-xs font-medium text-amber-800">
                部分诊断 {secondaryDiagnostics.length} 条
              </span>
            )}
          </section>

          <DiagnosticsPanel diagnostics={blockingDiagnostics} blocking />

          <section className="mt-5 grid grid-cols-[380px_minmax(0,1fr)] gap-6">
            <aside className="min-h-[32rem] border-t border-[var(--border)] pt-3">
              <div className="mb-2 text-xs text-[var(--muted)]">按最近对话排序</div>
              <div className="max-h-[calc(100vh-320px)] overflow-auto pr-1">
                {filteredProjects.map((project) => {
                  const active = project.key === selectedProject?.key;
                  return (
                    <button
                      key={project.key}
                      type="button"
                      onClick={() => setSelectedKey(project.key)}
                      className={[
                        "mb-2 w-full rounded-lg border bg-white px-3 py-3 text-left shadow-sm transition",
                        active ? "border-blue-300 shadow-md ring-1 ring-blue-100" : "border-neutral-200 hover:border-blue-200",
                      ].join(" ")}
                    >
                      <div className="flex items-center justify-between gap-3">
                        <div className="min-w-0 truncate text-sm font-semibold text-neutral-900">
                          {project.label}
                        </div>
                        <div className="shrink-0 text-[11px] text-[var(--muted)]">
                          {formatFileTimeMs(parseTime(project.lastUpdatedAt))}
                        </div>
                      </div>
                      <div className="mt-1 truncate font-mono text-[11px] text-neutral-500" title={project.path}>
                        {project.path}
                      </div>
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        <span className="rounded-full border border-neutral-200 bg-neutral-50 px-2 py-0.5 text-[11px]">
                          {metricLabel(project.sessionCount, "会话")}
                        </span>
                        {Object.entries(project.sourceCounts)
                          .filter(([, count]) => count > 0)
                          .map(([source]) => (
                            <span
                              key={source}
                              className="rounded-full border border-neutral-200 bg-neutral-50 px-2 py-0.5 text-[11px]"
                            >
                              {sourceLabel(source)}
                            </span>
                          ))}
                        <span className={`rounded-full border px-2 py-0.5 text-[11px] ${coverageClass(project.tokenUsage.coverage)}`}>
                          {formatTokenCoverage(project.tokenUsage.coverage)}
                        </span>
                      </div>
                    </button>
                  );
                })}
              </div>
            </aside>

            <section className="border-t border-[var(--border)] pt-3">
              {!selectedProject ? (
                <div className="rounded-lg border border-dashed border-neutral-300 bg-white/60 py-20 text-center text-sm text-[var(--muted)]">
                  当前范围内没有 Claude Code 或 Codex 项目。
                </div>
              ) : (
                <div className="rounded-lg border border-[var(--border)] bg-white px-5 py-4 shadow-sm">
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0">
                      <h2 className="truncate text-xl font-semibold text-neutral-950">
                        {selectedProject.label}
                      </h2>
                      <p className="mt-1 break-all font-mono text-xs text-neutral-500">
                        {selectedProject.path}
                      </p>
                    </div>
                    <span className={`shrink-0 rounded-full border px-2.5 py-1 text-xs font-medium ${coverageClass(selectedProject.tokenUsage.coverage)}`}>
                      {formatTokenCoverage(selectedProject.tokenUsage.coverage)}
                    </span>
                  </div>

                  <div className="mt-4 grid grid-cols-4 gap-3 border-y border-neutral-100 py-4">
                    <div>
                      <div className="text-xs text-[var(--muted)]">最近</div>
                      <div className="mt-1 text-sm font-semibold">{formatFileTimeMs(parseTime(selectedProject.lastUpdatedAt))}</div>
                    </div>
                    <div>
                      <div className="text-xs text-[var(--muted)]">会话</div>
                      <div className="mt-1 text-sm font-semibold">{selectedProject.sessionCount}</div>
                    </div>
                    <div>
                      <div className="text-xs text-[var(--muted)]">真实 token</div>
                      <div className="mt-1 text-sm font-semibold">{formatTokenCount(selectedProject.tokenUsage.totalTokens)}</div>
                    </div>
                    <div>
                      <div className="text-xs text-[var(--muted)]">覆盖</div>
                      <div className="mt-1 text-sm font-semibold">
                        {selectedProject.tokenUsage.coveredSessions}/{selectedProject.tokenUsage.totalSessions}
                        {selectedProject.tokenUsage.truncated ? " · 部分扫描" : ""}
                      </div>
                    </div>
                  </div>

                  <div className="mt-4">
                    <div className="grid grid-cols-[92px_minmax(0,1fr)_170px_120px] border-b border-neutral-200 pb-2 text-xs font-medium text-neutral-500">
                      <div>来源</div>
                      <div>会话</div>
                      <div>更新时间</div>
                      <div>消息数</div>
                    </div>
                    {selectedProject.recentSessions.map((session) => (
                      <Link
                        key={`${session.source}-${session.id}`}
                        to={session.detailHref}
                        className="grid grid-cols-[92px_minmax(0,1fr)_170px_120px] gap-0 border-b border-neutral-100 py-3 text-sm transition hover:bg-slate-50/70"
                      >
                        <div className="font-semibold">{sourceLabel(session.source)}</div>
                        <div className="min-w-0">
                          <div className="truncate font-medium text-neutral-900">{session.title}</div>
                          <div className="mt-1 truncate text-xs text-neutral-500">{session.preview}</div>
                        </div>
                        <div className="text-xs text-neutral-500">{formatFileTimeMs(parseTime(session.lastUpdatedAt))}</div>
                        <div className="text-xs text-neutral-600">{session.messageCount} 条</div>
                      </Link>
                    ))}
                  </div>
                </div>
              )}
            </section>
          </section>

          <DiagnosticsPanel diagnostics={secondaryDiagnostics} blocking={false} />
        </>
      )}
    </div>
  );
}
