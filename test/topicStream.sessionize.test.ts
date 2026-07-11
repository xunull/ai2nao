import { describe, expect, it } from "vitest";
import { sessionize, type SessionVisit } from "../src/topicStream/sessionize.js";

const GAP = 1000; // us threshold for these synthetic timestamps

describe("topicStream sessionize", () => {
  it("chains a search then clicked pages into one session", () => {
    const visits: SessionVisit[] = [
      { id: 1, fromVisit: 0, visitTime: 0 }, // typed a search
      { id: 2, fromVisit: 1, visitTime: 200 }, // clicked result
      { id: 3, fromVisit: 2, visitTime: 400 }, // clicked deeper
    ];
    const s = sessionize(visits, GAP);
    expect(s.get(1)).toBe("s1");
    expect(s.get(2)).toBe("s1");
    expect(s.get(3)).toBe("s1");
  });

  it("starts a new session on from_visit=0 (fresh navigation)", () => {
    const visits: SessionVisit[] = [
      { id: 1, fromVisit: 0, visitTime: 0 },
      { id: 2, fromVisit: 0, visitTime: 100 }, // separate fresh nav
    ];
    const s = sessionize(visits, GAP);
    expect(s.get(1)).toBe("s1");
    expect(s.get(2)).toBe("s2");
  });

  it("starts a new session when the parent is archived / not in the group (dangling)", () => {
    const visits: SessionVisit[] = [
      { id: 5, fromVisit: 999, visitTime: 0 }, // 999 not present
    ];
    const s = sessionize(visits, GAP);
    expect(s.get(5)).toBe("s5");
  });

  it("breaks the session when the gap to the parent exceeds the threshold", () => {
    const visits: SessionVisit[] = [
      { id: 1, fromVisit: 0, visitTime: 0 },
      { id: 2, fromVisit: 1, visitTime: 500 }, // within gap → same
      { id: 3, fromVisit: 2, visitTime: 3000 }, // gap 2500 > 1000 → new
      { id: 4, fromVisit: 3, visitTime: 3200 }, // within gap of 3 → joins 3's session
    ];
    const s = sessionize(visits, GAP);
    expect(s.get(1)).toBe("s1");
    expect(s.get(2)).toBe("s1");
    expect(s.get(3)).toBe("s3");
    expect(s.get(4)).toBe("s3");
  });

  it("is deterministic regardless of input order", () => {
    const a: SessionVisit[] = [
      { id: 1, fromVisit: 0, visitTime: 0 },
      { id: 2, fromVisit: 1, visitTime: 100 },
    ];
    const b = [...a].reverse();
    expect([...sessionize(a, GAP).entries()].sort()).toEqual(
      [...sessionize(b, GAP).entries()].sort()
    );
  });
});
