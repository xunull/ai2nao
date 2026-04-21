import { useQuery } from "@tanstack/react-query";
import { apiGet } from "../api";
import type { GhTopTagsRes } from "../types/github";

type Props = {
  /** Currently selected tags (controlled). Clicking a row toggles membership. */
  selectedTags: string[];
  onToggleTag: (tag: string) => void;
  /** When true, include `language:*` fallback tags in the ranking. */
  includeLanguageFallback: boolean;
  /** When true, restrict counts to the last 12 months. */
  windowTwelveMonths: boolean;
  /** Visible limit (default 50). */
  limit?: number;
};

function relativeStarDate(iso: string | null): string {
  if (!iso) return "—";
  const then = new Date(iso).getTime();
  const months = Math.floor((Date.now() - then) / (1000 * 60 * 60 * 24 * 30));
  if (months < 1) return "本月";
  if (months < 12) return `${months} 月前`;
  return `${Math.floor(months / 12)} 年前`;
}

/**
 * Left-column tag ranking. Query key includes the two filter knobs so
 * toggling them re-fetches but changing `selectedTags` does not (selection
 * is a view-only concern here — the API returns totals either way).
 */
export function TagRanking({
  selectedTags,
  onToggleTag,
  includeLanguageFallback,
  windowTwelveMonths,
  limit = 50,
}: Props) {
  const qs = new URLSearchParams();
  qs.set("limit", String(limit));
  if (windowTwelveMonths) qs.set("window", "12m");
  if (includeLanguageFallback) qs.set("include_language", "1");
  const url = `/api/github/tags/top?${qs.toString()}`;

  const q = useQuery({
    queryKey: ["gh-tags-top", includeLanguageFallback, windowTwelveMonths, limit],
    queryFn: () => apiGet<GhTopTagsRes>(url),
  });

  const selectedSet = new Set(selectedTags.map((t) => t.toLowerCase()));

  return (
    <section className="rounded border border-[var(--border)] bg-white p-3 shadow-sm">
      <header className="flex items-center justify-between gap-2 mb-2">
        <h2 className="text-sm font-medium">Tag 榜</h2>
        {q.isFetching ? (
          <span className="text-xs text-[var(--muted)]">加载…</span>
        ) : null}
      </header>
      {q.isError ? (
        <p className="text-xs text-red-600">
          {String((q.error as Error)?.message ?? "加载失败")}
        </p>
      ) : null}
      {q.data && q.data.items.length === 0 ? (
        <p className="text-xs text-[var(--muted)]">
          暂无 tag。先运行{" "}
          <code className="bg-neutral-100 px-1 rounded">
            ai2nao github sync --full
          </code>{" "}
          和{" "}
          <code className="bg-neutral-100 px-1 rounded">
            ai2nao github tags alias seed
          </code>
          。
        </p>
      ) : null}
      <ul className="max-h-[480px] overflow-y-auto -mx-1">
        {q.data?.items.map((row) => {
          const selected = selectedSet.has(row.tag.toLowerCase());
          const isFallback = row.tag.startsWith("language:");
          return (
            <li key={row.tag}>
              <button
                type="button"
                onClick={() => onToggleTag(row.tag)}
                className={
                  "w-full flex items-center justify-between gap-2 px-2 py-1 text-left rounded text-xs " +
                  (selected
                    ? "bg-sky-100 text-sky-900 font-medium"
                    : "hover:bg-neutral-100")
                }
              >
                <span className="truncate">
                  {isFallback ? (
                    <span className="text-[var(--muted)]">{row.tag}</span>
                  ) : (
                    row.tag
                  )}
                </span>
                <span className="flex items-center gap-2 shrink-0 text-[var(--muted)]">
                  <span
                    className="inline-block rounded bg-neutral-200 text-[var(--fg)] px-1.5 font-mono"
                    title={`共 ${row.count} 个 star 带有 ${row.tag}`}
                  >
                    {row.count}
                  </span>
                  <span title={row.last_starred_at ?? ""}>
                    {relativeStarDate(row.last_starred_at)}
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
