import { describe, expect, it } from "vitest";
import {
  ALL_PROJECTS,
  groupByProject,
  matchesQuery,
  projectPanel,
  sessionsForProject,
  type KimiGroupableSession,
} from "../web/src/kimiHistory/grouping.js";

const s = (
  sessionId: string,
  projectPath: string,
  lastUpdatedAt: string,
  extra: Partial<KimiGroupableSession> = {}
): KimiGroupableSession => ({
  sessionId,
  title: extra.title ?? `会话 ${sessionId}`,
  projectKey: extra.projectKey ?? (projectPath === "" ? "kimi:unknown" : projectPath),
  projectPath,
  preview: extra.preview ?? "",
  lastUpdatedAt,
});

const A = "/repo/alpha";
const B = "/repo/beta";

describe("groupByProject", () => {
  it("按项目聚合并数会话", () => {
    const groups = groupByProject([
      s("1", A, "2026-09-01T00:00:00Z"),
      s("2", A, "2026-09-03T00:00:00Z"),
      s("3", B, "2026-09-02T00:00:00Z"),
    ]);
    expect(groups.map((g) => [g.label, g.sessionCount])).toEqual([
      ["alpha", 2],
      ["beta", 1],
    ]);
  });

  it("组的时间取组内最新的一场,排序按它倒序", () => {
    const groups = groupByProject([
      s("1", A, "2026-09-01T00:00:00Z"),
      s("2", B, "2026-09-02T00:00:00Z"),
      s("3", A, "2026-09-09T00:00:00Z"),
    ]);
    expect(groups[0]).toMatchObject({ label: "alpha", lastUpdatedAt: "2026-09-09T00:00:00Z" });
    expect(groups[1]!.label).toBe("beta");
  });

  it("「(未知项目)」固定置底,即使它是最近活跃的", () => {
    const groups = groupByProject([
      s("1", A, "2026-01-01T00:00:00Z"),
      s("2", "", "2026-12-31T00:00:00Z"),
      s("3", B, "2026-02-01T00:00:00Z"),
    ]);
    expect(groups.map((g) => g.label)).toEqual(["beta", "alpha", "(未知项目)"]);
    expect(groups[2]).toMatchObject({ isUnknown: true, path: "" });
  });

  it("所有无目录会话并成一组 —— 它们共用 kimi:unknown 这个键", () => {
    const groups = groupByProject([
      s("1", "", "2026-09-01T00:00:00Z"),
      s("2", "", "2026-09-02T00:00:00Z"),
      s("3", "", "2026-09-03T00:00:00Z"),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.sessionCount).toBe(3);
  });

  it("时间戳解析不出来时当 0,不炸也不乱序", () => {
    const groups = groupByProject([s("1", A, "看不懂"), s("2", B, "2026-09-02T00:00:00Z")]);
    expect(groups.map((g) => g.label)).toEqual(["beta", "alpha"]);
  });
});

describe("matchesQuery", () => {
  const row = s("1", A, "2026-09-01T00:00:00Z", { title: "压缩协议", preview: "先看水位" });

  it("空查询全留", () => {
    expect(matchesQuery(row, "   ")).toBe(true);
  });

  it("匹配标题、路径与首句,大小写不敏感", () => {
    expect(matchesQuery(row, "压缩")).toBe(true);
    expect(matchesQuery(row, "ALPHA")).toBe(true);
    expect(matchesQuery(row, "水位")).toBe(true);
    expect(matchesQuery(row, "没有这个词")).toBe(false);
  });
});

describe("sessionsForProject", () => {
  const all = [
    s("1", A, "2026-09-01T00:00:00Z"),
    s("2", B, "2026-09-05T00:00:00Z"),
    s("3", A, "2026-09-03T00:00:00Z"),
  ];

  it("「全部」态留全部,按最后活跃时间倒序", () => {
    expect(sessionsForProject(all, ALL_PROJECTS).map((x) => x.sessionId)).toEqual(["2", "3", "1"]);
  });

  it("选了具体项目就只留它的", () => {
    expect(sessionsForProject(all, A).map((x) => x.sessionId)).toEqual(["3", "1"]);
  });

  it("不原地改传进来的数组", () => {
    const input = [...all];
    sessionsForProject(input, ALL_PROJECTS);
    expect(input.map((x) => x.sessionId)).toEqual(["1", "2", "3"]);
  });
});

describe("projectPanel", () => {
  const all = [
    s("1", A, "2026-09-01T00:00:00Z", { title: "压缩协议" }),
    s("2", B, "2026-09-05T00:00:00Z", { title: "别的事" }),
  ];

  it("左栏跟着搜索结果收窄", () => {
    const matched = all.filter((x) => matchesQuery(x, "压缩"));
    expect(projectPanel(all, matched, ALL_PROJECTS).map((g) => g.label)).toEqual(["alpha"]);
  });

  it("选中的目录一条都没命中时仍留在栏里,计数 0", () => {
    const matched = all.filter((x) => matchesQuery(x, "压缩"));
    const panel = projectPanel(all, matched, B);
    expect(panel.map((g) => [g.label, g.sessionCount])).toEqual([
      ["alpha", 1],
      ["beta", 0],
    ]);
  });

  it("选中的键根本不存在时不无中生有", () => {
    expect(projectPanel(all, all, "/repo/已经没了").map((g) => g.label)).toEqual([
      "beta",
      "alpha",
    ]);
  });
});
