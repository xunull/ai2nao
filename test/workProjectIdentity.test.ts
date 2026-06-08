import { describe, expect, it } from "vitest";
import { normalizeWorkProjectIdentity } from "../src/workProjects/identity.js";

describe("work project identity", () => {
  it("uses canonical absolute cwd as a high-confidence Codex project key", () => {
    const identity = normalizeWorkProjectIdentity({
      source: "codex",
      fallbackId: "s1",
      cwd: process.cwd(),
    });
    expect(identity).toMatchObject({
      key: process.cwd(),
      path: process.cwd(),
      confidence: "high",
    });
  });

  it("uses decoded Claude workspace path before workspace id", () => {
    const identity = normalizeWorkProjectIdentity({
      source: "claude-code",
      fallbackId: "s1",
      decodedWorkspacePath: process.cwd(),
      workspaceId: "not-a-path",
    });
    expect(identity).toMatchObject({
      key: process.cwd(),
      confidence: "high",
    });
  });

  it("falls back to source-prefixed low-confidence identity when path is not absolute", () => {
    const identity = normalizeWorkProjectIdentity({
      source: "codex",
      fallbackId: "s1",
      cwd: "relative/path",
      workspaceId: "workspace",
    });
    expect(identity).toEqual({
      key: "codex:workspace",
      path: "relative/path",
      confidence: "low",
    });
  });
});
