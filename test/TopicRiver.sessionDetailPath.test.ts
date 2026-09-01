import { describe, expect, it } from "vitest";
import { sessionDetailPath } from "../web/src/pages/TopicRiver";

/**
 * 话题河 → 各源历史页的深链。
 *
 * 这个函数**静默降级**:认不出的源返回 null,前端只是不给链接,不报错、不打日志。
 * 所以加源到话题河而忘了加这里,表现是「会话在河里点不进去」,没有任何东西会红 ——
 * 除了这组测试。清单见 docs/agent-source-checklist.md 第 9b 项。
 */
describe("sessionDetailPath — 话题河深链", () => {
  it("每个已入河的源都给得出路径 —— 少一个源这条会红", () => {
    // 与 CONVERSATION_SOURCES 对齐。加源时这里也要加,否则新源点不进去。
    const cases: [string, string][] = [
      ["codex:abc123", "/codex-history/s/abc123"],
      ["opencode:ses_9f", "/opencode-history/s/ses_9f"],
      ["kimi:conv-01605adb", "/kimi-history/s/conv-01605adb"],
      // kimi 有两套数据源(CLI 与桌面版),id 格式不同,两种都得能开。
      ["kimi:session_f42ea356-359b", "/kimi-history/s/session_f42ea356-359b"],
      [
        "claude:-work-app:11111111-2222",
        "/claude-code-history/s/11111111-2222?projectId=-work-app",
      ],
    ];
    for (const [ref, want] of cases) {
      expect(sessionDetailPath(ref), `源 ${ref.split(":")[0]} 给不出路径`).toBe(want);
    }
  });

  it("认不出的源 / 畸形 ref → null,不抛", () => {
    expect(sessionDetailPath("hermes:20260617_213819")).toBeNull(); // 还没入河
    expect(sessionDetailPath("nosuchsource:x")).toBeNull();
    expect(sessionDetailPath("noseparator")).toBeNull();
    expect(sessionDetailPath("codex:")).toBeNull(); // 空 sid
    expect(sessionDetailPath("claude:noinnercolon")).toBeNull();
  });

  it("id 里的特殊字符被转义,不会拼出坏 URL", () => {
    expect(sessionDetailPath("kimi:a b/c?d")).toBe("/kimi-history/s/a%20b%2Fc%3Fd");
  });
});
