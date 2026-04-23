import { describe, expect, it } from "vitest";
import {
  decodeProjectSlugToPath,
  hyphenBoundaryPrefixLengths,
  stripLeadingProjectsDash,
} from "../src/claudeCodeHistory/decodeProjectSlug.js";

describe("hyphenBoundaryPrefixLengths", () => {
  it("lists boundary lengths in ascending order", () => {
    expect(hyphenBoundaryPrefixLengths("a-b-c")).toEqual([1, 3, 5]);
  });
});

describe("stripLeadingProjectsDash", () => {
  it("removes one leading dash", () => {
    expect(stripLeadingProjectsDash("-Users-quincy")).toBe("Users-quincy");
  });
});

describe("decodeProjectSlugToPath", () => {
  it("decodes slug when directory chain exists (shortest boundary match)", () => {
    const dirs = new Set([
      "/Users",
      "/Users/quincy",
      "/Users/quincy/xunull-repository",
      "/Users/quincy/xunull-repository/github",
      "/Users/quincy/xunull-repository/github/some-encryption",
      "/Users/quincy/xunull-repository/github/some-encryption/age",
    ]);
    const existsDir = (p: string) => dirs.has(p);
    const slug =
      "-Users-quincy-xunull-repository-github-some-encryption-age";
    const r = decodeProjectSlugToPath(slug, existsDir);
    expect(r.incomplete).toBe(false);
    expect(r.path).toBe(
      "/Users/quincy/xunull-repository/github/some-encryption/age"
    );
    expect(r.segments).toEqual([
      "Users",
      "quincy",
      "xunull-repository",
      "github",
      "some-encryption",
      "age",
    ]);
  });

  it("returns incomplete when chain breaks", () => {
    const dirs = new Set(["/Users", "/Users/quincy"]);
    const r = decodeProjectSlugToPath(
      "-Users-quincy-missing-rest",
      (p) => dirs.has(p)
    );
    expect(r.incomplete).toBe(true);
    expect(r.restSuffix).toBe("missing-rest");
    expect(r.path).toBe("/Users/quincy");
  });
});
