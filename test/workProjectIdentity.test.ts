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

/**
 * kimi 无目录会话 —— 见 docs/adr/0001-kimi-unknown-project-identity.md。
 * 通用兜底会给每一场造一个独立键,而这个键是工作看板的成组依据。
 */
describe("kimi 无目录会话的兜底身份", () => {
  it("一个候选都没有时归到固定键,路径留空", () => {
    const identity = normalizeWorkProjectIdentity({
      source: "kimi",
      fallbackId: "conv-abc",
      cwd: "",
      workspacePath: "",
      workspaceId: "",
    });
    expect(identity).toEqual({ key: "kimi:unknown", path: "", confidence: "low" });
  });

  it("两场不同会话归到同一个键 —— 不这样看板上就是两行项目", () => {
    const one = normalizeWorkProjectIdentity({ source: "kimi", fallbackId: "conv-1", cwd: "" });
    const two = normalizeWorkProjectIdentity({ source: "kimi", fallbackId: "conv-2", cwd: "" });
    expect(one.key).toBe(two.key);
  });

  it("workDir 是相对路径时不算「无目录」—— 那仍是有用的信息,不该被抹成未知", () => {
    const identity = normalizeWorkProjectIdentity({
      source: "kimi",
      fallbackId: "conv-3",
      cwd: "relative/dir",
      workspacePath: "relative/dir",
      workspaceId: "relative/dir",
    });
    expect(identity).toEqual({
      key: "kimi:relative/dir",
      path: "relative/dir",
      confidence: "low",
    });
  });

  it("其余来源不受影响,照旧一场一个键", () => {
    const one = normalizeWorkProjectIdentity({ source: "codex", fallbackId: "s1", cwd: "" });
    const two = normalizeWorkProjectIdentity({ source: "codex", fallbackId: "s2", cwd: "" });
    expect(one.key).toBe("codex:s1");
    expect(two.key).toBe("codex:s2");
  });
});
