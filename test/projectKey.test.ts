import { describe, expect, it } from "vitest";
import { slugFromPath } from "../src/agentUserMessages/projectKey.js";

// 用通用占位路径(公开仓库,别写真实 home 路径 —— gitleaks local-home-path 会拦)。
describe("slugFromPath — 路径 → claude 风格 project slug", () => {
  it("绝对路径:每个 / 换 -(含前导)", () => {
    expect(slugFromPath("/abs/path/to/ai2nao")).toBe("-abs-path-to-ai2nao");
  });

  it("多段路径", () => {
    expect(slugFromPath("/w/x/y/z/repo-name")).toBe("-w-x-y-z-repo-name");
  });

  it("去尾斜杠", () => {
    expect(slugFromPath("/w/x/ai2nao/")).toBe("-w-x-ai2nao");
    expect(slugFromPath("/w/x/ai2nao///")).toBe("-w-x-ai2nao");
  });

  it("段内的点保留(不当分隔符)", () => {
    expect(slugFromPath("/w/x/my.app")).toBe("-w-x-my.app");
  });

  it("空 / null / 相对路径 / 根 → null(无法归属)", () => {
    expect(slugFromPath(null)).toBeNull();
    expect(slugFromPath(undefined)).toBeNull();
    expect(slugFromPath("")).toBeNull();
    expect(slugFromPath("  ")).toBeNull();
    expect(slugFromPath("relative/path")).toBeNull();
    expect(slugFromPath("/")).toBeNull();
  });
});
