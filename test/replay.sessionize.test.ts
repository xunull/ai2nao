import { describe, expect, it } from "vitest";
import {
  sessionize,
  DEFAULT_GAP_THRESHOLD_MS,
  type ReplayEvent,
} from "../src/replay/sessionize.js";

// sessionize 只认 epoch ms、时区无关(codex#9),故不 pin TZ —— 结果不该随时区变。
const H = 60 * 60 * 1000;
const M = 60 * 1000;

function ev(
  atMs: number,
  type: "commit" | "message",
  repoKey = "-r",
  id = String(atMs),
  source = type === "commit" ? "git" : "codex"
): ReplayEvent {
  return { atMs, type, source, id, repoKey };
}

describe("sessionize —— 按 gap 切工作会话段", () => {
  it("gap > 阈值断段;gap <= 阈值合并", () => {
    const base = 1_000_000_000_000;
    const evs = [
      ev(base, "message"),
      ev(base + 30 * M, "message"), // 距上一条 30m < 2h → 同段
      ev(base + 3 * H, "commit"), // 距上一条 2h30m > 2h → 新段
    ];
    const s = sessionize(evs);
    expect(s).toHaveLength(2);
    expect(s[0].events).toHaveLength(2);
    expect(s[1].events).toHaveLength(1);
  });

  it("gap 恰好 = 阈值 → 合并(> 严格,== 不断)", () => {
    const base = 1_000_000_000_000;
    const s = sessionize([ev(base, "message"), ev(base + DEFAULT_GAP_THRESHOLD_MS, "commit")]);
    expect(s).toHaveLength(1);
    expect(s[0].commitCount).toBe(1);
    expect(s[0].messageCount).toBe(1);
  });

  it("跨仓库按时间连续切(P5),repoKeys 按出现顺序 distinct", () => {
    const base = 1_000_000_000_000;
    const s = sessionize([
      ev(base, "message", "-repoA"),
      ev(base + 10 * M, "commit", "-repoB"),
      ev(base + 20 * M, "message", "-repoA"),
    ]);
    expect(s).toHaveLength(1);
    expect(s[0].repoKeys).toEqual(["-repoA", "-repoB"]);
  });

  it("空输入 → []", () => {
    expect(sessionize([])).toEqual([]);
  });

  it("单事件 → 一段", () => {
    const s = sessionize([ev(1_000_000_000_000, "commit")]);
    expect(s).toHaveLength(1);
    expect(s[0].startedAtMs).toBe(s[0].endedAtMs);
    expect(s[0].firstEventKey).toBe("git:1000000000000");
  });

  it("commitCount / messageCount 正确", () => {
    const base = 1_000_000_000_000;
    const s = sessionize([
      ev(base, "message", "-r", "m1"),
      ev(base + M, "commit", "-r", "c1"),
      ev(base + 2 * M, "message", "-r", "m2"),
    ]);
    expect(s[0].commitCount).toBe(1);
    expect(s[0].messageCount).toBe(2);
  });

  it("硬上限 maxEvents → 截断成多段并标 truncated", () => {
    const base = 1_000_000_000_000;
    const evs = Array.from({ length: 5 }, (_, i) => ev(base + i * M, "message", "-r", `m${i}`));
    const s = sessionize(evs, { maxEvents: 2 });
    // 每段最多 2 → 5 条切成 3 段(2/2/1);前两段撞上限 truncated。
    expect(s.length).toBe(3);
    expect(s[0].truncated).toBe(true);
    expect(s[0].events).toHaveLength(2);
    expect(s[2].truncated).toBe(false);
  });

  it("硬上限 maxSpanMs → 超长连续活截断", () => {
    const base = 1_000_000_000_000;
    // 每 30m 一条、连续 5 条(总跨 2h),maxSpan=1h → 撞 span 上限截断。
    const evs = Array.from({ length: 5 }, (_, i) => ev(base + i * 30 * M, "message", "-r", `m${i}`));
    const s = sessionize(evs, { maxSpanMs: H });
    expect(s.length).toBeGreaterThan(1);
    expect(s.some((seg) => seg.truncated)).toBe(true);
  });

  it("乱序输入 → 内部按 atMs 升序;同刻用 source:id 破平,确定性", () => {
    const base = 1_000_000_000_000;
    const a = sessionize([
      ev(base + 2 * M, "message", "-r", "m2"),
      ev(base, "commit", "-r", "c0"),
      ev(base + M, "message", "-r", "m1"),
    ]);
    expect(a[0].events.map((e) => e.id)).toEqual(["c0", "m1", "m2"]);
    // 同一 atMs 两条 → firstEventKey 稳定(字典序小者在前)
    const b = sessionize([
      ev(base, "message", "-r", "zzz", "codex"),
      ev(base, "commit", "-r", "aaa", "git"),
    ]);
    expect(b[0].firstEventKey).toBe("codex:zzz" < "git:aaa" ? "codex:zzz" : "git:aaa");
  });
});
