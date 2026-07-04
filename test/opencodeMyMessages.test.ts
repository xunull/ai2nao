import { describe, expect, it } from "vitest";
import {
  cleanOpencodeUserMessageParts,
  detectSlashCommand,
  isStructuralInjection,
  stripModePreamble,
  type ParsedPart,
} from "../src/opencodeHistory/myMessages.js";

// 真实 oh-my-opencode 模式前导(实测形状:mode 块 + MANDATORY + --- 分隔,真实内容在后)。
const REAL_PREAMBLE =
  "[search-mode]\nMAXIMIZE SEARCH EFFORT.\n\n[analyze-mode]\nANALYSIS MODE.\n---\nMANDATORY delegate_task params: ALWAYS include load_skills=[]\n\n---\n\n";

function textPart(text: string, extra?: Partial<ParsedPart>): ParsedPart {
  return { type: "text", text, ...extra };
}

describe("stripModePreamble —— 保守锚定前缀剥（误删 > 漏删）", () => {
  it("真实样例:剥掉 mode 前导,只留真实内容", () => {
    expect(stripModePreamble(REAL_PREAMBLE + "把开源协议改成 GPL")).toBe("把开源协议改成 GPL");
  });

  it("反例:正文含 Markdown HR —— 不误删前面真人内容", () => {
    const input = REAL_PREAMBLE + "第一段真人内容\n\n---\n\n第二段真人内容";
    // 剥掉前导后,正文里的 --- 必须保留(不能被当分隔符继续吃)。
    expect(stripModePreamble(input)).toBe("第一段真人内容\n\n---\n\n第二段真人内容");
  });

  it("反例:正文以 --- 开头(YAML frontmatter)—— 不误删", () => {
    const input = REAL_PREAMBLE + "---\ntitle: x\ntags: [a]\n---\n正文";
    const out = stripModePreamble(input);
    expect(out).toContain("title: x");
    expect(out).toContain("正文");
  });

  it("反例:用户真打了 [search-mode] 文本(无 --- 结构)—— 保留原文", () => {
    const input = "[search-mode] 这是我手打的,想问 search-mode 是啥";
    expect(stripModePreamble(input)).toBe(input);
  });

  it("反例:不以 mode 头开头(普通含 --- 的正文)—— 原样返回", () => {
    const input = "先看这段\n\n---\n\n再看这段";
    expect(stripModePreamble(input)).toBe(input);
  });

  it("preamble 多个 ---、多个 mode 块 —— 全吃掉,留真实内容", () => {
    const input = "[build-mode]\nx\n---\n[test-mode]\ny\n---\nMANDATORY delegate_task foo\n---\n真实问题";
    expect(stripModePreamble(input)).toBe("真实问题");
  });

  it("preamble 后无真实内容(全是前导)—— 返回空串", () => {
    const input = "[search-mode]\nx\n---\nMANDATORY delegate_task foo";
    expect(stripModePreamble(input)).toBe("");
  });

  it("普通真人短消息原样", () => {
    expect(stripModePreamble("ls")).toBe("ls");
    expect(stripModePreamble("你好 你是什么模型")).toBe("你好 你是什么模型");
  });
});

describe("isStructuralInjection —— 有结构标记的注入整条丢", () => {
  it("synthetic / editor_context / compaction_continue → true", () => {
    expect(isStructuralInjection({ type: "text", synthetic: true })).toBe(true);
    expect(isStructuralInjection({ type: "text", metadata: { kind: "editor_context" } })).toBe(true);
    expect(isStructuralInjection({ type: "text", metadata: { compaction_continue: true } })).toBe(true);
  });
  it("普通真人 part → false", () => {
    expect(isStructuralInjection({ type: "text", text: "ls" })).toBe(false);
  });
});

describe("cleanOpencodeUserMessageParts —— message 级", () => {
  it("结构注入丢 + mode 剥 + 真人保留", () => {
    const parts: ParsedPart[] = [
      textPart("Note: The user opened file …", { synthetic: true, metadata: { kind: "editor_context" } }),
      textPart(REAL_PREAMBLE + "帮我准备 mysql 知识点"),
    ];
    expect(cleanOpencodeUserMessageParts(parts)).toBe("帮我准备 mysql 知识点");
  });

  it("多 text part 按原顺序空行 join", () => {
    const parts: ParsedPart[] = [textPart("第一部分"), textPart("第二部分")];
    expect(cleanOpencodeUserMessageParts(parts)).toBe("第一部分\n\n第二部分");
  });

  it("非 text part 忽略", () => {
    const parts: ParsedPart[] = [
      { type: "tool", text: "工具输出不进抽屉" } as ParsedPart,
      textPart("真人问题"),
    ];
    expect(cleanOpencodeUserMessageParts(parts)).toBe("真人问题");
  });

  it("全是注入 → 空串(该 message 应省略)", () => {
    const parts: ParsedPart[] = [
      textPart("x", { synthetic: true }),
      textPart("[search-mode]\ny\n---\nMANDATORY delegate_task z"),
    ];
    expect(cleanOpencodeUserMessageParts(parts)).toBe("");
  });

  it("OMO 背景任务注入(OMO_INTERNAL_INITIATOR)整条丢", () => {
    const omo = "<system-reminder>\n[ALL BACKGROUND TASKS COMPLETE]\n…\n</system-reminder>\n<!-- OMO_INTERNAL_INITIATOR -->";
    expect(cleanOpencodeUserMessageParts([textPart(omo)])).toBe("");
    // 与真人消息混在一条 message 时,只丢注入 part。
    expect(cleanOpencodeUserMessageParts([textPart(omo), textPart("真人问题")])).toBe("真人问题");
  });

  it("完整 <system-reminder>…</system-reminder> 块(无 OMO 标记)也丢", () => {
    expect(cleanOpencodeUserMessageParts([textPart("<system-reminder>Note: something</system-reminder>")])).toBe("");
  });

  it("真人只是提到 <system-reminder>(无闭合)→ 保留(prefer-preserve)", () => {
    expect(cleanOpencodeUserMessageParts([textPart("这个 <system-reminder> 标签是干嘛的?")])).toBe("这个 <system-reminder> 标签是干嘛的?");
  });

  it("斜杠命令展开 → 紧凑 /名字(调用是我的输入,与 claude/codex 一致)", () => {
    const expansion =
      "<auto-slash-command>\n# /graphify Command\n\n**Description**: 大模板正文…(省略两千字)";
    expect(cleanOpencodeUserMessageParts([textPart(expansion)])).toBe("/graphify");
  });
});

describe("detectSlashCommand —— 锚定 + prefer-preserve（codex 加固）", () => {
  it("marker + 合法 header → 提取命令名", () => {
    expect(detectSlashCommand("<auto-slash-command>\n# /graphify Command\n\n**Description**: …")).toEqual({ name: "graphify" });
  });

  it("命令名含 - / : / . → 支持", () => {
    expect(detectSlashCommand("<auto-slash-command>\n# /foo-bar Command\n…")).toEqual({ name: "foo-bar" });
    expect(detectSlashCommand("<auto-slash-command>\n# /foo:bar Command\n…")).toEqual({ name: "foo:bar" });
    expect(detectSlashCommand("<auto-slash-command>\n# /ns.cmd Command\n…")).toEqual({ name: "ns.cmd" });
  });

  it("marker 后 CRLF / 空行 → 仍提取", () => {
    expect(detectSlashCommand("<auto-slash-command>\r\n# /graphify Command")).toEqual({ name: "graphify" });
    expect(detectSlashCommand("<auto-slash-command>\n\n# /graphify Command")).toEqual({ name: "graphify" });
  });

  it("marker 但无合法 header → null（不折叠,当普通文本）", () => {
    expect(detectSlashCommand("<auto-slash-command>\n随便写点什么,不是命令头")).toBeNull();
    expect(detectSlashCommand("<auto-slash-command>\n# 不是命令 Command")).toBeNull();
  });

  it("marker 在正文中段(非开头)→ null", () => {
    expect(detectSlashCommand("我引用一下 <auto-slash-command>\n# /graphify Command")).toBeNull();
  });

  it("普通消息 → null", () => {
    expect(detectSlashCommand("帮我改个 bug")).toBeNull();
    expect(detectSlashCommand("")).toBeNull();
  });
});
