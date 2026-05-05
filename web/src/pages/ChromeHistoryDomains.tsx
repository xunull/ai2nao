import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { apiGet, apiPost } from "../api";
import {
  clearDomainsInParams,
  defaultDomainFromDate,
  readDomainFilterState,
  setDomainBucketRangeInParams,
  setDomainListInParams,
  setDomainParam,
  setSingleDomainInParams,
  type DomainTimelineGrain,
  type DomainUrlKind,
} from "../lib/domainFilterParams";
import { formatFileTimeMs } from "../util/formatDisplay";

type DomainState = {
  profile: string;
  ruleVersion: number;
  state: {
    last_rebuilt_at: string | null;
    last_error: string | null;
    source_visit_count: number;
    derived_visit_count: number;
    last_rebuild_duration_ms: number | null;
  } | null;
  currentSourceVisitCount: number;
  currentDerivedVisitCount: number;
  fresh: boolean;
  staleReasons: string[];
};

type StatusRes = {
  supported: boolean;
  profile: string;
  defaultHistoryPath: string | null;
  platform: string;
  domainStatus: DomainState;
};

type SummaryRes = {
  unique_domains: number;
  total_visits: number;
  top_domain: { domain: string; count: number } | null;
};

type TopDomain = {
  domain: string;
  count: number;
  first_visit_day: string;
  last_visit_day: string;
};

type TimelineRes = {
  xs: string[];
  ys: string[];
  cells: number[][];
};

type VisitRow = {
  visit_id: number;
  source_id: string;
  domain: string | null;
  url_kind: string;
  url: string;
  title: string | null;
  visit_time_unix_ms: number;
  calendar_day: string;
};

type VisitsRes = {
  items: VisitRow[];
  next_cursor: string | null;
};

type DomainsTab = "visits" | "timeline";

type SyncRes = {
  insertedVisits: number;
  skippedVisits: number;
  insertedDownloads: number;
  skippedDownloads: number;
  errors: string[];
  domainRebuild: { ok: boolean; derivedVisitCount: number; sourceVisitCount: number } | null;
};

const WECHAT_ARTICLE_DOMAIN = "mp.weixin.qq.com";

function enc(s: string): string {
  return encodeURIComponent(s);
}

function withParams(path: string, params: Record<string, string | null | undefined>) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v != null && v !== "") q.set(k, v);
  }
  const qs = q.toString();
  return qs ? `${path}?${qs}` : path;
}

function statusLabel(status?: DomainState): { text: string; cls: string } {
  if (!status?.state) {
    return { text: "未构建", cls: "border-amber-300 bg-amber-50 text-amber-800" };
  }
  if (status.state.last_error) {
    return { text: "重建失败", cls: "border-red-300 bg-red-50 text-red-800" };
  }
  if (!status.fresh) {
    return { text: "可能过期", cls: "border-amber-300 bg-amber-50 text-amber-800" };
  }
  return { text: "新鲜", cls: "border-emerald-300 bg-emerald-50 text-emerald-800" };
}

function reasonText(reason: string): string {
  const map: Record<string, string> = {
    not_built: "尚未构建域名透视表",
    rule_version_mismatch: "URL 归类规则已更新",
    last_rebuild_error: "上次重建失败",
    source_count_changed: "原始访问数已变化",
    derived_count_changed: "派生访问数已变化",
    source_derived_count_mismatch: "原始与派生访问数不一致",
  };
  return map[reason] ?? reason;
}

function Heatmap({
  data,
  grain,
  onCell,
}: {
  data?: TimelineRes;
  grain: DomainTimelineGrain;
  onCell: (domain: string, bucket: string) => void;
}) {
  if (!data || data.xs.length === 0 || data.ys.length === 0) {
    return <p className="text-sm text-[var(--muted)]">当前筛选范围暂无域名访问。</p>;
  }
  const cell = 18;
  const row = 28;
  const label = 154;
  const top = 28;
  const width = label + data.xs.length * cell + 16;
  const height = top + data.ys.length * row + 12;
  const max = Math.max(1, ...data.cells.flat());
  return (
    <div className="overflow-auto rounded border border-[var(--border)] bg-white">
      <svg width={width} height={height} role="img" aria-label="域名访问时间矩阵">
        {data.xs.map((x, i) => (
          <text
            key={x}
            x={label + i * cell + 8}
            y={16}
            className="fill-neutral-500 text-[10px]"
            textAnchor="middle"
          >
            {grain === "day" ? x.slice(5) : x}
          </text>
        ))}
        {data.ys.map((domain, y) => (
          <g key={domain}>
            <text
              x={8}
              y={top + y * row + 14}
              className="fill-neutral-700 text-xs"
            >
              {domain}
            </text>
            {data.xs.map((bucket, x) => {
              const value = data.cells[y][x];
              const opacity = value === 0 ? 0.06 : 0.18 + (value / max) * 0.72;
              return (
                <rect
                  key={`${domain}-${bucket}`}
                  x={label + x * cell}
                  y={top + y * row}
                  width={cell - 2}
                  height={cell - 2}
                  rx={2}
                  className="cursor-pointer fill-blue-600"
                  opacity={opacity}
                  onClick={() => onCell(domain, bucket)}
                >
                  <title>{`${domain} / ${bucket}: ${value}`}</title>
                </rect>
              );
            })}
          </g>
        ))}
      </svg>
    </div>
  );
}

export function ChromeHistoryDomains() {
  const [searchParams, setSearchParams] = useSearchParams();
  const queryClient = useQueryClient();
  const state = useMemo(
    () => readDomainFilterState(searchParams),
    [searchParams]
  );
  const [profileDraft, setProfileDraft] = useState(state.profile);
  const [busy, setBusy] = useState<"sync" | "rebuild" | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const effectiveFrom = state.from ?? defaultDomainFromDate();
  const common = {
    profile: state.profile,
    from: effectiveFrom,
    to: state.to,
    kind: state.kind,
  };
  const selectedCsv = state.domains.join(",");
  const activeDomain = state.domains[0] ?? null;
  const activeTab: DomainsTab =
    searchParams.get("tab") === "timeline" ? "timeline" : "visits";

  const status = useQuery({
    queryKey: ["chrome-history-domain-status", state.profile],
    queryFn: () =>
      apiGet<StatusRes>(
        `/api/chrome-history/domains/status?profile=${enc(state.profile)}`
      ),
  });

  const summary = useQuery({
    queryKey: ["chrome-history-domain-summary", common],
    queryFn: () =>
      apiGet<SummaryRes>(withParams("/api/chrome-history/domains/summary", common)),
  });

  const top = useQuery({
    queryKey: ["chrome-history-domain-top", common],
    queryFn: () =>
      apiGet<{ items: TopDomain[] }>(
        withParams("/api/chrome-history/domains/top", {
          ...common,
          limit: "30",
        })
      ),
  });

  const timeline = useQuery({
    queryKey: ["chrome-history-domain-timeline", common, state.grain, selectedCsv],
    queryFn: () =>
      apiGet<TimelineRes>(
        withParams("/api/chrome-history/domains/timeline", {
          ...common,
          grain: state.grain,
          top: "15",
          domains: selectedCsv || null,
        })
      ),
  });

  const visits = useQuery({
    queryKey: ["chrome-history-domain-visits", common, activeDomain, state.q],
    queryFn: () =>
      apiGet<VisitsRes>(
        withParams("/api/chrome-history/domains/visits", {
          ...common,
          domain: activeDomain,
          q: state.q,
          per_page: "50",
        })
      ),
  });

  function update(next: URLSearchParams) {
    setSearchParams(next, { replace: true });
  }

  function setScalar(key: string, value: string | null) {
    update(setDomainParam(searchParams, key, value));
  }

  function setSearchDomain(domain: string) {
    update(setSingleDomainInParams(searchParams, domain));
  }

  function setTab(tab: DomainsTab) {
    const next = new URLSearchParams(searchParams);
    if (tab === "visits") next.delete("tab");
    else next.set("tab", tab);
    update(next);
  }

  function applyProfile() {
    setScalar("profile", profileDraft.trim() || "Default");
  }

  async function refreshAfterWrite() {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["chrome-history-domain-status"] }),
      queryClient.invalidateQueries({ queryKey: ["chrome-history-domain-summary"] }),
      queryClient.invalidateQueries({ queryKey: ["chrome-history-domain-top"] }),
      queryClient.invalidateQueries({ queryKey: ["chrome-history-domain-timeline"] }),
      queryClient.invalidateQueries({ queryKey: ["chrome-history-domain-visits"] }),
    ]);
  }

  async function syncNow() {
    setBusy("sync");
    setMessage(null);
    try {
      const r = await apiPost<SyncRes>("/api/chrome-history/sync", {
        profile: state.profile,
      });
      const domainText = r.domainRebuild
        ? `域名 ${r.domainRebuild.derivedVisitCount}/${r.domainRebuild.sourceVisitCount}`
        : "域名未重建";
      const errText = r.errors.length ? ` 警告：${r.errors.join("；")}` : "";
      setMessage(
        `同步完成：访问 +${r.insertedVisits}，跳过 ${r.skippedVisits}；下载 +${r.insertedDownloads}，跳过 ${r.skippedDownloads}；${domainText}。${errText}`
      );
      await refreshAfterWrite();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  async function rebuildNow() {
    setBusy("rebuild");
    setMessage(null);
    try {
      const r = await apiPost<{
        result: { ok: boolean; derivedVisitCount: number; sourceVisitCount: number; error: string | null };
      }>("/api/chrome-history/domains/rebuild", { profile: state.profile });
      setMessage(
        r.result.ok
          ? `重建完成：${r.result.derivedVisitCount}/${r.result.sourceVisitCount} 条访问。`
          : `重建失败：${r.result.error ?? "unknown error"}`
      );
      await refreshAfterWrite();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  const badge = statusLabel(status.data?.domainStatus);
  const domainStatus = status.data?.domainStatus;
  const stale = domainStatus ? !domainStatus.fresh : true;
  const wechatMode = activeDomain === WECHAT_ARTICLE_DOMAIN;
  const visitsCount = visits.data?.items.length ?? 0;
  const activeTopDomain = activeDomain
    ? top.data?.items.find((item) => item.domain === activeDomain)
    : null;
  const scopeLabel = activeDomain ?? "全部域名";

  return (
    <div className="space-y-6">
      <header className="space-y-4">
        <div className="flex items-start justify-between gap-6">
          <div className="min-w-0">
            <h1 className="text-xl font-semibold">Chrome 域名</h1>
            <p className="mt-2 text-sm text-[var(--muted)]">
              按域名梳理本机 Chrome 访问记录，先找站点，再看页面和时间分布。
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <span className={`rounded border px-2 py-1 text-xs ${badge.cls}`}>
              {badge.text}
            </span>
            <button
              type="button"
              className="rounded bg-[var(--accent)] px-3 py-1.5 text-sm text-white disabled:opacity-50"
              onClick={() => void syncNow()}
              disabled={busy != null || status.data?.supported === false}
            >
              同步
            </button>
            <button
              type="button"
              className="rounded border border-[var(--border)] bg-white px-3 py-1.5 text-sm disabled:opacity-50"
              onClick={() => void rebuildNow()}
              disabled={busy != null}
            >
              重建
            </button>
          </div>
        </div>

        <section className="rounded border border-[var(--border)] bg-white p-4 shadow-sm">
          <div className="grid grid-cols-[minmax(220px,1fr)_minmax(320px,1.6fr)_118px_118px_110px_90px] items-end gap-3">
            <label className="text-sm">
              <span className="block text-xs text-[var(--muted)]">域名</span>
              <input
                className="mt-1 h-10 w-full rounded border border-[var(--border)] px-3 text-sm"
                placeholder="mp.weixin.qq.com"
                value={activeDomain ?? ""}
                onChange={(e) => setSearchDomain(e.target.value)}
              />
            </label>
            <label className="text-sm">
              <span className="block text-xs text-[var(--muted)]">搜索 URL / 标题</span>
              <input
                className="mt-1 h-10 w-full rounded border border-[var(--border)] px-3 text-sm"
                value={state.q ?? ""}
                onChange={(e) => setScalar("q", e.target.value)}
              />
            </label>
            <label className="text-sm">
              <span className="block text-xs text-[var(--muted)]">From</span>
              <input
                type="date"
                className="mt-1 h-10 w-full rounded border border-[var(--border)] px-2 text-sm"
                value={effectiveFrom}
                onChange={(e) => setScalar("from", e.target.value)}
              />
            </label>
            <label className="text-sm">
              <span className="block text-xs text-[var(--muted)]">To</span>
              <input
                type="date"
                className="mt-1 h-10 w-full rounded border border-[var(--border)] px-2 text-sm"
                value={state.to ?? ""}
                onChange={(e) => setScalar("to", e.target.value)}
              />
            </label>
            <label className="text-sm">
              <span className="block text-xs text-[var(--muted)]">Kind</span>
              <select
                className="mt-1 h-10 w-full rounded border border-[var(--border)] px-2 text-sm"
                value={state.kind}
                onChange={(e) => setScalar("kind", e.target.value as DomainUrlKind)}
              >
                <option value="web">Web</option>
                <option value="all">全部</option>
                <option value="localhost">Localhost</option>
                <option value="chrome">Chrome</option>
                <option value="extension">扩展</option>
                <option value="file">File</option>
                <option value="invalid">Invalid</option>
              </select>
            </label>
            <label className="text-sm">
              <span className="block text-xs text-[var(--muted)]">Grain</span>
              <select
                className="mt-1 h-10 w-full rounded border border-[var(--border)] px-2 text-sm"
                value={state.grain}
                onChange={(e) =>
                  setScalar("grain", e.target.value as DomainTimelineGrain)
                }
              >
                <option value="day">日</option>
                <option value="week">周</option>
                <option value="month">月</option>
              </select>
            </label>
          </div>
          <div className="mt-3 flex items-center justify-between gap-4 border-t border-[var(--border)] pt-3">
            <div className="flex items-center gap-3 text-sm">
              <label className="flex items-center gap-2 text-[var(--muted)]">
                Profile
                <input
                  className="h-8 w-28 rounded border border-[var(--border)] bg-white px-2 text-sm text-[var(--fg)]"
                  value={profileDraft}
                  onChange={(e) => setProfileDraft(e.target.value)}
                  onBlur={applyProfile}
                />
              </label>
              <span className="text-xs text-[var(--muted)]">
                {effectiveFrom} 至 {state.to ?? "现在"}
              </span>
              {domainStatus?.state?.last_rebuilt_at ? (
                <span className="text-xs text-[var(--muted)]">
                  上次重建 {new Date(domainStatus.state.last_rebuilt_at).toLocaleString()}
                </span>
              ) : null}
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                className="h-9 rounded border border-blue-200 bg-blue-50 px-3 text-sm text-blue-900 hover:bg-blue-100"
                onClick={() => setSearchDomain(WECHAT_ARTICLE_DOMAIN)}
              >
                微信文章
              </button>
              {state.domains.length || state.q ? (
                <button
                  type="button"
                  className="h-9 rounded border border-[var(--border)] px-3 text-sm text-[var(--accent)]"
                  onClick={() => {
                    const next = clearDomainsInParams(
                      setDomainParam(searchParams, "q", null)
                    );
                    update(next);
                  }}
                >
                  清空
                </button>
              ) : null}
            </div>
          </div>
        </section>
      </header>

      <section className="grid grid-cols-4 gap-3 text-sm">
        <div className="rounded border border-[var(--border)] bg-white px-4 py-3 shadow-sm">
          <div className="text-xs text-[var(--muted)]">域名数</div>
          <div className="mt-1 text-xl font-semibold tabular-nums">
            {summary.data?.unique_domains ?? "..."}
          </div>
        </div>
        <div className="rounded border border-[var(--border)] bg-white px-4 py-3 shadow-sm">
          <div className="text-xs text-[var(--muted)]">访问数</div>
          <div className="mt-1 text-xl font-semibold tabular-nums">
            {summary.data?.total_visits ?? "..."}
          </div>
        </div>
        <div className="rounded border border-[var(--border)] bg-white px-4 py-3 shadow-sm">
          <div className="text-xs text-[var(--muted)]">最高频域名</div>
          <div className="mt-1 truncate text-xl font-semibold">
            {summary.data?.top_domain?.domain ?? "无"}
          </div>
        </div>
        <div className="rounded border border-[var(--border)] bg-white px-4 py-3 shadow-sm">
          <div className="text-xs text-[var(--muted)]">原始/派生</div>
          <div className="mt-1 text-xl font-semibold tabular-nums">
            {domainStatus
              ? `${domainStatus.currentSourceVisitCount}/${domainStatus.currentDerivedVisitCount}`
              : "..."}
          </div>
        </div>
      </section>

      {stale ? (
        <div className="rounded border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          当前域名数据可能不是最新：
          {(domainStatus?.staleReasons ?? ["not_built"]).map(reasonText).join("；")}。
          数据区仍显示上次成功构建的结果。
        </div>
      ) : null}
      {message ? (
        <div className="rounded border border-[var(--border)] bg-white px-3 py-2 text-sm shadow-sm">
          {message}
        </div>
      ) : null}

      <nav
        className="flex items-center gap-2 border-b border-[var(--border)]"
        aria-label="Chrome 域名视图"
      >
        {[
          { key: "visits" as const, label: "访问明细" },
          { key: "timeline" as const, label: "时间矩阵" },
        ].map((tab) => (
          <button
            key={tab.key}
            type="button"
            aria-selected={activeTab === tab.key}
            className={`border-b-2 px-4 py-2 text-sm ${
              activeTab === tab.key
                ? "border-[var(--accent)] font-semibold text-[var(--fg)]"
                : "border-transparent text-[var(--muted)] hover:text-[var(--fg)]"
            }`}
            onClick={() => setTab(tab.key)}
          >
            {tab.label}
          </button>
        ))}
      </nav>

      {activeTab === "visits" ? (
        <div className={`grid grid-cols-[380px_minmax(0,1fr)] gap-6 ${stale ? "opacity-75" : ""}`}>
          <aside className="rounded border border-[var(--border)] bg-white shadow-sm">
            <div className="flex items-center justify-between border-b border-[var(--border)] px-4 py-3">
              <div>
                <h2 className="text-sm font-semibold">域名排行</h2>
                <p className="mt-1 text-xs text-[var(--muted)]">
                  点击域名筛选右侧访问记录
                </p>
              </div>
              <span className="text-xs text-[var(--muted)]">Top 30</span>
            </div>
            <div className="max-h-[44rem] overflow-auto p-2">
              {(top.data?.items ?? []).map((item) => {
                const selected = state.domains.includes(item.domain);
                return (
                  <button
                    key={item.domain}
                    type="button"
                    className={`mb-1 grid w-full grid-cols-[minmax(0,1fr)_72px] items-center gap-3 rounded px-3 py-2.5 text-left text-sm hover:bg-neutral-50 ${
                      selected ? "bg-blue-50 text-blue-950 ring-1 ring-blue-200" : ""
                    }`}
                    onClick={() =>
                      update(setSingleDomainInParams(searchParams, item.domain))
                    }
                  >
                    <span className="min-w-0 truncate">{item.domain}</span>
                    <span className="text-right tabular-nums text-[var(--muted)]">
                      {item.count}
                    </span>
                  </button>
                );
              })}
            </div>
          </aside>

          <main className="min-w-0 space-y-6">
            <section className="rounded border border-[var(--border)] bg-white shadow-sm">
              <div className="flex items-center justify-between gap-4 border-b border-[var(--border)] px-4 py-3">
                <div className="min-w-0">
                  <h2 className="text-sm font-semibold">
                    {wechatMode ? "微信文章访问" : "访问明细"}
                    {!wechatMode && activeDomain ? `：${activeDomain}` : ""}
                  </h2>
                  <p className="mt-1 truncate text-xs text-[var(--muted)]">
                    当前范围：{scopeLabel}
                  </p>
                </div>
              <span className="shrink-0 rounded bg-neutral-100 px-2 py-1 text-xs text-[var(--muted)]">
                {visitsCount} / 最多 50 条
              </span>
            </div>
              <div className="grid grid-cols-[minmax(180px,1.4fr)_repeat(3,minmax(120px,1fr))] border-b border-[var(--border)] bg-neutral-50/70 text-sm">
                <div className="border-r border-[var(--border)] px-4 py-3">
                  <div className="text-xs text-[var(--muted)]">范围</div>
                  <div className="mt-1 truncate font-medium">{scopeLabel}</div>
                </div>
                <div className="border-r border-[var(--border)] px-4 py-3">
                  <div className="text-xs text-[var(--muted)]">访问</div>
                  <div className="mt-1 font-medium tabular-nums">
                    {activeTopDomain?.count ?? visitsCount}
                  </div>
                </div>
                <div className="border-r border-[var(--border)] px-4 py-3">
                  <div className="text-xs text-[var(--muted)]">首次</div>
                  <div className="mt-1 font-medium tabular-nums">
                    {activeTopDomain?.first_visit_day ?? "—"}
                  </div>
                </div>
                <div className="px-4 py-3">
                  <div className="text-xs text-[var(--muted)]">最近</div>
                  <div className="mt-1 font-medium tabular-nums">
                    {activeTopDomain?.last_visit_day ?? "—"}
                  </div>
                </div>
              </div>
              <div className="divide-y divide-neutral-100">
                {(visits.data?.items ?? []).map((item) => (
                  <a
                    key={`${item.source_id}-${item.visit_id}`}
                    href={item.url}
                    target="_blank"
                    rel="noreferrer"
                    className="block px-4 py-3 hover:bg-neutral-50"
                  >
                    <div className="grid grid-cols-[132px_minmax(0,1fr)] gap-4">
                      <div className="text-xs text-[var(--muted)]">
                        <div className="tabular-nums">{item.calendar_day}</div>
                        <div className="mt-1 tabular-nums">
                          {formatFileTimeMs(item.visit_time_unix_ms)}
                        </div>
                      </div>
                      <div className="min-w-0">
                        <div className="truncate text-sm font-medium">
                          {item.title || item.url}
                        </div>
                        <div className="mt-1 truncate font-mono text-xs text-[var(--muted)]">
                          {item.url}
                        </div>
                      </div>
                    </div>
                  </a>
                ))}
                {visits.data?.items.length === 0 ? (
                  <p className="px-4 py-16 text-center text-sm text-[var(--muted)]">
                    {wechatMode ? "没有匹配的微信文章访问。" : "没有匹配的访问。"}
                  </p>
                ) : null}
              </div>
            </section>
          </main>
        </div>
      ) : (
        <section className={`rounded border border-[var(--border)] bg-white shadow-sm ${stale ? "opacity-75" : ""}`}>
          <div className="flex items-center justify-between border-b border-[var(--border)] px-4 py-3">
            <div>
              <h2 className="text-sm font-semibold">时间矩阵</h2>
              <p className="mt-1 text-xs text-[var(--muted)]">
                独立查看域名在时间维度上的访问密度。
              </p>
            </div>
            {state.domains.length ? (
              <button
                type="button"
                className="text-xs text-[var(--accent)]"
                onClick={() => update(clearDomainsInParams(searchParams))}
              >
                清空域名
              </button>
            ) : null}
          </div>
          <div className="p-4">
            <Heatmap
              data={timeline.data}
              grain={state.grain}
              onCell={(domain, bucket) => {
                const next = setDomainBucketRangeInParams(
                  setDomainListInParams(searchParams, [domain]),
                  state.grain,
                  bucket
                );
                update(next);
              }}
            />
          </div>
        </section>
      )}
    </div>
  );
}
