import { describe, expect, it } from "vitest";
import {
  expandPath,
  getDefaultCursorDataPath,
  normalizePath,
} from "../src/cursorHistory/platform.js";

describe("cursorHistory platform", () => {
  it("getDefaultCursorDataPath returns macOS layout on darwin", () => {
    if (process.platform !== "darwin") {
      return;
    }
    const p = getDefaultCursorDataPath("macos");
    expect(p).toContain("Cursor");
    expect(p).toContain("workspaceStorage");
  });

  it("normalizePath expands tilde", () => {
    const n = normalizePath("~/tmp");
    expect(n).not.toMatch(/^~/);
    expect(n.length).toBeGreaterThan(4);
  });

  it("expandPath handles leading tilde", () => {
    const e = expandPath("~/");
    expect(e).not.toMatch(/^~\//);
  });
});
