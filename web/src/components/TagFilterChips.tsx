import type { TagFilterMode, TagHeatmapGrain } from "../types/github";

type Props = {
  selectedTags: string[];
  onRemoveTag: (tag: string) => void;
  onClearAll: () => void;
  mode: TagFilterMode;
  onModeChange: (m: TagFilterMode) => void;
  grain: TagHeatmapGrain;
  onGrainChange: (g: TagHeatmapGrain) => void;
  windowTwelveMonths: boolean;
  onWindowToggle: (v: boolean) => void;
  includeLanguageFallback: boolean;
  onIncludeLanguageToggle: (v: boolean) => void;
};

/**
 * Top control bar. All state is URL-derived — this component only emits
 * changes via callbacks. The page is the single source of truth.
 */
export function TagFilterChips({
  selectedTags,
  onRemoveTag,
  onClearAll,
  mode,
  onModeChange,
  grain,
  onGrainChange,
  windowTwelveMonths,
  onWindowToggle,
  includeLanguageFallback,
  onIncludeLanguageToggle,
}: Props) {
  return (
    <div className="rounded border border-[var(--border)] bg-white p-3 shadow-sm space-y-2">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="text-[var(--muted)] mr-1">已选：</span>
        {selectedTags.length === 0 ? (
          <span className="text-[var(--muted)]">
            （无，点击左侧 Tag 榜或下方热力图中 tag 名开始筛选）
          </span>
        ) : (
          <>
            {selectedTags.map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => onRemoveTag(t)}
                className="inline-flex items-center gap-1 bg-sky-100 text-sky-900 rounded px-2 py-0.5 hover:bg-sky-200"
                title="点击移除"
              >
                {t}
                <span aria-hidden className="text-sky-700">
                  ×
                </span>
              </button>
            ))}
            <button
              type="button"
              onClick={onClearAll}
              className="text-[var(--muted)] underline hover:text-[var(--fg)] ml-1"
            >
              清空
            </button>
          </>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-4 text-xs">
        <label className="flex items-center gap-2">
          <span className="text-[var(--muted)]">组合方式</span>
          <select
            value={mode}
            onChange={(e) => onModeChange(e.target.value as TagFilterMode)}
            className="rounded border border-[var(--border)] px-2 py-0.5"
          >
            <option value="or">OR（任一命中）</option>
            <option value="and">AND（全部命中）</option>
          </select>
        </label>
        <label className="flex items-center gap-2">
          <span className="text-[var(--muted)]">热力图粒度</span>
          <select
            value={grain}
            onChange={(e) => onGrainChange(e.target.value as TagHeatmapGrain)}
            className="rounded border border-[var(--border)] px-2 py-0.5"
          >
            <option value="month">月</option>
            <option value="quarter">季</option>
            <option value="year">年</option>
          </select>
        </label>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={windowTwelveMonths}
            onChange={(e) => onWindowToggle(e.target.checked)}
          />
          <span>仅最近 12 个月</span>
        </label>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={includeLanguageFallback}
            onChange={(e) => onIncludeLanguageToggle(e.target.checked)}
          />
          <span>
            包含 <code className="bg-neutral-100 px-1 rounded">language:*</code> 回退标签
          </span>
        </label>
      </div>
    </div>
  );
}
