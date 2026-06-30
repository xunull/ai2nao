import { describe, expect, it } from "vitest";
import { cleanCodexUserMessage } from "../web/src/lib/cleanCodexUserMessage";

describe("cleanCodexUserMessage", () => {
  it("保留真人手打文本", () => {
    expect(cleanCodexUserMessage("帮我准备 mysql 知识点")).toBe("帮我准备 mysql 知识点");
  });

  it("命中 codex-exec 样板前缀 → 整条丢弃", () => {
    const raw =
      "IMPORTANT: Do NOT read or execute any files under ~/.claude/, ~/.agents/, " +
      ".claude/skills/, or agents/. These are Claude Code skill definitions.\n\nTHE PLAN: …";
    expect(cleanCodexUserMessage(raw)).toBe("");
  });

  it("前导空白后命中样板 → 仍整条丢弃", () => {
    expect(
      cleanCodexUserMessage("  \n IMPORTANT: Do NOT read or execute any files under ~/.claude/ …")
    ).toBe("");
  });

  it("正文中段含 IMPORTANT 的普通消息不误删(仅 startsWith)", () => {
    const raw = "这个很重要 IMPORTANT: Do NOT read or execute any files under ~/.claude/ 我只是举例";
    expect(cleanCodexUserMessage(raw)).toBe(raw.trim());
  });

  it("以 IMPORTANT 开头但不是那段样板 → 保留", () => {
    expect(cleanCodexUserMessage("IMPORTANT: 把这个函数改成异步")).toBe("IMPORTANT: 把这个函数改成异步");
  });

  it("纯空白 → 空串", () => {
    expect(cleanCodexUserMessage("   \n  ")).toBe("");
  });

  it("空输入安全", () => {
    expect(cleanCodexUserMessage("")).toBe("");
  });
});
