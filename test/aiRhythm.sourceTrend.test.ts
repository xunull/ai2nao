process.env.TZ = "Asia/Shanghai";

import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { openDatabase } from "../src/store/open.js";
import { upsertUserMessagesBatch } from "../src/agentUserMessages/store.js";
import { weeklySourceMix } from "../src/aiRhythm/queries.js";
import type {
  UpsertUserMessageInput,
  AgentUserMessageSource,
} from "../src/agentUserMessages/types.js";

function freshDb(): Database.Database {
  const dir = mkdtempSync(join(tmpdir(), "ai-rhythm-src-"));
  return openDatabase(join(dir, "test.db"));
}

let seq = 0;
function row(
  eventAtUtc: string,
  source: AgentUserMessageSource,
  isHuman = true
): UpsertUserMessageInput {
  seq++;
  return {
    source,
    sourceSessionId: `s${seq}`,
    sourceMessageKey: `m${seq}`,
    project: null,
    eventAtUtc,
    rawText: "x",
    rawPayloadJson: '"x"',
    cleanedText: isHuman ? "x" : "",
    isHuman,
    cleanerVersion: 1,
    parserVersion: 1,
    sourcePath: "/x",
  };
}
function seed(db: Database.Database, rows: UpsertUserMessageInput[]) {
  upsertUserMessagesBatch(db, rows, "2026-07-08T00:00:00Z");
}
const at = (ymd: string) => `${ymd}T04:00:00Z`; // 北京当天 12:00

describe("weeklySourceMix — 逐源周趋势", () => {
  it("周分桶 + 三源 pivot + 排序", () => {
    const db = freshDb();
    seed(db, [
      row(at("2026-07-06"), "codex"), // 周 W1
      row(at("2026-07-06"), "codex"),
      row(at("2026-07-07"), "claude"), // 同周
      row(at("2026-07-13"), "claude"), // 下一周 W2
    ]);
    const { weeks } = weeklySourceMix(db);
    expect(weeks.length).toBe(2);
    expect(weeks[0]).toMatchObject({ codex: 2, claude: 1, opencode: 0, total: 3 });
    expect(weeks[1]).toMatchObject({ claude: 1, codex: 0, total: 1 });
    // 排序:字典序 = 时间序
    expect(weeks[0].week < weeks[1].week).toBe(true);
  });

  it("坏时间戳过滤 + is_human 过滤", () => {
    const db = freshDb();
    seed(db, [
      row(at("2026-07-06"), "claude"),
      row("not-a-date", "codex"), // 坏 ts → 剔除
      row(at("2026-07-06"), "codex", false), // 注入 → 不计
    ]);
    const { weeks } = weeklySourceMix(db);
    expect(weeks.length).toBe(1);
    expect(weeks[0]).toMatchObject({ claude: 1, codex: 0, total: 1 });
  });

  it("空库 → weeks []", () => {
    const db = freshDb();
    const { weeks } = weeklySourceMix(db);
    expect(weeks).toEqual([]);
  });

  it("每个已接入的源都进桶,且 total == 各带之和", () => {
    // 回归:total 原来是 COUNT(*)(全源),而分列只有三个 —— kimi 从入库起就
    // 没被画进这张卡,W34 那周漏 124/422 = 29%。因为是绝对值堆叠面积图,
    // 图上不会出现空洞,曲线只是矮一截,看着完全正常。
    //
    // 「total == 各带之和」这一条同时守住两件事:漏了某个源(和对不上),
    // 以及 total 又被写回 COUNT(*)(含未画的源,和也对不上)。
    const db = freshDb();
    const sources = ["claude", "codex", "opencode", "kimi", "hermes"] as const;
    seed(
      db,
      sources.map((s) => row(at("2026-07-06"), s))
    );
    const { weeks } = weeklySourceMix(db);
    expect(weeks.length).toBe(1);
    const w = weeks[0]!;
    for (const s of sources) {
      expect(w[s], `源 ${s} 没有计进桶`).toBe(1);
    }
    const sum = sources.reduce((a, s) => a + w[s], 0);
    expect(w.total).toBe(sum);
    expect(w.total).toBe(sources.length);
  });

  it("hermes 的 cron 会话既不进 hermes 带,也不进 total", () => {
    // 这张卡的标题是「你按周用哪个 agent」—— cron 是机器自己跑的,不是你在用。
    // 真库 hermes 120 场里 94 场是 cron,不排掉这条带 78% 是机器。
    // 判据是 session id 的 cron_ 前缀(实测 121 场零不一致);它耦合上游命名约定,
    // 所以这条用例是它唯一的守卫。
    const db = freshDb();
    seed(db, [
      { ...row(at("2026-07-06"), "hermes"), sourceSessionId: "cron_abc_20260706_110000" },
      { ...row(at("2026-07-06"), "hermes"), sourceSessionId: "20260706_120000_人发起" },
      row(at("2026-07-06"), "claude"),
    ]);
    const { weeks } = weeklySourceMix(db);
    expect(weeks.length).toBe(1);
    const w = weeks[0]!;
    expect(w.hermes, "cron 会话被算进了 hermes 带").toBe(1);
    expect(w.total, "cron 会话被算进了 total").toBe(2); // claude 1 + hermes 非 cron 1
  });

  it("未画的源不进 total —— 否则 Y 轴会被撑高、柱子系统性偏矮", () => {
    // sourceTrendSvg.ts:37 拿 total 定 Y 轴上限、:42 算页脚「共 N 次」。
    // total 若含未画的源,那张 SVG 卡的柱子会整体偏矮。
    const db = freshDb();
    seed(db, [
      row(at("2026-07-06"), "claude"),
      row(at("2026-07-06"), "minimax"), // 不在这张卡的 SERIES 里
    ]);
    const { weeks } = weeklySourceMix(db);
    expect(weeks.length).toBe(1);
    expect(weeks[0]!.total).toBe(1); // 只算 claude,不算 hermes
  });
});
