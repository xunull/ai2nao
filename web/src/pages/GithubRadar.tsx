import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { apiGet, apiPost } from "../api";
import type {
  GhRadarCluster,
  GhRadarInsight,
  GhRadarInsightFeedback,
  GhRadarInsightFeedbackRes,
  GhRadarInsightRefreshRes,
  GhRadarInsightsRes,
  GhRadarOverviewRes,
  GhRadarRepo,
  GhStarNoteRes,
  GhStarNoteStatus,
  GhStatusRes,
} from "../types/github";

const STATUS_OPTIONS: Array<{ value: GhStarNoteStatus; label: string }> = [
  { value: "new", label: "新收藏" },
  { value: "reviewed", label: "已复盘" },
  { value: "try_next", label: "下一步试" },
  { value: "ignore", label: "暂不关注" },
  { value: "retired", label: "已退役" },
];

const QUEUE_LABELS: Record<keyof GhRadarOverviewRes["queues"], string> = {
  missing_reason: "待补理由",
  needs_review: "需要复盘",
  stale: "可能过期",
  try_next: "下一步试",
  recently_starred: "最近收藏",
};

function formatDay(iso: string | null): string {
  if (!iso) return "—";
  return iso.slice(0, 10);
}

function statusLabel(status: GhStarNoteStatus): string {
  return STATUS_OPTIONS.find((s) => s.value === status)?.label ?? status;
}

/**
 * GitHub Open Source Radar.
 *
 * Data shape:
 *   gh_star + gh_repo_tag + gh_star_note
 *        │          │             │
 *        └──────────┴─────LEFT JOIN┘
 *                   │
 *         /api/github/radar
 *                   │
 *       clusters + review queues
 *
 * Local note writes only touch ai2nao SQLite through
 * `/api/github/radar/notes/:repo_id`; nothing here writes to GitHub.
 */
export function GithubRadar() {
  const statusQ = useQuery({
    queryKey: ["github-status"],
    queryFn: () => apiGet<GhStatusRes>("/api/github/status"),
  });
  const radarQ = useQuery({
    queryKey: ["github-radar"],
    queryFn: () => apiGet<GhRadarOverviewRes>("/api/github/radar"),
    enabled: statusQ.data?.token.configured === true,
  });
  const insightsQ = useQuery({
    queryKey: ["github-radar-insights"],
    queryFn: () => apiGet<GhRadarInsightsRes>("/api/github/radar/insights"),
    enabled: statusQ.data?.token.configured === true,
  });

  if (statusQ.isLoading) {
    return <p className="text-sm text-[var(--muted)]">加载中…</p>;
  }
  if (statusQ.isError) {
    return <ErrorBox message={String((statusQ.error as Error).message)} />;
  }

  const status = statusQ.data;
  if (!status) return null;

  return (
    <div className="space-y-5">
      <header className="space-y-1">
        <h1 className="text-xl font-semibold">开源雷达</h1>
        <p className="text-sm text-[var(--muted)]">
          让 GitHub Star 变成可复盘的本地技术记忆：理由、状态、过期信号和主题方向。
        </p>
      </header>

      {!status.token.configured ? (
        <section className="rounded border border-[var(--border)] bg-white p-4 shadow-sm text-sm text-[var(--muted)]">
          配置好 token 并运行一次{" "}
          <code className="bg-neutral-100 px-1 rounded">
            ai2nao github sync --full
          </code>{" "}
          之后回到这个页面。
        </section>
      ) : radarQ.isLoading ? (
        <p className="text-sm text-[var(--muted)]">加载雷达…</p>
      ) : radarQ.isError || insightsQ.isError ? (
        <ErrorBox
          message={String(
            ((radarQ.error ?? insightsQ.error) as Error | null)?.message ??
              "加载雷达失败"
          )}
        />
      ) : radarQ.data && insightsQ.data ? (
        <RadarBody data={radarQ.data} insights={insightsQ.data} />
      ) : null}
    </div>
  );
}

function RadarBody({
  data,
  insights,
}: {
  data: GhRadarOverviewRes;
  insights: GhRadarInsightsRes;
}) {
  const totalQueued = useMemo(
    () =>
      data.counts.missing_reason +
      data.counts.needs_review +
      data.counts.stale +
      data.counts.try_next,
    [data.counts]
  );

  if (data.counts.total_stars === 0) {
    return (
      <section className="rounded border border-[var(--border)] bg-white p-4 shadow-sm text-sm text-[var(--muted)]">
        还没有 Star 数据。运行{" "}
        <code className="bg-neutral-100 px-1 rounded">ai2nao github sync --full</code>{" "}
        后再查看雷达。
      </section>
    );
  }

  return (
    <div className="space-y-5">
      <InsightStatusBar insights={insights} />
      <CurrentClues insights={insights} />
      <SecondaryInsightSections insights={insights} />
      <details className="rounded border border-[var(--border)] bg-white p-4 shadow-sm">
        <summary className="cursor-pointer text-sm font-medium">
          旧雷达队列 · 待补 {data.counts.missing_reason} · 复盘{" "}
          {data.counts.needs_review} · 过期 {data.counts.stale} · 下一步{" "}
          {data.counts.try_next}
        </summary>
        <div className="mt-4 space-y-4">
          <section className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-8 gap-2">
            <Metric label="Star" value={data.counts.total_stars} />
            <Metric label="待补理由" value={data.counts.missing_reason} />
            <Metric label="需复盘" value={data.counts.needs_review} />
            <Metric label="过期" value={data.counts.stale} />
            <Metric label="归档" value={data.counts.archived} />
            <Metric label="最近收藏" value={data.counts.recently_starred} />
            <Metric label="最近活跃" value={data.counts.active_recently} />
            <Metric label="行动队列" value={totalQueued} />
          </section>
          <div className="grid grid-cols-1 lg:grid-cols-[320px_minmax(0,1fr)] gap-4">
            <div className="space-y-4">
              <ClusterPanel title="主题方向" clusters={data.clusters} />
              <ClusterPanel title="仅语言分组" clusters={data.language_only} muted />
            </div>
            <QueuePanel queues={data.queues} />
          </div>
        </div>
      </details>
    </div>
  );
}

function InsightStatusBar({ insights }: { insights: GhRadarInsightsRes }) {
  const queryClient = useQueryClient();
  const refresh = useMutation({
    mutationFn: () =>
      apiPost<GhRadarInsightRefreshRes>("/api/github/radar/insights/refresh", {}),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["github-radar-insights"] });
    },
  });
  const status = refresh.isPending ? "refresh_in_progress" : insights.meta.status;
  return (
    <section
      role="status"
      className="rounded border border-[var(--border)] bg-white px-4 py-3 shadow-sm"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <Badge>{statusLabelForInsight(status)}</Badge>
            <span className="text-sm text-[var(--fg)]">
              {statusMessage(status)}
            </span>
          </div>
          <div className="mt-1 text-xs text-[var(--muted)]">
            {insights.meta.generated_at
              ? `已更新 ${formatDay(insights.meta.generated_at)} · ${insights.meta.metrics?.insight_count ?? 0} 条线索 · ${insights.meta.metrics?.duration_ms ?? 0}ms`
              : "尚未生成洞察快照"}
          </div>
          {insights.meta.warnings.length > 0 ? (
            <ul className="mt-2 space-y-1 text-xs text-amber-700">
              {insights.meta.warnings.map((w) => (
                <li key={`${w.code}-${w.message}`}>{w.message}</li>
              ))}
            </ul>
          ) : null}
          {refresh.isError ? (
            <p className="mt-2 text-xs text-red-600">
              {String((refresh.error as Error)?.message ?? "刷新失败")}
            </p>
          ) : null}
        </div>
        <button
          type="button"
          className="min-h-10 rounded bg-[var(--accent)] px-3 py-1.5 text-sm text-white disabled:opacity-50"
          disabled={refresh.isPending}
          onClick={() => refresh.mutate()}
        >
          {refresh.isPending ? "刷新中" : insights.meta.status === "error" ? "重试刷新" : "刷新线索"}
        </button>
      </div>
    </section>
  );
}

function CurrentClues({ insights }: { insights: GhRadarInsightsRes }) {
  if (insights.meta.status === "empty") {
    return (
      <section className="rounded border border-[var(--border)] bg-white p-4 shadow-sm text-sm text-[var(--muted)]">
        开源雷达需要本地 GitHub Star 数据。先运行{" "}
        <code className="bg-neutral-100 px-1 rounded">ai2nao github sync --full</code>{" "}
        ，再回来生成线索。同步只写入本地 SQLite，不会修改 GitHub。
      </section>
    );
  }
  if (insights.current_clues.length === 0) {
    return (
      <section className="rounded border border-[var(--border)] bg-white p-4 shadow-sm text-sm text-[var(--muted)]">
        目前没有足够强的当前工作线索。可以刷新一次，或先继续保留旧雷达队列。
      </section>
    );
  }
  return (
    <section className="space-y-3">
      <h2 className="text-sm font-medium">现在值得看的线索</h2>
      {insights.current_clues.map((insight) => (
        <InsightCard key={insight.fingerprint} insight={insight} />
      ))}
    </section>
  );
}

function SecondaryInsightSections({ insights }: { insights: GhRadarInsightsRes }) {
  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
      <InsightList title="重新变得有用" items={insights.rediscovered} />
      <InsightList title="可能该降级关注" items={insights.retire_candidates} />
      <section className="rounded border border-[var(--border)] bg-white p-4 shadow-sm">
        <h2 className="text-sm font-medium">技术品味画像</h2>
        {insights.taste_profile ? (
          <div className="mt-3">
            <p className="text-sm">{insights.taste_profile.title}</p>
            <div className="mt-2 flex flex-wrap gap-1">
              {insights.taste_profile.terms.map((t) => (
                <Badge key={t}>{t}</Badge>
              ))}
            </div>
          </div>
        ) : (
          <p className="mt-2 text-sm text-[var(--muted)]">暂无足够主题数据。</p>
        )}
      </section>
    </div>
  );
}

function InsightList({
  title,
  items,
}: {
  title: string;
  items: GhRadarInsight[];
}) {
  return (
    <section className="rounded border border-[var(--border)] bg-white p-4 shadow-sm">
      <h2 className="text-sm font-medium">{title}</h2>
      {items.length === 0 ? (
        <p className="mt-2 text-sm text-[var(--muted)]">暂无线索。</p>
      ) : (
        <ul className="mt-3 space-y-2">
          {items.slice(0, 4).map((insight) => (
            <li key={insight.fingerprint} className="text-sm">
              <div className="font-medium">{insight.title}</div>
              <div className="mt-1 text-xs text-[var(--muted)]">
                {evidenceSummary(insight)}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function InsightCard({ insight }: { insight: GhRadarInsight }) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const feedback = useMutation({
    mutationFn: (value: GhRadarInsightFeedback) =>
      apiPost<GhRadarInsightFeedbackRes>("/api/github/radar/insights/feedback", {
        target_type: "insight",
        target_id: insight.fingerprint,
        feedback: value,
        insight_fingerprint: insight.fingerprint,
        repo_id: insight.repo_ids[0] ?? null,
        terms: insight.terms,
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["github-radar-insights"] });
    },
  });
  const drawerId = `evidence-${insight.fingerprint}`;
  return (
    <article className="rounded border border-[var(--border)] bg-white p-4 shadow-sm">
      <header className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <Badge>{healthLabel(insight.health)}</Badge>
          <Badge>{kindLabel(insight.kind)}</Badge>
          <span className="text-xs text-[var(--muted)]">
            score {insight.score}
          </span>
        </div>
        <h3 className="text-base font-semibold">{insight.title}</h3>
        <p className="text-sm text-[var(--muted)]">{insight.summary}</p>
        <div className="text-xs text-[var(--muted)]">
          {evidenceSummary(insight)}
        </div>
      </header>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={drawerId}
          className="min-h-10 rounded border border-[var(--border)] px-3 py-1.5 text-sm hover:bg-neutral-50"
          onClick={() => setOpen((v) => !v)}
        >
          {open ? "收起证据" : "查看证据"}
        </button>
        {(["useful", "wrong", "later", "ignore"] as GhRadarInsightFeedback[]).map(
          (value) => (
            <button
              key={value}
              type="button"
              className="min-h-10 rounded border border-[var(--border)] px-3 py-1.5 text-sm hover:bg-neutral-50 disabled:opacity-50"
              disabled={feedback.isPending}
              onClick={() => feedback.mutate(value)}
            >
              {feedbackLabel(value)}
            </button>
          )
        )}
      </div>
      {feedback.isError ? (
        <p className="mt-2 text-xs text-red-600">
          {String((feedback.error as Error)?.message ?? "反馈失败")}
        </p>
      ) : null}
      {open ? (
        <div
          id={drawerId}
          className="mt-3 rounded border border-[var(--border)] bg-neutral-50 p-3"
        >
          <p className="text-xs text-[var(--muted)]">{insight.health_reason}</p>
          <ul className="mt-2 space-y-2">
            {insight.evidence.map((e, idx) => (
              <li key={`${e.source_kind}-${idx}`} className="text-sm">
                <div className="font-medium">
                  {sourceKindLabel(e.source_kind)} · {e.label}
                </div>
                <div className="mt-1 text-xs text-[var(--muted)]">
                  {e.source_path ? `${e.source_path} · ` : ""}
                  weight {e.weight}
                </div>
                {e.matched_terms.length > 0 ? (
                  <div className="mt-1 flex flex-wrap gap-1">
                    {e.matched_terms.map((t) => (
                      <Badge key={t}>{t}</Badge>
                    ))}
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </article>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded border border-[var(--border)] bg-white p-3 shadow-sm">
      <div className="text-[11px] text-[var(--muted)]">{label}</div>
      <div className="mt-1 text-xl font-semibold tabular-nums">{value}</div>
    </div>
  );
}

function ClusterPanel({
  title,
  clusters,
  muted = false,
}: {
  title: string;
  clusters: GhRadarCluster[];
  muted?: boolean;
}) {
  return (
    <section className="rounded border border-[var(--border)] bg-white p-4 shadow-sm">
      <h2 className="text-sm font-medium">{title}</h2>
      {clusters.length === 0 ? (
        <p className="mt-2 text-xs text-[var(--muted)]">暂无分组。</p>
      ) : (
        <ul className="mt-3 space-y-2">
          {clusters.map((c) => (
            <li key={c.tag} className="rounded border border-[var(--border)] p-2">
              <div className="flex items-center justify-between gap-2">
                <span
                  className={
                    "text-sm font-medium break-all " +
                    (muted ? "text-[var(--muted)]" : "text-[var(--fg)]")
                  }
                >
                  {c.tag}
                </span>
                <span className="text-xs tabular-nums text-[var(--muted)]">
                  {c.count}
                </span>
              </div>
              <div className="mt-1 flex flex-wrap gap-1 text-[11px] text-[var(--muted)]">
                <span>待补 {c.missing_reason_count}</span>
                <span>复盘 {c.needs_review_count}</span>
                <span>过期 {c.stale_count}</span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function QueuePanel({ queues }: { queues: GhRadarOverviewRes["queues"] }) {
  const [active, setActive] = useState<keyof GhRadarOverviewRes["queues"]>("missing_reason");
  const items = queues[active];
  return (
    <section className="rounded border border-[var(--border)] bg-white p-4 shadow-sm">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-sm font-medium">复盘队列</h2>
        <div className="flex flex-wrap gap-1">
          {(Object.keys(queues) as Array<keyof GhRadarOverviewRes["queues"]>).map((key) => (
            <button
              key={key}
              type="button"
              onClick={() => setActive(key)}
              className={
                "rounded border px-2 py-1 text-xs " +
                (active === key
                  ? "border-[var(--accent)] bg-blue-50 text-[var(--fg)]"
                  : "border-[var(--border)] text-[var(--muted)] hover:bg-neutral-50")
              }
            >
              {QUEUE_LABELS[key]} {queues[key].length}
            </button>
          ))}
        </div>
      </header>

      {items.length === 0 ? (
        <p className="mt-4 text-sm text-[var(--muted)]">这个队列目前为空。</p>
      ) : (
        <ul className="mt-4 space-y-3">
          {items.map((repo) => (
            <li key={repo.repo_id}>
              <RadarRepoCard repo={repo} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function RadarRepoCard({ repo }: { repo: GhRadarRepo }) {
  const queryClient = useQueryClient();
  const [reason, setReason] = useState(repo.note?.reason ?? "");
  const [status, setStatus] = useState<GhStarNoteStatus>(repo.effective_status);
  const [lastSavedReason, setLastSavedReason] = useState(repo.note?.reason ?? "");
  const [lastSavedStatus, setLastSavedStatus] = useState<GhStarNoteStatus>(
    repo.effective_status
  );

  useEffect(() => {
    const nextReason = repo.note?.reason ?? "";
    setReason(nextReason);
    setStatus(repo.effective_status);
    setLastSavedReason(nextReason);
    setLastSavedStatus(repo.effective_status);
  }, [repo.effective_status, repo.note?.reason]);

  const save = useMutation({
    mutationFn: () =>
      apiPost<GhStarNoteRes>(`/api/github/radar/notes/${repo.repo_id}`, {
        reason,
        status,
        last_reviewed_at: status === "reviewed" ? new Date().toISOString() : repo.note?.last_reviewed_at ?? null,
      }),
    onSuccess: async (res) => {
      setLastSavedReason(res.note.reason);
      setLastSavedStatus(res.note.status);
      await queryClient.invalidateQueries({ queryKey: ["github-radar"] });
    },
  });

  const dirty = reason !== lastSavedReason || status !== lastSavedStatus;

  return (
    <article className="rounded border border-[var(--border)] p-3">
      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold break-all">
            <a
              className="text-[var(--accent)] hover:underline"
              href={repo.html_url}
              target="_blank"
              rel="noreferrer"
            >
              {repo.full_name}
            </a>
          </h3>
          {repo.description ? (
            <p className="mt-1 text-xs text-[var(--muted)]">{repo.description}</p>
          ) : null}
        </div>
        <div className="shrink-0 text-right text-[11px] text-[var(--muted)]">
          <div>star · {formatDay(repo.starred_at)}</div>
          <div>push · {formatDay(repo.pushed_at)}</div>
        </div>
      </header>

      <div className="mt-2 flex flex-wrap gap-1">
        <Badge>{statusLabel(repo.effective_status)}</Badge>
        {repo.signals.map((s) => (
          <Badge key={s}>{signalLabel(s)}</Badge>
        ))}
      </div>

      <div className="mt-3 grid grid-cols-1 md:grid-cols-[minmax(0,1fr)_11rem_auto] gap-2 items-end">
        <label className="flex flex-col gap-1 text-xs text-[var(--muted)]">
          收藏理由
          <textarea
            aria-label={`收藏理由 ${repo.full_name}`}
            className="min-h-20 rounded border border-[var(--border)] px-2 py-1.5 text-sm text-[var(--fg)]"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-[var(--muted)]">
          状态
          <select
            aria-label={`状态 ${repo.full_name}`}
            className="min-h-10 rounded border border-[var(--border)] px-2 py-1.5 text-sm text-[var(--fg)]"
            value={status}
            onChange={(e) => setStatus(e.target.value as GhStarNoteStatus)}
          >
            {STATUS_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className="min-h-10 rounded border border-[var(--border)] px-3 py-1.5 text-sm hover:bg-neutral-50 disabled:opacity-50"
          disabled={!dirty || save.isPending}
          onClick={() => save.mutate()}
        >
          {save.isPending ? "保存中…" : "保存"}
        </button>
      </div>

      {save.isError ? (
        <p className="mt-2 text-xs text-red-600">
          {String((save.error as Error)?.message ?? "保存失败")}
        </p>
      ) : save.isSuccess && !dirty ? (
        <p className="mt-2 text-xs text-[var(--muted)]">已保存</p>
      ) : null}
    </article>
  );
}

function Badge({ children }: { children: string }) {
  return (
    <span className="rounded bg-neutral-100 px-1.5 py-0.5 text-[11px] text-neutral-700">
      {children}
    </span>
  );
}

function signalLabel(signal: string): string {
  switch (signal) {
    case "archived":
      return "已归档";
    case "stale":
      return "过期";
    case "needs_review":
      return "需复盘";
    case "missing_reason":
      return "缺理由";
    case "recently_starred":
      return "最近收藏";
    case "active_recently":
      return "近期活跃";
    default:
      return signal;
  }
}

function statusLabelForInsight(status: string): string {
  switch (status) {
    case "fresh":
      return "已更新";
    case "stale":
      return "可能过期";
    case "partial":
      return "部分更新";
    case "empty":
      return "无数据";
    case "error":
      return "出错";
    case "refresh_in_progress":
      return "刷新中";
    default:
      return status;
  }
}

function statusMessage(status: string): string {
  switch (status) {
    case "fresh":
      return "线索已更新，基于本地 Star、topics 和当前工作上下文。";
    case "stale":
      return "当前工作上下文已变化，这些线索可能需要重新生成。";
    case "partial":
      return "部分上下文读取失败，线索仍可参考，但证据不完整。";
    case "empty":
      return "还没有 Star 数据。先运行 GitHub sync，再生成线索。";
    case "error":
      return "这次没有生成新线索。旧线索仍保留，修复后可重试。";
    case "refresh_in_progress":
      return "正在生成线索，当前页面先保留已有结果。";
    default:
      return status;
  }
}

function evidenceSummary(insight: GhRadarInsight): string {
  const kinds = [...new Set(insight.evidence.map((e) => sourceKindLabel(e.source_kind)))];
  return `${insight.evidence.length} 个证据 · ${healthLabel(insight.health)} · ${kinds.slice(0, 3).join(" / ") || "repo"}`;
}

function healthLabel(health: string): string {
  switch (health) {
    case "strong":
      return "strong";
    case "partial":
      return "partial";
    case "weak":
      return "weak";
    case "stale":
      return "stale";
    case "suppressed":
      return "suppressed";
    default:
      return health;
  }
}

function kindLabel(kind: string): string {
  switch (kind) {
    case "recommended_now":
      return "当前线索";
    case "rediscovered":
      return "重新发现";
    case "retire_candidate":
      return "降级候选";
    case "taste_profile":
      return "品味画像";
    default:
      return kind;
  }
}

function feedbackLabel(feedback: GhRadarInsightFeedback): string {
  switch (feedback) {
    case "useful":
      return "有用";
    case "wrong":
      return "不准";
    case "later":
      return "以后看";
    case "ignore":
      return "忽略";
  }
}

function sourceKindLabel(kind: string): string {
  switch (kind) {
    case "todo":
      return "TODO";
    case "doc":
      return "docs";
    case "git_commit":
      return "commit";
    case "branch":
      return "branch";
    case "repo_fact":
      return "repo";
    case "topic":
      return "topics";
    case "feedback":
      return "feedback";
    default:
      return kind;
  }
}

function ErrorBox({ message }: { message: string }) {
  return (
    <div className="rounded border border-red-200 bg-red-50 p-4 text-sm text-red-800">
      {message}
    </div>
  );
}
