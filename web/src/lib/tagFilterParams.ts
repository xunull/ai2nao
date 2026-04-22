/**
 * Pure URL-state helpers for the /github/tags dashboard. Extracted from the
 * page component so they can be unit-tested without a React renderer or
 * jsdom environment.
 *
 * The contract is deliberately narrow: every function takes a
 * `URLSearchParams` (plus args) and returns either derived state or a NEW
 * `URLSearchParams` with the mutation applied. Callers in React-land wrap
 * these inside `setSearchParams({ replace: true })`.
 */

import type { TagFilterMode, TagHeatmapGrain } from "../types/github";

export type TagFilterState = {
  selectedTags: string[];
  mode: TagFilterMode;
  grain: TagHeatmapGrain;
  windowTwelveMonths: boolean;
  includeLanguageFallback: boolean;
  from: string | null;
  to: string | null;
};

function cloneParams(p: URLSearchParams): URLSearchParams {
  return new URLSearchParams(p);
}

/** Parse every filter knob from the URL. Missing keys map to their defaults. */
export function readTagFilterState(params: URLSearchParams): TagFilterState {
  const raw = params.get("tags") ?? "";
  const selectedTags = raw.trim()
    ? Array.from(
        new Set(
          raw
            .split(",")
            .map((t) => t.trim().toLowerCase())
            .filter((t) => t.length > 0)
        )
      )
    : [];

  const mode: TagFilterMode = params.get("mode") === "and" ? "and" : "or";
  const grainRaw = params.get("grain");
  const grain: TagHeatmapGrain =
    grainRaw === "quarter" || grainRaw === "year" ? grainRaw : "month";

  return {
    selectedTags,
    mode,
    grain,
    windowTwelveMonths: params.get("window") === "12m",
    includeLanguageFallback: params.get("include_language") === "1",
    from: (params.get("from") ?? "").trim() || null,
    to: (params.get("to") ?? "").trim() || null,
  };
}

/**
 * Toggle a tag's membership in `?tags=...`. Tag is lowercased; an empty
 * final set deletes the `tags` key entirely so shareable URLs don't carry
 * empty placeholders.
 */
export function toggleTagInParams(
  params: URLSearchParams,
  tag: string
): URLSearchParams {
  const next = cloneParams(params);
  const { selectedTags } = readTagFilterState(next);
  const lower = tag.trim().toLowerCase();
  if (!lower) return next;
  const cur = new Set(selectedTags);
  if (cur.has(lower)) cur.delete(lower);
  else cur.add(lower);
  if (cur.size === 0) next.delete("tags");
  else next.set("tags", Array.from(cur).join(","));
  return next;
}

export function removeTagFromParams(
  params: URLSearchParams,
  tag: string
): URLSearchParams {
  const next = cloneParams(params);
  const { selectedTags } = readTagFilterState(next);
  const lower = tag.trim().toLowerCase();
  const kept = selectedTags.filter((t) => t !== lower);
  if (kept.length === 0) next.delete("tags");
  else next.set("tags", kept.join(","));
  return next;
}

export function clearTagsInParams(params: URLSearchParams): URLSearchParams {
  const next = cloneParams(params);
  next.delete("tags");
  return next;
}

/**
 * Set-or-delete a scalar URL param. Passing `null` deletes the key so
 * default values don't litter the address bar (OR mode, month grain,
 * fallback-off all serialize to absence).
 */
export function setFlagInParams(
  params: URLSearchParams,
  key: string,
  value: string | null
): URLSearchParams {
  const next = cloneParams(params);
  if (value == null) next.delete(key);
  else next.set(key, value);
  return next;
}
