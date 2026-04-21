import { useInfiniteQuery } from "@tanstack/react-query";
import { apiGet } from "../api";
import type { GhTaggedRepo, GhTaggedReposRes, TagFilterMode } from "../types/github";

type Props = {
  selectedTags: string[];
  mode: TagFilterMode;
  from: string | null;
  to: string | null;
};

function formatDay(iso: string): string {
  return iso.slice(0, 10);
}

function ChipList({
  topics,
  matched,
}: {
  topics: string[];
  matched: string[];
}) {
  if (topics.length === 0) return null;
  const matchedSet = new Set(matched.map((t) => t.toLowerCase()));
  return (
    <ul className="flex flex-wrap gap-1 mt-1">
      {topics.map((t) => {
        const hit = matchedSet.has(t.toLowerCase());
        return (
          <li
            key={t}
            className={
              "text-[11px] px-1.5 py-0.5 rounded " +
              (hit
                ? "bg-sky-100 text-sky-900 font-medium"
                : "bg-neutral-100 text-neutral-700")
            }
          >
            {t}
          </li>
        );
      })}
    </ul>
  );
}

function TaggedCard({ item }: { item: GhTaggedRepo }) {
  return (
    <article className="rounded border border-[var(--border)] bg-white p-3 shadow-sm">
      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold truncate">
            <a
              className="text-[var(--accent)] hover:underline"
              href={item.html_url}
              target="_blank"
              rel="noreferrer"
            >
              {item.full_name}
            </a>
          </h3>
          {item.description ? (
            <p className="text-xs text-[var(--muted)] mt-1 line-clamp-2">
              {item.description}
            </p>
          ) : null}
        </div>
        <div className="shrink-0 text-right text-[11px] text-[var(--muted)] space-y-0.5">
          <div title="star 时间">star · {formatDay(item.starred_at)}</div>
          <div>★ {item.stargazers_count.toLocaleString()}</div>
          {item.language ? <div>{item.language}</div> : null}
        </div>
      </header>
      <ChipList topics={item.topics} matched={item.matched_tags} />
    </article>
  );
}

/**
 * Infinite-scroll filtered star list. Uses keyset pagination via `cursor`.
 * Empty `selectedTags` means "no filter applied" — we render a hint instead
 * of issuing a useless request (the API would return 400-ish empty anyway).
 */
export function TaggedRepoList({ selectedTags, mode, from, to }: Props) {
  const enabled = selectedTags.length > 0;

  const q = useInfiniteQuery({
    enabled,
    queryKey: [
      "gh-tags-repos",
      selectedTags.slice().sort().join(","),
      mode,
      from,
      to,
    ],
    initialPageParam: null as string | null,
    queryFn: async ({ pageParam }) => {
      const qs = new URLSearchParams();
      qs.set("tags", selectedTags.join(","));
      qs.set("mode", mode);
      qs.set("per_page", "30");
      if (from) qs.set("from", from);
      if (to) qs.set("to", to);
      if (pageParam) qs.set("cursor", pageParam);
      return apiGet<GhTaggedReposRes>(`/api/github/tags/repos?${qs.toString()}`);
    },
    getNextPageParam: (last) => last.next_cursor,
  });

  if (!enabled) {
    return (
      <section className="rounded border border-[var(--border)] bg-white p-4 shadow-sm">
        <h2 className="text-sm font-medium mb-2">筛选结果</h2>
        <p className="text-xs text-[var(--muted)]">
          选择一个或多个 tag 以查看匹配的 star 仓库。
        </p>
      </section>
    );
  }

  const items = q.data?.pages.flatMap((p) => p.items) ?? [];
  const total = items.length;

  return (
    <section className="rounded border border-[var(--border)] bg-white p-4 shadow-sm">
      <header className="flex items-center justify-between gap-2 mb-2">
        <h2 className="text-sm font-medium">
          筛选结果{" "}
          <span className="text-[var(--muted)] font-normal">
            （{mode === "and" ? "全部包含" : "任一包含"} · 已展示 {total}
            {q.hasNextPage ? "+" : ""} 条）
          </span>
        </h2>
        {q.isFetching ? (
          <span className="text-xs text-[var(--muted)]">加载…</span>
        ) : null}
      </header>
      {q.isError ? (
        <p className="text-xs text-red-600">
          {String((q.error as Error)?.message ?? "加载失败")}
        </p>
      ) : null}
      {q.isSuccess && total === 0 ? (
        <p className="text-xs text-[var(--muted)]">
          当前筛选下没有仓库。尝试切换 AND/OR 或放宽时间窗。
        </p>
      ) : null}
      <ul className="grid grid-cols-1 gap-2">
        {items.map((item) => (
          <li key={item.repo_id}>
            <TaggedCard item={item} />
          </li>
        ))}
      </ul>
      {q.hasNextPage ? (
        <div className="mt-3 text-center">
          <button
            type="button"
            onClick={() => q.fetchNextPage()}
            disabled={q.isFetchingNextPage}
            className="text-xs rounded border border-[var(--border)] px-3 py-1 hover:bg-neutral-50 disabled:opacity-50"
          >
            {q.isFetchingNextPage ? "加载中…" : "加载更多"}
          </button>
        </div>
      ) : null}
    </section>
  );
}
