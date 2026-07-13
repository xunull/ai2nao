import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Link } from "react-router-dom";
import { RefreshCw } from "lucide-react";
import { apiGet } from "../api";
import { formatFileTimeMs } from "../util/formatDisplay";

// Rolling windows ("过去 N×24 小时") + calendar windows (固定自然周期).
// `today` / `last-week` exist so a scheduled report has a closed, fixed period —
// a rolling 7d spans two natural weeks. Mirrors src/workRecap/types.ts.
type WorkRecapWindow = "1d" | "3d" | "7d" | "14d" | "30d" | "today" | "last-week";

const WINDOWS: { value: WorkRecapWindow; label: string }[] = [
  { value: "today", label: "今天(自然日)" },
  { value: "last-week", label: "上周(自然周)" },
  { value: "1d", label: "1 天" },
  { value: "3d", label: "3 天" },
  { value: "7d", label: "1 周" },
  { value: "14d", label: "2 周" },
  { value: "30d", label: "1 月" },
];

const DEFAULT_WINDOW: WorkRecapWindow = "7d";

type WorkMode = "build" | "debug" | "explore" | "fragmented" | "low_signal";
type Fragmentation = "low" | "med" | "high";
type DegradeReason =
  | "sparse_signal"
  | "llm_timeout"
  | "llm_malformed"
  | "llm_empty"
  | "llm_unavailable"
  | "text_fact_conflict"
  | "scan_timeout"
  | "prompt_budget_exceeded";

type ProjectShare = {
  projectKey: string;
  projectLabel: string;
  commitCount: number;
  share: number;
};

type Diagnostic = {
  severity: "info" | "warning" | "error";
  kind: string;
  message: string;
  repo?: string;
};

type FactStatus = "ok" | "absent" | "empty" | "error";
type FactGroup<T> = { status: FactStatus; data?: T; message?: string };
type TokenFacts = {
  costUsd: number;
  coverage: "full" | "partial" | "unknown";
  unpricedTokenCount: number;
  priceSnapshotDate: string;
  headlineTokens: number;
  dominantProvider: string;
  claudeShare: number;
  codexShare: number;
};
type TopicShare = { name: string; count: number; share: number };
type TopicSourceTop = { source: "chrome" | "git" | "conversation"; events: number; top: TopicShare[] };
type TopicDriftItem = { source: string; from: string; to: string };
type TopicFacts = { bySource: TopicSourceTop[]; drift: TopicDriftItem[] | null };

type WorkRecapFacts = {
  windowKey: WorkRecapWindow;
  windowStart: string;
  windowEnd: string;
  authorEmail: string;
  totalCommits: number;
  projectCount: number;
  projectShare: ProjectShare[];
  commitTypeCounts: Record<string, number>;
  dailyCounts: { date: string; commitCount: number }[];
  reposScanned: number;
  reposTotal: number;
  scanTruncated: boolean;
  scanTruncatedReason: DegradeReason | null;
  diagnostics: Diagnostic[];
  // v2 multi-source (absent on runs generated before work-recap@v2).
  tokenFacts?: FactGroup<TokenFacts>;
  topicDrift?: FactGroup<TopicFacts>;
};

const FACT_STATUS_LABEL: Record<FactStatus, string> = {
  ok: "",
  absent: "无此来源数据",
  empty: "本窗口无活动",
  error: "读取失败",
};
const TOPIC_SOURCE_LABEL: Record<string, string> = {
  chrome: "浏览",
  git: "提交",
  conversation: "对话",
};
const PROVIDER_LABEL: Record<string, string> = {
  claude: "Claude",
  codex: "Codex",
  minimax: "MiniMax",
  none: "—",
};

type WorkRecapInference = {
  summary: string;
  workMode: WorkMode;
  workModeReason: string;
  nextUp: string[];
  fragmentation: Fragmentation;
  degraded: boolean;
  degradeReason: DegradeReason | null;
};

type WorkRecapRun = {
  id: number;
  windowKey: WorkRecapWindow;
  generatedAt: string;
  model: string;
  promptVersion: string;
  facts: WorkRecapFacts;
  inference: WorkRecapInference;
};

type EmptyResponse = {
  ok: true;
  empty: true;
  reason: "no_repos_indexed";
};

type LatestResponse = {
  ok: true;
  windowKey: WorkRecapWindow;
  run: WorkRecapRun | null;
};

type ListResponse = {
  ok: true;
  windowKey: WorkRecapWindow;
  runs: WorkRecapRun[];
};

type GenerateResponse =
  | { ok: true; run: WorkRecapRun }
  | EmptyResponse;

type InflightError = {
  status: 409;
  body: {
    ok: false;
    inflight: true;
    windowKey: WorkRecapWindow;
    startedAt: string;
  };
};

function parseWindowParam(raw: string | null): WorkRecapWindow {
  if (raw && WINDOWS.some((w) => w.value === raw)) {
    return raw as WorkRecapWindow;
  }
  return DEFAULT_WINDOW;
}

async function generateRecap(window: WorkRecapWindow): Promise<GenerateResponse> {
  const res = await fetch(`/api/work-recap/generate?window=${window}`, {
    method: "POST",
    headers: { Accept: "application/json" },
  });
  if (res.status === 409) {
    const body = (await res.json()) as InflightError["body"];
    throw Object.assign(new Error("recap already in flight"), {
      inflight: body,
    });
  }
  if (!res.ok) {
    let msg = res.statusText;
    try {
      const j = (await res.json()) as { error?: { message?: string } };
      if (j.error?.message) msg = j.error.message;
    } catch {
      /* ignore */
    }
    throw new Error(msg);
  }
  return (await res.json()) as GenerateResponse;
}

const WORK_MODE_LABEL: Record<WorkMode, string> = {
  build: "看起来在 build",
  debug: "看起来在 debug",
  explore: "看起来在 explore",
  fragmented: "高度碎片化",
  low_signal: "信号过弱，仅展示事实",
};

const COMMIT_TYPE_LABEL: Record<string, string> = {
  feat: "feat 新功能",
  fix: "fix 修复",
  refactor: "refactor 重构",
  docs: "docs 文档",
  chore: "chore 杂项",
  test: "test 测试",
  style: "style 样式",
  perf: "perf 性能",
  build: "build 构建",
  ci: "ci CI/CD",
  revert: "revert 回退",
  other: "other 其他",
};

const DEGRADE_REASON_LABEL: Record<DegradeReason, string> = {
  sparse_signal: "窗口内信号过弱",
  llm_timeout: "LLM 调用超时",
  llm_malformed: "LLM 返回非 JSON",
  llm_empty: "LLM 返回空",
  llm_unavailable: "LLM 服务不可用",
  text_fact_conflict: "文本与事实层冲突，已丢弃文本",
  scan_timeout: "git 扫描超时（部分 repo 未扫）",
  prompt_budget_exceeded: "提示词预算超限，已截断",
};

function shareWidth(share: number): string {
  const pct = Math.max(0, Math.min(1, share));
  return `${(pct * 100).toFixed(1)}%`;
}

function workModeBadgeClass(mode: WorkMode, degraded: boolean): string {
  if (degraded) {
    return "rounded-md bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-800 ring-1 ring-amber-200";
  }
  switch (mode) {
    case "build":
      return "rounded-md bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-800 ring-1 ring-emerald-200";
    case "debug":
      return "rounded-md bg-rose-50 px-2 py-0.5 text-xs font-medium text-rose-800 ring-1 ring-rose-200";
    case "explore":
      return "rounded-md bg-sky-50 px-2 py-0.5 text-xs font-medium text-sky-800 ring-1 ring-sky-200";
    case "fragmented":
      return "rounded-md bg-zinc-100 px-2 py-0.5 text-xs font-medium text-zinc-700 ring-1 ring-zinc-300";
    case "low_signal":
      return "rounded-md bg-zinc-50 px-2 py-0.5 text-xs font-medium text-zinc-600 ring-1 ring-zinc-200";
  }
}

function RecapCard({ run }: { run: WorkRecapRun }) {
  const { facts, inference } = run;
  const generated = new Date(run.generatedAt).getTime();
  const projectsToShow = facts.projectShare.slice(0, 8);
  const activeKinds = Object.entries(facts.commitTypeCounts)
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1]);

  return (
    <article className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-5">
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className={workModeBadgeClass(inference.workMode, inference.degraded)}>
            {WORK_MODE_LABEL[inference.workMode]}
          </span>
          {inference.workModeReason && (
            <span className="text-xs text-[var(--fg-muted)]">
              {inference.workModeReason}
            </span>
          )}
        </div>
        <span className="text-xs text-[var(--fg-muted)]">
          生成于 {formatFileTimeMs(generated)} · {run.model} · {run.promptVersion}
        </span>
      </header>

      <p className="mt-3 whitespace-pre-wrap text-sm leading-relaxed text-[var(--fg)]">
        {inference.summary}
      </p>

      {inference.degraded && inference.degradeReason && (
        <div className="mt-3 rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-800 ring-1 ring-amber-200">
          摘要降级：{DEGRADE_REASON_LABEL[inference.degradeReason]}
        </div>
      )}

      <section className="mt-4 grid gap-4 md:grid-cols-2">
        <div>
          <h3 className="text-xs font-semibold uppercase tracking-wide text-[var(--fg-muted)]">
            项目占比
          </h3>
          <ul className="mt-2 space-y-1.5">
            {projectsToShow.length === 0 && (
              <li className="text-xs text-[var(--fg-muted)]">无活跃项目</li>
            )}
            {projectsToShow.map((p) => (
              <li key={p.projectKey} className="text-xs">
                <div className="flex justify-between gap-2">
                  <span className="truncate font-medium text-[var(--fg)]" title={p.projectKey}>
                    {p.projectLabel}
                  </span>
                  <span className="tabular-nums text-[var(--fg-muted)]">
                    {p.commitCount} · {shareWidth(p.share)}
                  </span>
                </div>
                <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-[var(--surface-2)]">
                  <div
                    className="h-full bg-[var(--accent)]"
                    style={{ width: shareWidth(p.share) }}
                  />
                </div>
              </li>
            ))}
          </ul>
        </div>

        <div>
          <h3 className="text-xs font-semibold uppercase tracking-wide text-[var(--fg-muted)]">
            commit 类型分布
          </h3>
          <ul className="mt-2 grid grid-cols-2 gap-1 text-xs">
            {activeKinds.length === 0 && (
              <li className="col-span-2 text-[var(--fg-muted)]">无 commit</li>
            )}
            {activeKinds.map(([kind, count]) => (
              <li
                key={kind}
                className="flex justify-between rounded bg-[var(--surface-2)] px-2 py-1 tabular-nums"
              >
                <span className="text-[var(--fg)]">
                  {COMMIT_TYPE_LABEL[kind] ?? kind}
                </span>
                <span className="font-semibold text-[var(--fg)]">{count}</span>
              </li>
            ))}
          </ul>
          <div className="mt-3 text-xs text-[var(--fg-muted)]">
            共 {facts.totalCommits} 条 commit，跨 {facts.projectCount} 个项目，
            扫描 {facts.reposScanned}/{facts.reposTotal} repo
            {facts.scanTruncated && facts.scanTruncatedReason && (
              <span className="ml-1 text-amber-700">
                · {DEGRADE_REASON_LABEL[facts.scanTruncatedReason]}
              </span>
            )}
          </div>
        </div>
      </section>

      {facts.tokenFacts && (
        <section className="mt-4 grid gap-4 md:grid-cols-2">
          <div>
            <h3 className="text-xs font-semibold uppercase tracking-wide text-[var(--fg-muted)]">
              成本 / Token
            </h3>
            {facts.tokenFacts.status === "ok" && facts.tokenFacts.data ? (
              <div className="mt-2 space-y-1 text-xs">
                <div className="text-[var(--fg)]">
                  成本 <span className="font-semibold tabular-nums">${facts.tokenFacts.data.costUsd.toFixed(2)}</span>
                  {facts.tokenFacts.data.coverage !== "full" && (
                    <span className="ml-1 text-amber-700">(至少,覆盖 {facts.tokenFacts.data.coverage})</span>
                  )}
                </div>
                <div className="text-[var(--fg-muted)] tabular-nums">
                  {facts.tokenFacts.data.headlineTokens.toLocaleString()} token(不含缓存) · 主力{" "}
                  {PROVIDER_LABEL[facts.tokenFacts.data.dominantProvider] ?? facts.tokenFacts.data.dominantProvider}{" "}
                  {(facts.tokenFacts.data.claudeShare * 100).toFixed(0)}%/{(facts.tokenFacts.data.codexShare * 100).toFixed(0)}%
                </div>
              </div>
            ) : (
              <p className="mt-2 text-xs text-[var(--fg-muted)]">{FACT_STATUS_LABEL[facts.tokenFacts.status]}</p>
            )}
          </div>

          <div>
            <h3 className="text-xs font-semibold uppercase tracking-wide text-[var(--fg-muted)]">
              本周主题(浏览+对话+提交)
            </h3>
            {facts.topicDrift?.status === "ok" && facts.topicDrift.data ? (
              <ul className="mt-2 space-y-1 text-xs">
                {facts.topicDrift.data.bySource.map((s) => (
                  <li key={s.source}>
                    <span className="font-medium text-[var(--fg)]">{TOPIC_SOURCE_LABEL[s.source] ?? s.source}</span>{" "}
                    <span className="text-[var(--fg-muted)]">
                      {s.top.slice(0, 3).map((t) => `${t.name} ${(t.share * 100).toFixed(0)}%`).join(" · ") || "—"}
                    </span>
                  </li>
                ))}
                {facts.topicDrift.data.drift && facts.topicDrift.data.drift.length > 0 && (
                  <li className="text-[var(--fg-muted)]">
                    漂移:
                    {facts.topicDrift.data.drift
                      .map((d) => `${TOPIC_SOURCE_LABEL[d.source] ?? d.source} ${d.from}→${d.to}`)
                      .join("; ")}
                  </li>
                )}
              </ul>
            ) : (
              <p className="mt-2 text-xs text-[var(--fg-muted)]">
                {FACT_STATUS_LABEL[facts.topicDrift?.status ?? "absent"]}
              </p>
            )}
          </div>
        </section>
      )}

      {inference.nextUp.length > 0 && (
        <section className="mt-4">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-[var(--fg-muted)]">
            明日接力棒
          </h3>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-[var(--fg)]">
            {inference.nextUp.map((line, i) => (
              <li key={i}>{line}</li>
            ))}
          </ul>
        </section>
      )}
    </article>
  );
}

function EmptyReposState({ onSwitchScannerCta }: { onSwitchScannerCta: () => void }) {
  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-8 text-center">
      <h2 className="text-base font-semibold text-[var(--fg)]">还未扫描 git 仓库</h2>
      <p className="mt-2 text-sm text-[var(--fg-muted)]">
        Work Recap 依赖本机已索引的 git 仓库列表。请先运行扫描，或在 CLI 执行
        <code className="mx-1 rounded bg-[var(--surface-2)] px-1.5 py-0.5 text-xs">
          ai2nao scan
        </code>
        填充 repos 表。
      </p>
      <div className="mt-4 flex items-center justify-center gap-2">
        <button
          type="button"
          onClick={onSwitchScannerCta}
          className="rounded-md border border-[var(--border)] bg-[var(--surface-2)] px-3 py-1.5 text-sm hover:bg-[var(--sidebar-hover)]"
        >
          打开仓库索引页
        </button>
      </div>
    </div>
  );
}

function HistoryList({
  runs,
  onSelect,
  selectedId,
}: {
  runs: WorkRecapRun[];
  onSelect: (id: number) => void;
  selectedId: number | null;
}) {
  if (runs.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-[var(--border)] p-4 text-xs text-[var(--fg-muted)]">
        该窗口还没有历史 recap。
      </div>
    );
  }
  return (
    <ol className="space-y-1">
      {runs.map((run) => {
        const isActive = run.id === selectedId;
        return (
          <li key={run.id}>
            <button
              type="button"
              onClick={() => onSelect(run.id)}
              className={`flex w-full items-center justify-between gap-3 rounded border px-3 py-2 text-left text-xs transition-colors ${
                isActive
                  ? "border-[var(--accent)] bg-[var(--surface-2)]"
                  : "border-[var(--border)] bg-[var(--surface)] hover:bg-[var(--surface-2)]"
              }`}
            >
              <span className="truncate">
                {formatFileTimeMs(new Date(run.generatedAt).getTime())} ·{" "}
                {WORK_MODE_LABEL[run.inference.workMode]}
              </span>
              <span className="tabular-nums text-[var(--fg-muted)]">
                {run.facts.totalCommits} commit
              </span>
            </button>
          </li>
        );
      })}
    </ol>
  );
}

export function WorkRecap() {
  const [searchParams, setSearchParams] = useSearchParams();
  const currentWindow = parseWindowParam(searchParams.get("window"));
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [inflightMessage, setInflightMessage] = useState<string | null>(null);
  const [emptyMessage, setEmptyMessage] = useState<string | null>(null);
  const queryClient = useQueryClient();

  const latest = useQuery<LatestResponse>({
    queryKey: ["work-recap", "latest", currentWindow],
    queryFn: () =>
      apiGet<LatestResponse>(`/api/work-recap/latest?window=${currentWindow}`),
  });

  const list = useQuery<ListResponse>({
    queryKey: ["work-recap", "list", currentWindow],
    queryFn: () =>
      apiGet<ListResponse>(`/api/work-recap/list?window=${currentWindow}&limit=50`),
  });

  const generate = useMutation<GenerateResponse, Error, void>({
    mutationFn: () => generateRecap(currentWindow),
    onMutate: () => {
      setInflightMessage(null);
      setEmptyMessage(null);
    },
    onSuccess: (data) => {
      if ("empty" in data) {
        setEmptyMessage("尚未发现已索引的 git 仓库，请先运行扫描。");
        return;
      }
      setSelectedId(data.run.id);
      void queryClient.invalidateQueries({ queryKey: ["work-recap"] });
    },
    onError: (err) => {
      const inflight = (err as Error & { inflight?: InflightError["body"] })
        .inflight;
      if (inflight) {
        const since = new Date(inflight.startedAt);
        setInflightMessage(
          `正在生成中（${formatFileTimeMs(since.getTime())} 起），请稍候再点。`
        );
      }
    },
  });

  const runs = list.data?.runs ?? [];
  const visibleRun = useMemo(() => {
    if (selectedId != null) {
      return runs.find((r) => r.id === selectedId) ?? latest.data?.run ?? null;
    }
    return latest.data?.run ?? null;
  }, [selectedId, runs, latest.data]);

  const isLoading = generate.isPending;
  const showEmptyReposState =
    !!emptyMessage && !visibleRun;

  return (
    <main className="mx-auto max-w-[1760px] px-8 py-6">
      <header className="mb-5 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-[var(--fg)]">工作回看</h1>
          <p className="mt-1 text-xs text-[var(--fg-muted)]">
            基于本机 git commit 的最近工作快照。事实层来自 git log，推断层由 LLM 生成且可降级。
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-2 text-xs text-[var(--fg-muted)]">
            窗口
            <select
              value={currentWindow}
              onChange={(e) => {
                const next = e.target.value as WorkRecapWindow;
                setSearchParams((prev) => {
                  const params = new URLSearchParams(prev);
                  params.set("window", next);
                  return params;
                });
                setSelectedId(null);
              }}
              className="rounded border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-sm text-[var(--fg)]"
              aria-label="时间窗口"
            >
              {WINDOWS.map((w) => (
                <option key={w.value} value={w.value}>
                  {w.label}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            onClick={() => generate.mutate()}
            disabled={isLoading}
            className="inline-flex items-center gap-1.5 rounded-md bg-[var(--accent)] px-3 py-1.5 text-sm font-medium text-white shadow-sm hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <RefreshCw className={`h-4 w-4 ${isLoading ? "animate-spin" : ""}`} />
            {isLoading ? "生成中…" : "生成 recap"}
          </button>
        </div>
      </header>

      {inflightMessage && (
        <div className="mb-4 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800 ring-1 ring-amber-200">
          {inflightMessage}
        </div>
      )}

      {emptyMessage && !showEmptyReposState && (
        <div className="mb-4 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800 ring-1 ring-amber-200">
          {emptyMessage}
        </div>
      )}

      {generate.isError && !(generate.error as Error & { inflight?: unknown }).inflight && (
        <div className="mb-4 rounded-md bg-rose-50 px-3 py-2 text-sm text-rose-800 ring-1 ring-rose-200">
          生成失败：{(generate.error as Error).message}
        </div>
      )}

      <section className="grid gap-5 lg:grid-cols-[1fr_320px]">
        <div>
          {showEmptyReposState ? (
            <EmptyReposState
              onSwitchScannerCta={() => {
                window.location.href = "/repos";
              }}
            />
          ) : visibleRun ? (
            <RecapCard run={visibleRun} />
          ) : latest.isLoading ? (
            <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-8 text-center text-sm text-[var(--fg-muted)]">
              读取中…
            </div>
          ) : (
            <div className="rounded-lg border border-dashed border-[var(--border)] bg-[var(--surface)] p-8 text-center text-sm text-[var(--fg-muted)]">
              <p>这个窗口还没生成过 recap。</p>
              <p className="mt-1">点上方「生成 recap」开始。</p>
              <Link
                to="/repos"
                className="mt-3 inline-block text-xs text-[var(--accent)] hover:underline"
              >
                先看一下已索引的 git 仓库 →
              </Link>
            </div>
          )}
        </div>

        <aside>
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--fg-muted)]">
            历史快照（{runs.length}）
          </h2>
          <HistoryList runs={runs} onSelect={setSelectedId} selectedId={selectedId} />
        </aside>
      </section>
    </main>
  );
}
