import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { apiGet } from "../api";
import { GithubHeatmap } from "../components/GithubHeatmap";
import { GithubRepoCard } from "../components/GithubRepoCard";
import { SyncStateBanner } from "../components/SyncStateBanner";
import type {
  GhHeatmapRes,
  GhRepo,
  GhReposRes,
  GhStar,
  GhStarsRes,
  GhStatusRes,
} from "../types/github";

type Tab = "repos" | "stars";

function formatDay(iso: string): string {
  return iso.slice(0, 10);
}

/**
 * 个人 GitHub 全景图 P0：
 *   · 顶部 banner 显示 token + 上次同步状态
 *   · 53 周热力图（repo 创建 + star 合并），点击某天筛选下方卡片流
 *   · 我的仓库 / 我的 star 两个 tab
 *   · 卡片流用 keyset cursor 分页，"加载更多" 按钮触发
 *
 * 数据通过 react-query 拉取并缓存，单页内切 tab / 翻页 / 清除热力图筛选
 * 不会重复打 API。
 */
export function Github() {
  const statusQ = useQuery({
    queryKey: ["github-status"],
    queryFn: () => apiGet<GhStatusRes>("/api/github/status"),
  });

  const heatmapQ = useQuery({
    queryKey: ["github-heatmap"],
    queryFn: () => apiGet<GhHeatmapRes>("/api/github/heatmap"),
    enabled: statusQ.data?.token.configured === true,
  });

  const [tab, setTab] = useState<Tab>("repos");
  const [selectedDay, setSelectedDay] = useState<string | null>(null);

  const reposQ = useInfiniteQuery({
    queryKey: ["github-repos"],
    queryFn: ({ pageParam }) => {
      const q = pageParam != null ? `?cursor=${pageParam}&per_page=30` : "?per_page=30";
      return apiGet<GhReposRes>(`/api/github/repos${q}`);
    },
    initialPageParam: null as number | null,
    getNextPageParam: (last) => last.next_cursor,
    enabled: statusQ.data?.token.configured === true,
  });

  const starsQ = useInfiniteQuery({
    queryKey: ["github-stars"],
    queryFn: ({ pageParam }) => {
      const q = pageParam
        ? `?cursor=${encodeURIComponent(pageParam)}&per_page=30`
        : "?per_page=30";
      return apiGet<GhStarsRes>(`/api/github/stars${q}`);
    },
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.next_cursor,
    enabled: statusQ.data?.token.configured === true && tab === "stars",
  });

  const allRepos = useMemo(
    () => reposQ.data?.pages.flatMap((p) => p.items) ?? [],
    [reposQ.data]
  );
  const allStars: GhStar[] = useMemo(
    () => starsQ.data?.pages.flatMap((p) => p.items) ?? [],
    [starsQ.data]
  );

  const filteredRepos = useMemo(() => {
    if (!selectedDay) return allRepos;
    return allRepos.filter((r) => formatDay(r.created_at) === selectedDay);
  }, [allRepos, selectedDay]);

  const filteredStars = useMemo(() => {
    if (!selectedDay) return allStars;
    return allStars.filter((s) => formatDay(s.starred_at) === selectedDay);
  }, [allStars, selectedDay]);

  if (statusQ.isLoading) {
    return <p className="text-[var(--muted)]">加载中…</p>;
  }
  if (statusQ.isError) {
    return (
      <div className="rounded border border-red-200 bg-red-50 p-4 text-red-800">
        {String((statusQ.error as Error).message)}
      </div>
    );
  }

  const status = statusQ.data;
  if (!status) return null;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">GitHub 个人全景</h1>
        <p className="text-sm text-[var(--muted)] mt-1">
          你创建过的仓库 + 你 star 过的仓库，按日历聚合。所有数据本地 SQLite，
          运行 <code className="bg-neutral-100 px-1 rounded">ai2nao github sync</code>{" "}
          刷新。
        </p>
      </div>

      <SyncStateBanner
        token={status.token}
        sync={status.sync}
        counts={status.counts}
      />

      {!status.token.configured ? (
        <div className="rounded border border-[var(--border)] bg-white p-4 shadow-sm text-sm text-[var(--muted)]">
          配置好 token 并运行一次{" "}
          <code className="bg-neutral-100 px-1 rounded">
            ai2nao github sync --full
          </code>{" "}
          之后回到这个页面。
        </div>
      ) : (
        <>
          {heatmapQ.data ? (
            <GithubHeatmap
              buckets={heatmapQ.data.buckets}
              selected={selectedDay}
              onSelect={setSelectedDay}
            />
          ) : heatmapQ.isLoading ? (
            <p className="text-sm text-[var(--muted)]">加载热力图…</p>
          ) : null}

          <div className="flex items-center gap-2 border-b border-[var(--border)]">
            <TabButton active={tab === "repos"} onClick={() => setTab("repos")}>
              我的仓库（{status.counts.repos}）
            </TabButton>
            <TabButton active={tab === "stars"} onClick={() => setTab("stars")}>
              我的 Star（{status.counts.stars}）
            </TabButton>
          </div>

          {tab === "repos" ? (
            <ReposList
              repos={filteredRepos}
              rawCount={allRepos.length}
              selectedDay={selectedDay}
              isLoading={reposQ.isLoading}
              isError={reposQ.isError}
              error={reposQ.error}
              hasNextPage={reposQ.hasNextPage}
              isFetchingNextPage={reposQ.isFetchingNextPage}
              fetchNextPage={() => void reposQ.fetchNextPage()}
            />
          ) : (
            <StarsList
              stars={filteredStars}
              rawCount={allStars.length}
              selectedDay={selectedDay}
              isLoading={starsQ.isLoading}
              isError={starsQ.isError}
              error={starsQ.error}
              hasNextPage={starsQ.hasNextPage}
              isFetchingNextPage={starsQ.isFetchingNextPage}
              fetchNextPage={() => void starsQ.fetchNextPage()}
            />
          )}
        </>
      )}
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        "px-3 py-2 text-sm " +
        (active
          ? "border-b-2 border-[var(--accent)] text-[var(--fg)] font-medium"
          : "text-[var(--muted)] hover:text-[var(--fg)]")
      }
    >
      {children}
    </button>
  );
}

type ListCommonProps = {
  rawCount: number;
  selectedDay: string | null;
  isLoading: boolean;
  isError: boolean;
  error: unknown;
  hasNextPage: boolean | undefined;
  isFetchingNextPage: boolean;
  fetchNextPage: () => void;
};

function ReposList(props: ListCommonProps & { repos: GhRepo[] }) {
  const { repos, rawCount, selectedDay, isLoading, isError, error, hasNextPage, isFetchingNextPage, fetchNextPage } = props;
  if (isLoading) return <p className="text-sm text-[var(--muted)]">加载中…</p>;
  if (isError) return <p className="text-sm text-red-600">{String((error as Error)?.message)}</p>;
  return (
    <div className="space-y-3">
      {selectedDay && repos.length === 0 ? (
        <p className="text-sm text-[var(--muted)]">
          {selectedDay} 当天没有匹配的仓库创建记录（当前已加载 {rawCount} 条，
          可能需要继续翻页）。
        </p>
      ) : repos.length === 0 ? (
        <p className="text-sm text-[var(--muted)]">
          暂无仓库。先运行{" "}
          <code className="bg-neutral-100 px-1 rounded">
            ai2nao github sync --full
          </code>
          。
        </p>
      ) : (
        repos.map((r) => <GithubRepoCard key={r.id} repo={r} />)
      )}
      {hasNextPage ? (
        <div>
          <button
            type="button"
            className="rounded border border-[var(--border)] px-3 py-1.5 text-sm hover:bg-neutral-50 disabled:opacity-50"
            onClick={fetchNextPage}
            disabled={isFetchingNextPage}
          >
            {isFetchingNextPage ? "加载中…" : "加载更多"}
          </button>
        </div>
      ) : null}
    </div>
  );
}

function StarsList(props: ListCommonProps & { stars: GhStar[] }) {
  const { stars, rawCount, selectedDay, isLoading, isError, error, hasNextPage, isFetchingNextPage, fetchNextPage } = props;
  if (isLoading) return <p className="text-sm text-[var(--muted)]">加载中…</p>;
  if (isError) return <p className="text-sm text-red-600">{String((error as Error)?.message)}</p>;
  return (
    <div className="space-y-3">
      {selectedDay && stars.length === 0 ? (
        <p className="text-sm text-[var(--muted)]">
          {selectedDay} 当天没有 star 记录（当前已加载 {rawCount} 条）。
        </p>
      ) : stars.length === 0 ? (
        <p className="text-sm text-[var(--muted)]">暂无 star 数据。</p>
      ) : (
        stars.map((s) => <StarCard key={s.repo_id} star={s} />)
      )}
      {hasNextPage ? (
        <div>
          <button
            type="button"
            className="rounded border border-[var(--border)] px-3 py-1.5 text-sm hover:bg-neutral-50 disabled:opacity-50"
            onClick={fetchNextPage}
            disabled={isFetchingNextPage}
          >
            {isFetchingNextPage ? "加载中…" : "加载更多"}
          </button>
        </div>
      ) : null}
    </div>
  );
}

function StarCard({ star }: { star: GhStar }) {
  return (
    <article className="rounded border border-[var(--border)] bg-white p-4 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-base font-semibold">
            <a
              className="text-[var(--accent)] hover:underline break-all"
              href={star.html_url}
              target="_blank"
              rel="noreferrer"
            >
              {star.full_name}
            </a>
          </h3>
          {star.description ? (
            <p className="mt-1 text-sm text-[var(--fg)]">{star.description}</p>
          ) : null}
        </div>
        <div className="shrink-0 text-xs text-[var(--muted)] text-right">
          <div>star 于 {star.starred_at.slice(0, 10)}</div>
          <div>★ {star.stargazers_count}</div>
          {star.language ? <div>{star.language}</div> : null}
        </div>
      </div>
      {star.topics.length > 0 ? (
        <div className="mt-3 flex flex-wrap gap-1">
          {star.topics.map((t) => (
            <span
              key={t}
              className="rounded bg-sky-50 text-sky-900 px-2 py-0.5 text-xs"
            >
              {t}
            </span>
          ))}
        </div>
      ) : null}
    </article>
  );
}
