import { useCallback } from "react";
import { useSearchParams } from "react-router-dom";
import { TagFilterChips } from "../components/TagFilterChips";
import { TagRanking } from "../components/TagRanking";
import { TagTimeHeatmap } from "../components/TagTimeHeatmap";
import { TaggedRepoList } from "../components/TaggedRepoList";
import {
  clearTagsInParams,
  readTagFilterState,
  removeTagFromParams,
  setFlagInParams,
  toggleTagInParams,
} from "../lib/tagFilterParams";

/**
 * Three-stack parallel dashboard for star tag pivoting.
 *
 * URL is the single source of truth for all filter state:
 *   tags=python,agent,ml   (csv, lowercase canonical)
 *   mode=or|and            (default or)
 *   grain=month|quarter|year (default month)
 *   window=12m             (optional — restricts tag ranking to last 12 months)
 *   from=YYYY-MM-DD        (optional — used by heatmap + repo list)
 *   to=YYYY-MM-DD          (optional)
 *   include_language=1     (optional — include `language:*` fallback tags)
 *
 * Rationale for URL-as-state: users should be able to share a snapshot of
 * "what I star-tagged in 2024 that involves python + agent" by copy-pasting
 * a URL. Also survives reloads without needing a local persistence layer.
 */
export function GithubTags() {
  const [params, setParams] = useSearchParams();
  const state = readTagFilterState(params);
  const {
    selectedTags,
    mode,
    grain,
    windowTwelveMonths,
    includeLanguageFallback,
    from,
    to,
  } = state;

  const replace = useCallback(
    (next: URLSearchParams) => setParams(next, { replace: true }),
    [setParams]
  );

  const toggleTag = useCallback(
    (tag: string) => replace(toggleTagInParams(params, tag)),
    [params, replace]
  );
  const removeTag = useCallback(
    (tag: string) => replace(removeTagFromParams(params, tag)),
    [params, replace]
  );
  const clearAll = useCallback(
    () => replace(clearTagsInParams(params)),
    [params, replace]
  );
  const setFlag = useCallback(
    (key: string, value: string | null) =>
      replace(setFlagInParams(params, key, value)),
    [params, replace]
  );

  return (
    <div className="space-y-4">
      <header className="space-y-1">
        <h1 className="text-xl font-semibold">Star 标签透视</h1>
        <p className="text-xs text-[var(--muted)]">
          三联视图：左侧 Tag 榜 · 右上 Tag × 时间热力图 · 下方筛选结果。点击任意 tag 即可加入筛选；
          <code className="mx-1 bg-neutral-100 px-1 rounded">language:*</code>
          回退标签默认隐藏，可在上方开启。
        </p>
      </header>

      <TagFilterChips
        selectedTags={selectedTags}
        onRemoveTag={removeTag}
        onClearAll={clearAll}
        mode={mode}
        onModeChange={(m) => setFlag("mode", m === "or" ? null : m)}
        grain={grain}
        onGrainChange={(g) => setFlag("grain", g === "month" ? null : g)}
        windowTwelveMonths={windowTwelveMonths}
        onWindowToggle={(v) => setFlag("window", v ? "12m" : null)}
        includeLanguageFallback={includeLanguageFallback}
        onIncludeLanguageToggle={(v) =>
          setFlag("include_language", v ? "1" : null)
        }
      />

      <div className="grid grid-cols-1 lg:grid-cols-[260px_minmax(0,1fr)] gap-4">
        <TagRanking
          selectedTags={selectedTags}
          onToggleTag={toggleTag}
          includeLanguageFallback={includeLanguageFallback}
          windowTwelveMonths={windowTwelveMonths}
        />
        <TagTimeHeatmap
          grain={grain}
          from={from}
          to={to}
          includeLanguageFallback={includeLanguageFallback}
          selectedTags={selectedTags}
          onToggleTag={toggleTag}
        />
      </div>

      <TaggedRepoList
        selectedTags={selectedTags}
        mode={mode}
        from={from}
        to={to}
      />
    </div>
  );
}
