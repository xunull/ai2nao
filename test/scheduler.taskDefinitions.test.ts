import { describe, expect, it } from "vitest";
import { createDefaultScheduledTaskDefinitions } from "../src/scheduler/taskDefinitions.js";

describe("scheduler task definitions", () => {
  it("registers a combined Claude and Codex token refresh task", () => {
    const defs = createDefaultScheduledTaskDefinitions();
    const task = defs.find((def) => def.key === "work.tokens.refresh");
    expect(task).toMatchObject({
      label: "工作项目 token 统计刷新",
      category: "derived",
      defaultIntervalSeconds: 60 * 60,
      sensitivity: "high",
    });
  });
});
