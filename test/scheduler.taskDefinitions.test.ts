import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  KIMI_CLI_ROOT_ENV,
  KIMI_DESKTOP_ROOT_ENV,
} from "../src/kimiHistory/paths.js";
import { createDefaultScheduledTaskDefinitions } from "../src/scheduler/taskDefinitions.js";
import { openDatabase } from "../src/store/open.js";

/**
 * scheduler 任务读的是**默认根**(它不该把任意路径做成 config 表面),
 * 所以测试用 paths.ts 既有的环境变量覆盖来指向临时目录。
 */
function withKimiRoots<T>(cli: string, desktop: string, fn: () => T): T {
  const prevCli = process.env[KIMI_CLI_ROOT_ENV];
  const prevDesktop = process.env[KIMI_DESKTOP_ROOT_ENV];
  process.env[KIMI_CLI_ROOT_ENV] = cli;
  process.env[KIMI_DESKTOP_ROOT_ENV] = desktop;
  try {
    return fn();
  } finally {
    if (prevCli === undefined) delete process.env[KIMI_CLI_ROOT_ENV];
    else process.env[KIMI_CLI_ROOT_ENV] = prevCli;
    if (prevDesktop === undefined) delete process.env[KIMI_DESKTOP_ROOT_ENV];
    else process.env[KIMI_DESKTOP_ROOT_ENV] = prevDesktop;
  }
}

describe("scheduler task definitions", () => {
  it("registers a combined Claude and Codex work stats refresh task", () => {
    const defs = createDefaultScheduledTaskDefinitions();
    const task = defs.find((def) => def.key === "work.tokens.refresh");
    expect(task).toMatchObject({
      label: "工作项目统计刷新",
      category: "derived",
      defaultIntervalSeconds: 60 * 60,
      sensitivity: "high",
    });
  });

  it("任务 key 全局唯一 —— 重复的 key 会让后注册的静默顶掉前一个", () => {
    const keys = createDefaultScheduledTaskDefinitions().map((d) => d.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  describe("kimi token 统计刷新", () => {
    it("已注册,且与「kimi 用户消息入库」是两个独立任务", () => {
      const defs = createDefaultScheduledTaskDefinitions();
      expect(defs.find((d) => d.key === "kimi.tokens.refresh")).toMatchObject({
        label: "kimi token 统计刷新",
        category: "derived",
        defaultIntervalSeconds: 60 * 60,
        sensitivity: "high",
      });
      // 那个抽对话正文,这个抽 usage.record —— 不能合并
      expect(defs.find((d) => d.key === "agent_user_messages.kimi.sync")).toBeDefined();
    });

    it("跑起来:空数据源 → success", async () => {
      const db = openDatabase(join(mkdtempSync(join(tmpdir(), "sched-kimi-")), "t.db"));
      const task = createDefaultScheduledTaskDefinitions().find(
        (d) => d.key === "kimi.tokens.refresh"
      )!;
      const empty = mkdtempSync(join(tmpdir(), "kimi-empty-"));
      const res = await withKimiRoots(empty, empty, () => task.run({ db, config: {} } as never));
      expect(res.status).toBe("success");
      expect(res.errorSummary).toBeNull();
      db.close();
    });

    it("单个 agent 文件读不了 → partial,不是 failed —— 其余照常入库(X2)", async () => {
      const db = openDatabase(join(mkdtempSync(join(tmpdir(), "sched-kimi-p-")), "t.db"));
      const root = mkdtempSync(join(tmpdir(), "kimi-partial-"));
      const mk = (agent: string, lines: string[]) => {
        const dir = join(root, "wd_x_0", "session_a", "agents", agent);
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(root, "wd_x_0", "session_a", "state.json"), JSON.stringify({ cwd: "/p" }));
        const p = join(dir, "wire.jsonl");
        writeFileSync(p, lines.join("\n") + "\n");
        return p;
      };
      const usage = JSON.stringify({
        type: "usage.record",
        model: "kimi-code/k3",
        usageScope: "turn",
        time: 1786169845000,
        usage: { inputOther: 100, output: 10, inputCacheRead: 0, inputCacheCreation: 0 },
      });
      mk("main", [usage]);
      const bad = mk("agent-0", [usage]);
      chmodSync(bad, 0o000);

      const task = createDefaultScheduledTaskDefinitions().find(
        (d) => d.key === "kimi.tokens.refresh"
      )!;
      const res = await withKimiRoots(root, mkdtempSync(join(tmpdir(), "kimi-empty2-")), () =>
        task.run({ db, config: {} } as never)
      );
      chmodSync(bad, 0o644);

      expect(res.status).toBe("partial");
      expect(res.errorSummary).toMatch(/1 个 agent 文件读不了/);
      // 好 agent 的 token 进了库
      const n = db
        .prepare("SELECT COUNT(*) n FROM kimi_token_usage_event WHERE agent = 'main'")
        .get() as { n: number };
      expect(n.n).toBe(1);
      db.close();
    });
  });
});
