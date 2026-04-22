import { describe, expect, it } from "vitest";
import {
  clearTagsInParams,
  readTagFilterState,
  removeTagFromParams,
  setFlagInParams,
  toggleTagInParams,
} from "../web/src/lib/tagFilterParams.js";

/**
 * URL ⇄ filter-state helpers. These back the `/github/tags` dashboard's
 * URL-as-single-source-of-truth contract, so behaviour matters for:
 *   - shareable links (default-valued keys must NOT be serialized)
 *   - toggle idempotence (toggle twice = same URL)
 *   - case-normalization (all tags lowercased)
 */

function p(qs: string): URLSearchParams {
  return new URLSearchParams(qs);
}

describe("readTagFilterState", () => {
  it("returns defaults for an empty URL", () => {
    const s = readTagFilterState(p(""));
    expect(s).toEqual({
      selectedTags: [],
      mode: "or",
      grain: "month",
      windowTwelveMonths: false,
      includeLanguageFallback: false,
      from: null,
      to: null,
    });
  });

  it("parses csv tags, lowercases, and dedupes", () => {
    const s = readTagFilterState(p("tags=Python,agent,python,,%20ML%20"));
    expect(s.selectedTags).toEqual(["python", "agent", "ml"]);
  });

  it("coerces unknown mode values to 'or' and unknown grains to 'month'", () => {
    const s = readTagFilterState(p("mode=garbage&grain=week"));
    expect(s.mode).toBe("or");
    expect(s.grain).toBe("month");
  });

  it("accepts valid non-default mode/grain", () => {
    const s = readTagFilterState(p("mode=and&grain=quarter"));
    expect(s.mode).toBe("and");
    expect(s.grain).toBe("quarter");
  });

  it("parses optional flags and date range", () => {
    const s = readTagFilterState(
      p("window=12m&include_language=1&from=2024-01-01&to=2024-06-01")
    );
    expect(s.windowTwelveMonths).toBe(true);
    expect(s.includeLanguageFallback).toBe(true);
    expect(s.from).toBe("2024-01-01");
    expect(s.to).toBe("2024-06-01");
  });

  it("treats whitespace-only from/to as absent", () => {
    const s = readTagFilterState(p("from=%20&to=%20"));
    expect(s.from).toBeNull();
    expect(s.to).toBeNull();
  });

  it("does not leak partial flag values (window=other ≠ 12m)", () => {
    expect(readTagFilterState(p("window=all")).windowTwelveMonths).toBe(false);
    expect(readTagFilterState(p("include_language=0")).includeLanguageFallback).toBe(
      false
    );
  });
});

describe("toggleTagInParams", () => {
  it("adds a new tag when absent", () => {
    const next = toggleTagInParams(p(""), "Python");
    expect(next.get("tags")).toBe("python");
  });

  it("removes a tag when present", () => {
    const next = toggleTagInParams(p("tags=python,ml"), "python");
    expect(next.get("tags")).toBe("ml");
  });

  it("deletes the key entirely when toggling off the last tag", () => {
    const next = toggleTagInParams(p("tags=python"), "python");
    expect(next.has("tags")).toBe(false);
  });

  it("is idempotent: two toggles return the original set", () => {
    const start = p("tags=python,ml");
    const mid = toggleTagInParams(start, "agent");
    const back = toggleTagInParams(mid, "agent");
    expect(readTagFilterState(back).selectedTags.sort()).toEqual(
      readTagFilterState(start).selectedTags.sort()
    );
  });

  it("ignores empty/whitespace tag input", () => {
    const next = toggleTagInParams(p("tags=python"), "   ");
    expect(next.get("tags")).toBe("python");
  });

  it("does not mutate the caller's URLSearchParams", () => {
    const start = p("tags=python");
    const before = start.toString();
    toggleTagInParams(start, "ml");
    expect(start.toString()).toBe(before);
  });
});

describe("removeTagFromParams / clearTagsInParams", () => {
  it("remove only drops the named tag", () => {
    const next = removeTagFromParams(p("tags=python,ml,agent"), "ML");
    expect(next.get("tags")).toBe("python,agent");
  });

  it("remove of the last tag deletes the key", () => {
    const next = removeTagFromParams(p("tags=python"), "python");
    expect(next.has("tags")).toBe(false);
  });

  it("clear wipes the tags key but leaves other params intact", () => {
    const next = clearTagsInParams(p("tags=python&mode=and"));
    expect(next.has("tags")).toBe(false);
    expect(next.get("mode")).toBe("and");
  });
});

describe("setFlagInParams (from / to dates)", () => {
  it("round-trips YYYY-MM-DD for heatmap + list filters", () => {
    let next = setFlagInParams(p(""), "from", "2024-01-01");
    next = setFlagInParams(next, "to", "2025-01-01");
    expect(readTagFilterState(next).from).toBe("2024-01-01");
    expect(readTagFilterState(next).to).toBe("2025-01-01");
  });
});

describe("setFlagInParams", () => {
  it("sets a value", () => {
    const next = setFlagInParams(p(""), "mode", "and");
    expect(next.get("mode")).toBe("and");
  });

  it("deletes a key when value is null (default-absence invariant)", () => {
    const next = setFlagInParams(p("mode=and"), "mode", null);
    expect(next.has("mode")).toBe(false);
  });

  it("does not mutate caller", () => {
    const start = p("mode=and");
    setFlagInParams(start, "mode", null);
    expect(start.get("mode")).toBe("and");
  });
});
