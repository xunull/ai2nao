import { describe, expect, it } from "vitest";
import {
  parseNumstat,
  defaultDenoise,
  COMMIT_MARK,
} from "../src/gitChurn/parseNumstat.js";

// Build a `git log --numstat --pretty=format:%x00%ad` style block.
// Each commit = COMMIT_MARK + day line, then numstat lines `added\tdeleted\tpath`.
function commit(day: string, files: Array<[string, string, string]>): string {
  return (
    COMMIT_MARK +
    day +
    "\n" +
    files.map(([a, d, p]) => `${a}\t${d}\t${p}`).join("\n")
  );
}

const denoiseNone = () => false;

describe("parseNumstat", () => {
  it("returns empty for empty input", () => {
    expect(parseNumstat("", { isDenoised: denoiseNone }).size).toBe(0);
  });

  it("sums added/deleted per day and counts the commit", () => {
    const raw = commit("2026-06-20", [
      ["10", "2", "src/a.ts"],
      ["5", "0", "src/b.ts"],
    ]);
    const m = parseNumstat(raw, { isDenoised: denoiseNone });
    expect(m.get("2026-06-20")).toEqual({ added: 15, deleted: 2, commits: 1 });
  });

  it("aggregates multiple commits across days", () => {
    const raw =
      commit("2026-06-20", [["10", "1", "a.ts"]]) +
      commit("2026-06-20", [["4", "0", "b.ts"]]) +
      commit("2026-06-21", [["7", "3", "c.ts"]]);
    const m = parseNumstat(raw, { isDenoised: denoiseNone });
    expect(m.get("2026-06-20")).toEqual({ added: 14, deleted: 1, commits: 2 });
    expect(m.get("2026-06-21")).toEqual({ added: 7, deleted: 3, commits: 1 });
  });

  it("skips binary files (`-` added/deleted) but the commit can still count via other files", () => {
    const raw = commit("2026-06-20", [
      ["-", "-", "img.png"],
      ["3", "0", "a.ts"],
    ]);
    expect(parseNumstat(raw, { isDenoised: denoiseNone }).get("2026-06-20")).toEqual({
      added: 3,
      deleted: 0,
      commits: 1,
    });
  });

  it("normalizes rename paths `dir/{old => new}/f` to the new path before denoise", () => {
    // The rename's real (new) path is dist/b.js -> should be denoised by default globs.
    const raw = commit("2026-06-20", [
      ["100", "0", "src/{a => dist}/b.js"], // new path = src/dist/b.js — not denoised by default
      ["50", "0", "x/{a.js => dist/b.js}"], // new path = x/dist/b.js
    ]);
    // With a denoise that excludes anything containing "dist/", both should drop.
    const m = parseNumstat(raw, {
      isDenoised: (p) => p.includes("dist/"),
    });
    expect(m.has("2026-06-20")).toBe(false); // both files denoised, commit contributes 0 lines
  });

  it("excludes denoised files from line counts, and a commit with only denoised files is not counted", () => {
    const raw = commit("2026-06-20", [["9999", "0", "package-lock.json"]]);
    const m = parseNumstat(raw, { isDenoised: defaultDenoise });
    expect(m.has("2026-06-20")).toBe(false); // lock file denoised -> 0 lines -> commit not counted
  });

  it("counts a commit when at least one non-denoised file contributes a line", () => {
    const raw = commit("2026-06-20", [
      ["9999", "0", "package-lock.json"], // denoised
      ["2", "1", "src/real.ts"], // real
    ]);
    expect(parseNumstat(raw, { isDenoised: defaultDenoise }).get("2026-06-20")).toEqual({
      added: 2,
      deleted: 1,
      commits: 1,
    });
  });
});

describe("defaultDenoise", () => {
  it.each([
    "package-lock.json",
    "pnpm-lock.yaml",
    "a/b/dist/bundle.js",
    "node_modules/x/index.js",
    "foo.min.js",
    "Cargo.lock",
    "__snapshots__/x.snap",
  ])("denoises %s", (p) => {
    expect(defaultDenoise(p)).toBe(true);
  });

  it.each(["src/index.ts", "README.md", "web/src/pages/X.tsx"])(
    "keeps %s",
    (p) => {
      expect(defaultDenoise(p)).toBe(false);
    }
  );
});
