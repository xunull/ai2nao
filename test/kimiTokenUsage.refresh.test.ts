import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { defaultKimiCliRoot, sandboxDefaultWorkDir } from "../src/kimiHistory/paths.js";
import { scanKimiWireFiles } from "../src/kimiHistory/scan.js";
import { refreshKimiTokenUsage } from "../src/kimiTokenUsage/refresh.js";
import { openDatabase } from "../src/store/open.js";

/**
 * kimi token 入库。
 *
 * 最要紧的一条是 **X2**:一个会话下有 N 个 agent 文件,坏掉其中一个
 * **不能**把另外 N-1 个的 token 从统计里带走。
 * 归一评审最初把它写反了(会话级 worst-of + `token_status='full'` 门禁),
 * 是 codex outside voice 抓到的。这里用 chmod 0000 造真实的读失败来守。
 */

const PRIOR_TZ = process.env.TZ;
beforeAll(() => {
  process.env.TZ = "Asia/Shanghai";
});
afterAll(() => {
  process.env.TZ = PRIOR_TZ;
});

function freshDb(): Database.Database {
  return openDatabase(join(mkdtempSync(join(tmpdir(), "ai2nao-kimi-tok-")), "t.db"));
}

/** 一条 usage.record。`inputOther` 就是「不含缓存的输入」。 */
function usageLine(o: {
  time: number;
  inputOther: number;
  output: number;
  cacheRead?: number;
  cacheCreation?: number;
}): string {
  return JSON.stringify({
    type: "usage.record",
    model: "kimi-code/k3",
    usageScope: "turn",
    time: o.time,
    usage: {
      inputOther: o.inputOther,
      output: o.output,
      inputCacheRead: o.cacheRead ?? 0,
      inputCacheCreation: o.cacheCreation ?? 0,
    },
  });
}

/** 造 `<root>/<wd>/<session>/agents/<agent>/wire.jsonl`,顺带写 state.json。 */
function writeAgentFile(
  root: string,
  sessionId: string,
  agent: string,
  lines: string[],
  cwd = "/p/proj"
): string {
  const sessionDir = join(root, "wd_fx_0000", sessionId);
  const agentDir = join(sessionDir, "agents", agent);
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(sessionDir, "state.json"), JSON.stringify({ cwd, version: 2, title: "t" }));
  const p = join(agentDir, "wire.jsonl");
  writeFileSync(p, lines.join("\n") + (lines.length ? "\n" : ""));
  return p;
}

function newRoot(): string {
  return mkdtempSync(join(tmpdir(), "ai2nao-kimi-root-"));
}

/** 空目录当作「没有桌面侧」。 */
function emptyRoot(): string {
  return mkdtempSync(join(tmpdir(), "ai2nao-kimi-empty-"));
}

describe("kimi token 入库", () => {
  it("inputOther 直接落成 fresh_input —— 零转换,且 fresh 不为负", () => {
    const db = freshDb();
    const root = newRoot();
    writeAgentFile(root, "session_a", "main", [
      usageLine({ time: 1786169845493, inputOther: 100, output: 10, cacheRead: 900, cacheCreation: 50 }),
    ]);
    refreshKimiTokenUsage(db, { cliRoot: root, desktopRoot: emptyRoot() });

    const e = db.prepare(`SELECT * FROM kimi_token_usage_event`).get() as Record<string, number>;
    expect(e.fresh_input).toBe(100);
    expect(e.cache_read_input).toBe(900);
    expect(e.cache_creation_input).toBe(50);
    expect(e.output).toBe(10);
    // 存融合值的话「真实新增」要靠减法,写反会得到 100-900-50 = -850
    const neg = db
      .prepare(`SELECT COUNT(*) n FROM kimi_token_usage_event WHERE fresh_input < 0`)
      .get() as { n: number };
    expect(neg.n).toBe(0);
    db.close();
  });

  it("event_ordinal 是文件内序号 —— 同一毫秒的两条事件都留得住", () => {
    const db = freshDb();
    const root = newRoot();
    // 刻意用同一个 time:实测「time 全局唯一」是观察不是契约
    writeAgentFile(root, "session_a", "main", [
      usageLine({ time: 1786169845493, inputOther: 1, output: 1 }),
      usageLine({ time: 1786169845493, inputOther: 2, output: 2 }),
    ]);
    refreshKimiTokenUsage(db, { cliRoot: root, desktopRoot: emptyRoot() });
    const rows = db
      .prepare(`SELECT event_ordinal, fresh_input FROM kimi_token_usage_event ORDER BY event_ordinal`)
      .all() as { event_ordinal: number; fresh_input: number }[];
    expect(rows).toEqual([
      { event_ordinal: 0, fresh_input: 1 },
      { event_ordinal: 1, fresh_input: 2 },
    ]);
    db.close();
  });

  describe("X2 —— 坏掉的 agent 只拖累它自己", () => {
    it("一个 agent 文件读不了,同会话另外两个的 token 照常入库且计入合计", () => {
      const db = freshDb();
      const root = newRoot();
      writeAgentFile(root, "session_a", "main", [
        usageLine({ time: 1786169845000, inputOther: 100, output: 10 }),
      ]);
      writeAgentFile(root, "session_a", "agent-0", [
        usageLine({ time: 1786169846000, inputOther: 200, output: 20 }),
      ]);
      const bad = writeAgentFile(root, "session_a", "agent-1", [
        usageLine({ time: 1786169847000, inputOther: 999, output: 99 }),
      ]);
      chmodSync(bad, 0o000);

      const r = refreshKimiTokenUsage(db, { cliRoot: root, desktopRoot: emptyRoot() });
      chmodSync(bad, 0o644); // 还原,免得留下删不掉的临时目录

      expect(r.errorAgents).toBe(1);
      expect(r.fullAgents).toBe(2);

      const byAgent = db
        .prepare(`SELECT agent, token_status FROM kimi_agent_token_usage ORDER BY agent`)
        .all() as { agent: string; token_status: string }[];
      expect(byAgent).toEqual([
        { agent: "agent-0", token_status: "full" },
        { agent: "agent-1", token_status: "error" },
        { agent: "main", token_status: "full" },
      ]);

      // ★ 这条是 X2 的核心:好 agent 的 token **在合计里**。
      // 会话级 worst-of 当门禁的话,这里会是 0。
      const sum = db
        .prepare(
          `SELECT COALESCE(SUM(e.fresh_input + e.output), 0) t
             FROM kimi_token_usage_event e
             JOIN kimi_agent_token_usage a
               ON a.session_id = e.session_id AND a.agent = e.agent
            WHERE a.token_status = 'full' AND a.missing_since IS NULL`
        )
        .get() as { t: number };
      expect(sum.t).toBe(100 + 10 + 200 + 20);

      // 坏 agent 一条事件都没有(不是写了错的值)
      const badEvents = db
        .prepare(`SELECT COUNT(*) n FROM kimi_token_usage_event WHERE agent = 'agent-1'`)
        .get() as { n: number };
      expect(badEvents.n).toBe(0);
      db.close();
    });

    it("坏 agent 的 parse_error 被记下来,不是静默的 0", () => {
      const db = freshDb();
      const root = newRoot();
      writeAgentFile(root, "session_a", "main", [
        usageLine({ time: 1786169845000, inputOther: 1, output: 1 }),
      ]);
      const bad = writeAgentFile(root, "session_a", "agent-0", []);
      chmodSync(bad, 0o000);
      refreshKimiTokenUsage(db, { cliRoot: root, desktopRoot: emptyRoot() });
      chmodSync(bad, 0o644);
      const row = db
        .prepare(`SELECT parse_error FROM kimi_agent_token_usage WHERE agent = 'agent-0'`)
        .get() as { parse_error: string | null };
      expect(row.parse_error).toBeTruthy();
      db.close();
    });
  });

  describe("X3 —— 按文件 delete-and-replace", () => {
    it("文件被截断后重扫,消失的事件不残留", () => {
      const db = freshDb();
      const root = newRoot();
      const p = writeAgentFile(root, "session_a", "main", [
        usageLine({ time: 1786169845000, inputOther: 1, output: 1 }),
        usageLine({ time: 1786169846000, inputOther: 2, output: 2 }),
        usageLine({ time: 1786169847000, inputOther: 3, output: 3 }),
      ]);
      refreshKimiTokenUsage(db, { cliRoot: root, desktopRoot: emptyRoot() });
      expect(
        (db.prepare(`SELECT COUNT(*) n FROM kimi_token_usage_event`).get() as { n: number }).n
      ).toBe(3);

      // 截断成一条
      writeFileSync(p, usageLine({ time: 1786169845000, inputOther: 1, output: 1 }) + "\n");
      refreshKimiTokenUsage(db, { cliRoot: root, desktopRoot: emptyRoot(), full: true });

      // 靠「主键冲突就跳过」的话这里会是 3 —— 被删掉的两条会残留
      expect(
        (db.prepare(`SELECT COUNT(*) n FROM kimi_token_usage_event`).get() as { n: number }).n
      ).toBe(1);
      db.close();
    });

    it("同一文件重复 refresh 幂等 —— 事件不翻倍", () => {
      const db = freshDb();
      const root = newRoot();
      writeAgentFile(root, "session_a", "main", [
        usageLine({ time: 1786169845000, inputOther: 1, output: 1 }),
        usageLine({ time: 1786169846000, inputOther: 2, output: 2 }),
      ]);
      refreshKimiTokenUsage(db, { cliRoot: root, desktopRoot: emptyRoot() });
      refreshKimiTokenUsage(db, { cliRoot: root, desktopRoot: emptyRoot(), full: true });
      refreshKimiTokenUsage(db, { cliRoot: root, desktopRoot: emptyRoot(), full: true });
      expect(
        (db.prepare(`SELECT COUNT(*) n FROM kimi_token_usage_event`).get() as { n: number }).n
      ).toBe(2);
      db.close();
    });
  });

  it("解析成功但零 usage.record → unknown,不是 error", () => {
    const db = freshDb();
    const root = newRoot();
    // 有内容、但没有 usage.record
    writeAgentFile(root, "session_a", "main", [
      JSON.stringify({ type: "context.append_message", message: { id: "m1" } }),
    ]);
    const r = refreshKimiTokenUsage(db, { cliRoot: root, desktopRoot: emptyRoot() });
    expect(r.unknownAgents).toBe(1);
    expect(r.errorAgents).toBe(0);
    const row = db.prepare(`SELECT token_status FROM kimi_agent_token_usage`).get() as {
      token_status: string;
    };
    expect(row.token_status).toBe("unknown");
    db.close();
  });

  it("ctitle- 标题生成会话被滤掉 —— 复用 scanKimiWireFiles 的口径", () => {
    const db = freshDb();
    const root = newRoot();
    writeAgentFile(root, "session_real", "main", [
      usageLine({ time: 1786169845000, inputOther: 10, output: 1 }),
    ]);
    writeAgentFile(root, "ctitle-abc", "main", [
      usageLine({ time: 1786169846000, inputOther: 999, output: 99 }),
    ]);
    const r = refreshKimiTokenUsage(db, { cliRoot: root, desktopRoot: emptyRoot() });
    expect(r.scannedAgents).toBe(1);
    const sessions = db
      .prepare(`SELECT DISTINCT session_id FROM kimi_agent_token_usage`)
      .all() as { session_id: string }[];
    expect(sessions).toEqual([{ session_id: "session_real" }]);
    db.close();
  });

  it("文件消失 → 标 missing_since,不删行", () => {
    const db = freshDb();
    const root = newRoot();
    writeAgentFile(root, "session_a", "main", [
      usageLine({ time: 1786169845000, inputOther: 1, output: 1 }),
    ]);
    refreshKimiTokenUsage(db, { cliRoot: root, desktopRoot: emptyRoot() });
    rmSync(join(root, "wd_fx_0000", "session_a"), { recursive: true, force: true });
    refreshKimiTokenUsage(db, { cliRoot: root, desktopRoot: emptyRoot() });
    const row = db
      .prepare(`SELECT missing_since FROM kimi_agent_token_usage WHERE session_id = 'session_a'`)
      .get() as { missing_since: string | null };
    expect(row.missing_since).toBeTruthy();
    db.close();
  });

  it("mtime/size 未变时跳过重解析", () => {
    const db = freshDb();
    const root = newRoot();
    writeAgentFile(root, "session_a", "main", [
      usageLine({ time: 1786169845000, inputOther: 1, output: 1 }),
    ]);
    const first = refreshKimiTokenUsage(db, { cliRoot: root, desktopRoot: emptyRoot() });
    expect(first.indexedAgents).toBe(1);
    expect(first.skippedUnchanged).toBe(0);
    const second = refreshKimiTokenUsage(db, { cliRoot: root, desktopRoot: emptyRoot() });
    expect(second.indexedAgents).toBe(0);
    expect(second.skippedUnchanged).toBe(1);
    db.close();
  });
});

/**
 * 真实机器对账。总量**不写死** —— CLI 侧还在日常使用,数据在长。
 * 只断言「入库结果 == 同一时刻现扫现算的值」。
 */
describe.skipIf(!existsSync(defaultKimiCliRoot()))("kimi token 真实数据对账", () => {
  it("入库总量等于同一时刻 scanKimiWireFiles() 现算的值", async () => {
    const { parseKimiUsage } = await import("../src/kimiTokenUsage/parse.js");
    const db = freshDb();
    refreshKimiTokenUsage(db);

    let expectFresh = 0;
    let expectRead = 0;
    let expectCreation = 0;
    let expectOutput = 0;
    let expectEvents = 0;
    for (const f of scanKimiWireFiles().files) {
      try {
        const p = parseKimiUsage(f.filePath);
        for (const e of p.events) {
          expectFresh += e.freshInput;
          expectRead += e.cacheReadInput;
          expectCreation += e.cacheCreationInput;
          expectOutput += e.output;
          expectEvents++;
        }
      } catch {
        /* 读不了的那些本来就不该贡献 token */
      }
    }

    const got = db
      .prepare(
        `SELECT COUNT(*) n, COALESCE(SUM(fresh_input),0) f, COALESCE(SUM(cache_read_input),0) cr,
                COALESCE(SUM(cache_creation_input),0) cc, COALESCE(SUM(output),0) o
           FROM kimi_token_usage_event`
      )
      .get() as { n: number; f: number; cr: number; cc: number; o: number };

    expect(got.n).toBe(expectEvents);
    expect(got.f).toBe(expectFresh);
    expect(got.cr).toBe(expectRead);
    expect(got.cc).toBe(expectCreation);
    expect(got.o).toBe(expectOutput);
    db.close();
  });

  it("真实数据里没有负的 fresh_input(P4 的融合陷阱)", () => {
    const db = freshDb();
    refreshKimiTokenUsage(db);
    const neg = db
      .prepare(`SELECT COUNT(*) n FROM kimi_token_usage_event WHERE fresh_input < 0`)
      .get() as { n: number };
    expect(neg.n).toBe(0);
    db.close();
  });
});

/**
 * 规则版本改了就必须重刷 —— 见 docs/adr/0001-kimi-unknown-project-identity.md。
 *
 * 逐行的跳过判据只比 mtime 与大小,而 wire.jsonl 不会因为我们改代码而变。
 * 在补上这条之前,bump 规则版本只让读取侧报 stale,数据永远不会重建。
 */
describe("规则版本触发重刷", () => {
  it("版本不符时强制全量重解析,而不是按 mtime 跳过", () => {
    const db = freshDb();
    const root = newRoot();
    writeAgentFile(root, "session_a", "main", [
      usageLine({ time: 1786169845493, inputOther: 1, output: 1 }),
    ]);
    const opts = { cliRoot: root, desktopRoot: emptyRoot() };

    refreshKimiTokenUsage(db, opts);
    // 文件没动 → 第二轮应当跳过
    const second = refreshKimiTokenUsage(db, opts);
    expect(second.skippedUnchanged).toBe(1);
    expect(second.forcedFullByRuleVersion).toBe(false);

    // 模拟「这一版的规则版本比库里的新」
    db.prepare(`UPDATE kimi_token_usage_state SET rule_version = rule_version - 1 WHERE id = 1`).run();
    const third = refreshKimiTokenUsage(db, opts);
    expect(third.forcedFullByRuleVersion).toBe(true);
    expect(third.skippedUnchanged).toBe(0);
    expect(third.indexedAgents).toBe(1);

    // 重刷完版本回到当前值,下一轮恢复跳过
    const fourth = refreshKimiTokenUsage(db, opts);
    expect(fourth.forcedFullByRuleVersion).toBe(false);
    expect(fourth.skippedUnchanged).toBe(1);
    db.close();
  });

  it("重刷会更新派生字段 —— 旧口径写下的项目键会被新口径覆盖", () => {
    const db = freshDb();
    const root = newRoot();
    writeAgentFile(root, "session_a", "main", [
      usageLine({ time: 1786169845493, inputOther: 1, output: 1 }),
    ]);
    const opts = { cliRoot: root, desktopRoot: emptyRoot() };
    refreshKimiTokenUsage(db, opts);

    db.prepare(`UPDATE kimi_agent_token_usage SET project_key = 'kimi:旧口径'`).run();
    db.prepare(`UPDATE kimi_token_usage_state SET rule_version = rule_version - 1 WHERE id = 1`).run();
    refreshKimiTokenUsage(db, opts);

    const row = db.prepare(`SELECT project_key FROM kimi_agent_token_usage`).get() as {
      project_key: string;
    };
    expect(row.project_key).toBe("/p/proj");
    db.close();
  });

  it("桌面沙箱的无目录会话全部归到 kimi:unknown,路径留空", () => {
    const db = freshDb();
    const root = newRoot();
    // sandboxDefaultWorkDir() 被 kimiProjectPath() 映射成 null → 这里走无目录分支
    const sandbox = sandboxDefaultWorkDir();
    writeAgentFile(root, "conv-1", "main", [
      usageLine({ time: 1786169845493, inputOther: 1, output: 1 }),
    ], sandbox);
    writeAgentFile(root, "conv-2", "main", [
      usageLine({ time: 1786169845494, inputOther: 2, output: 2 }),
    ], sandbox);
    refreshKimiTokenUsage(db, { cliRoot: root, desktopRoot: emptyRoot() });

    const rows = db
      .prepare(`SELECT DISTINCT project_key, project_path FROM kimi_agent_token_usage`)
      .all() as { project_key: string; project_path: string }[];
    expect(rows).toEqual([{ project_key: "kimi:unknown", project_path: "" }]);
    db.close();
  });
});
