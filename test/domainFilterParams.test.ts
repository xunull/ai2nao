import { describe, expect, it } from "vitest";
import {
  clearDomainsInParams,
  defaultDomainFromDate,
  readDomainFilterState,
  setDomainBucketRangeInParams,
  setDomainListInParams,
  setDomainParam,
  setSingleDomainInParams,
  toggleDomainInParams,
} from "../web/src/lib/domainFilterParams.js";

function p(qs: string): URLSearchParams {
  return new URLSearchParams(qs);
}

describe("domain filter URL helpers", () => {
  it("reads defaults from an empty URL", () => {
    expect(readDomainFilterState(p(""))).toEqual({
      profile: "Default",
      domains: [],
      kind: "web",
      grain: "day",
      from: null,
      to: null,
      q: null,
    });
  });

  it("normalizes and dedupes domain csv values", () => {
    const s = readDomainFilterState(p("domains=Example.com,%20a.test,example.com"));
    expect(s.domains).toEqual(["example.com", "a.test"]);
  });

  it("coerces unknown kind and grain values to defaults", () => {
    const s = readDomainFilterState(p("kind=bad&grain=quarter"));
    expect(s.kind).toBe("web");
    expect(s.grain).toBe("day");
  });

  it("toggles domains without mutating the caller params", () => {
    const start = p("domains=a.test");
    const next = toggleDomainInParams(start, "b.test");
    expect(start.get("domains")).toBe("a.test");
    expect(next.get("domains")).toBe("a.test,b.test");
    expect(toggleDomainInParams(next, "a.test").get("domains")).toBe("b.test");
  });

  it("sets, clears, and deletes scalar params", () => {
    let next = setDomainListInParams(p(""), ["A.test", "", "a.test"]);
    expect(next.get("domains")).toBe("a.test");
    next = clearDomainsInParams(next);
    expect(next.has("domains")).toBe(false);
    next = setDomainParam(next, "from", "2026-04-01");
    expect(readDomainFilterState(next).from).toBe("2026-04-01");
    next = setDomainParam(next, "from", "");
    expect(next.has("from")).toBe(false);
  });

  it("sets a single search domain without preserving older selections", () => {
    const next = setSingleDomainInParams(
      p("domains=example.com,a.test&q=agent"),
      " MP.Weixin.QQ.com "
    );
    expect(next.get("domains")).toBe("mp.weixin.qq.com");
    expect(next.get("q")).toBe("agent");
    expect(setSingleDomainInParams(next, "").has("domains")).toBe(false);
  });

  it("expands clicked timeline buckets into half-open ranges", () => {
    expect(
      setDomainBucketRangeInParams(p(""), "day", "2026-04-01").toString()
    ).toBe("from=2026-04-01&to=2026-04-02");
    expect(setDomainBucketRangeInParams(p(""), "week", "2026-04-06").get("to")).toBe(
      "2026-04-13"
    );
    expect(setDomainBucketRangeInParams(p(""), "month", "2026-04").get("to")).toBe(
      "2026-05-01"
    );
  });

  it("computes the 90-day default from a supplied clock", () => {
    expect(defaultDomainFromDate(new Date(2026, 3, 24))).toBe("2026-01-24");
  });
});
