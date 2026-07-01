import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import { RefreshCw } from "lucide-react";
import { motion } from "motion/react";
import { useSearchParams } from "react-router-dom";
import { apiGet } from "../api";
import { Page } from "../components/Page";
import { ProjectOpenActions } from "../components/ProjectOpenActions";
import { formatActiveDuration, formatFileTimeMs, formatTokenCount } from "../util/formatDisplay";

type DashboardSource = "claude-code" | "codex" | "opencode";

type TokenRankingProject = {
  key: string;
  label: string;
  path: string;
  totalTokens: number;
  activeMs: number;
};

type TokenRankingResponse = {
  ok: true;
  generatedAt: string;
  range: {
    from: string | null;
    to: string;
    months: 1 | 3 | 6 | 12 | "all";
  };
  sources: DashboardSource[];
  diagnostics: Array<{
    source: DashboardSource;
    severity: "info" | "warning" | "error";
    kind: string;
    message: string;
  }>;
  projects: TokenRankingProject[];
};

const rangeOptions = [
  { value: "1", label: "最近 1 个月" },
  { value: "3", label: "最近 3 个月" },
  { value: "6", label: "最近 6 个月" },
  { value: "12", label: "最近 1 年" },
  { value: "all", label: "时间不限" },
];

const sourceOptions = [
  { value: "claude-code,codex,opencode", label: "Claude + Codex + opencode" },
  { value: "codex", label: "Codex" },
  { value: "claude-code", label: "Claude" },
  { value: "opencode", label: "opencode" },
];

function qs(params: Record<string, string | undefined>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v != null && v.trim() !== "") p.set(k, v.trim());
  }
  const q = p.toString();
  return q ? `?${q}` : "";
}

function parseTime(value: string): number {
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

export function WorkTokenRanking() {
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const rangeMonths = searchParams.get("rangeMonths") ?? "6";
  const sources = searchParams.get("sources") ?? "claude-code,codex,opencode";
  const apiSuffix = useMemo(
    () => qs({ rangeMonths, sources }),
    [rangeMonths, sources]
  );

  const ranking = useQuery({
    queryKey: ["work-token-ranking", apiSuffix],
    queryFn: () =>
      apiGet<TokenRankingResponse>(`/api/work-dashboard/token-projects${apiSuffix}`),
  });

  function setParam(key: string, value: string) {
    const next = new URLSearchParams(searchParams);
    if (value.trim()) next.set(key, value);
    else next.delete(key);
    setSearchParams(next, { replace: true });
  }

  function refresh() {
    void queryClient.invalidateQueries({ queryKey: ["work-token-ranking"] });
  }

  return (
    <Page
      title="Token 排行"
      subtitle="按项目汇总 Claude Code 与 Codex 能统计到的真实 token。"
      actions={
        <div className="text-right text-xs text-[var(--muted)]">
          <div>本机只读 · 不估算 token</div>
          {ranking.data && (
            <div className="mt-1">
              刷新 {formatFileTimeMs(parseTime(ranking.data.generatedAt))}
            </div>
          )}
        </div>
      }
      toolbar={
        <section className="grid grid-cols-[180px_180px_auto_minmax(0,1fr)] items-end gap-3 border-t border-[var(--border)] py-3">
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-[var(--muted)]">时间范围</span>
          <select
            value={rangeMonths}
            onChange={(e) => setParam("rangeMonths", e.target.value)}
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
            value={sources}
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
        <div className="text-right text-sm text-[var(--muted)]">
          {ranking.data ? `${ranking.data.projects.length} 个项目` : ""}
        </div>
        </section>
      }
    >
      {ranking.isError && (
        <div className="mt-5 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-900" role="alert">
          {(ranking.error as Error).message}
        </div>
      )}

      {ranking.data && ranking.data.diagnostics.length > 0 && (
        <div className="mt-5 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-950">
          <div className="font-medium">Token 索引诊断 · {ranking.data.diagnostics.length} 条</div>
          <ul className="mt-2 space-y-1">
            {ranking.data.diagnostics.map((diagnostic, idx) => (
              <li key={`${diagnostic.source}-${diagnostic.kind}-${idx}`}>
                {diagnostic.source === "claude-code"
                  ? "Claude"
                  : diagnostic.source === "codex"
                    ? "Codex"
                    : "opencode"}{" "}
                · {diagnostic.message}
              </li>
            ))}
          </ul>
        </div>
      )}

      {ranking.isLoading && (
        <div className="mt-6 grid grid-cols-4 gap-4">
          {Array.from({ length: 8 }).map((_, idx) => (
            <div key={idx} className="h-32 animate-pulse rounded-lg bg-neutral-100" />
          ))}
        </div>
      )}

      {ranking.data && ranking.data.projects.length === 0 && (
        <div className="mt-8 rounded-lg border border-dashed border-neutral-300 bg-white/70 py-20 text-center text-sm text-[var(--muted)]">
          当前筛选范围内没有可统计 token 的项目。
        </div>
      )}

      {ranking.data && ranking.data.projects.length > 0 && (
        <section className="mt-6 grid grid-cols-4 gap-4">
          {ranking.data.projects.map((project, idx) => (
            <motion.article
              key={project.key}
              className="rounded-lg border border-neutral-200 bg-white px-4 py-4 shadow-sm"
              initial="idle"
              animate="idle"
              whileHover="parentHover"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-xs font-semibold text-neutral-400">
                    #{idx + 1}
                  </div>
                  <h2 className="mt-1 truncate text-base font-semibold text-neutral-950">
                    {project.label}
                  </h2>
                </div>
                <ProjectOpenActions path={project.path} />
              </div>
              <div className="mt-5 text-2xl font-semibold tracking-tight text-neutral-950">
                {formatTokenCount(project.totalTokens)}
              </div>
              <div className="mt-1 flex items-center justify-between gap-3 text-xs font-medium text-[var(--muted)]">
                <span>token</span>
                <span title="由 Claude Code / Codex 本地 JSONL 时间戳推断">
                  活跃 {formatActiveDuration(project.activeMs)}
                </span>
              </div>
              <div className="mt-4 truncate font-mono text-[11px] text-neutral-500" title={project.path}>
                {project.path}
              </div>
            </motion.article>
          ))}
        </section>
      )}
    </Page>
  );
}
