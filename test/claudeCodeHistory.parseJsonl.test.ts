import { describe, expect, it } from "vitest";
import { parseJsonlText } from "../src/claudeCodeHistory/parseJsonl.js";
import { buildClaudeSession } from "../src/claudeCodeHistory/normalize.js";

describe("claudeCodeHistory parseJsonl", () => {
  it("parses multi-line file with blank lines and skips empties", () => {
    const text = [
      '{"type":"queue-operation","sessionId":"s1"}',
      "",
      "  ",
      '{"type":"user","uuid":"u1","timestamp":"2026-01-01T00:00:00.000Z","sessionId":"s1","message":{"role":"user","content":"hi"}}',
    ].join("\n");
    const r = parseJsonlText(text);
    expect(r.errors).toHaveLength(0);
    expect(r.okLines).toHaveLength(2);
  });

  it("records corrupt lines without stopping", () => {
    const text = '{"a":1}\nnot-json\n{"b":2}';
    const r = parseJsonlText(text);
    expect(r.okLines).toHaveLength(2);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0].line).toBe(2);
  });

  it("rejects non-object JSON roots", () => {
    const r = parseJsonlText("[1]\n{}");
    expect(r.errors.length).toBeGreaterThanOrEqual(1);
    expect(r.okLines).toHaveLength(1);
    expect(Object.keys(r.okLines[0].record)).toHaveLength(0);
  });
});

describe("claudeCodeHistory normalize", () => {
  it("maps user and assistant and folds other types as appendix", () => {
    const parse = parseJsonlText(
      [
        '{"type":"user","uuid":"u1","timestamp":"2026-01-01T00:00:00.000Z","sessionId":"sid","message":{"role":"user","content":"hello"}}',
        '{"type":"assistant","uuid":"a1","timestamp":"2026-01-01T00:00:01.000Z","sessionId":"sid","message":{"role":"assistant","content":[{"type":"text","text":"world"}],"model":"m","usage":{"input_tokens":1,"output_tokens":2}}}',
        '{"type":"queue-operation","sessionId":"sid","timestamp":"2026-01-01T00:00:02.000Z"}',
      ].join("\n")
    );
    const { session, warnings } = buildClaudeSession({
      projectId: "proj",
      sessionId: "sid",
      parse,
      fileMtimeMs: 0,
    });
    expect(warnings).toEqual([]);
    expect(session.messages.filter((m) => m.role === "user")).toHaveLength(1);
    expect(session.messages.filter((m) => m.role === "assistant")).toHaveLength(2);
    // session.usage now comes from extractClaudeSessionUsage (deduped by
    // message.id), which also carries the cache split (0 here, no cache fields).
    expect(session.usage).toEqual({
      totalInputTokens: 1,
      totalOutputTokens: 2,
      totalCacheReadInputTokens: 0,
      totalCacheCreationInputTokens: 0,
    });
    const appendix = session.messages.find(
      (m) => m.metadata?.claudeAppendix === true
    );
    expect(appendix?.metadata?.claudeEventType).toBe("queue-operation");
  });
});

/**
 * 阅读模式可见性标记。口径归后端(与 cleanClaudeUserMessage 同一份),前端只读标记。
 * 隐藏原因用枚举而非 boolean:前端要能分开处理(以后可能把 tool-only 压成一行摘要)。
 */
describe("claudeCodeHistory normalize — readingHidden", () => {
  function build(lines: string[]) {
    return buildClaudeSession({
      projectId: "proj",
      sessionId: "sid",
      parse: parseJsonlText(lines.join("\n")),
      fileMtimeMs: 0,
    }).session.messages;
  }
  const ts = '"timestamp":"2026-01-01T00:00:00.000Z","sessionId":"sid"';

  it("真人正文的 user 消息不隐藏", () => {
    const [m] = build([
      `{"type":"user","uuid":"u1",${ts},"message":{"role":"user","content":"帮我看下这个"}}`,
    ]);
    expect(m.metadata?.readingHidden).toBeUndefined();
  });

  it("纯 tool_result 的 user 消息 → tool-only", () => {
    const [m] = build([
      `{"type":"user","uuid":"u1",${ts},"message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_1","content":"ok"}]}}`,
    ]);
    expect(m.metadata?.readingHidden).toBe("tool-only");
  });

  it("剥完注入标记后为空的 user 消息 → injected", () => {
    const [m] = build([
      `{"type":"user","uuid":"u1",${ts},"message":{"role":"user","content":"<system-reminder>机器注入</system-reminder>"}}`,
    ]);
    expect(m.metadata?.readingHidden).toBe("injected");
  });

  it("有正文的 assistant 不隐藏", () => {
    const [m] = build([
      `{"type":"assistant","uuid":"a1",${ts},"message":{"role":"assistant","content":[{"type":"text","text":"好的"}]}}`,
    ]);
    expect(m.metadata?.readingHidden).toBeUndefined();
  });

  // R11:thinking-only 行的 content 是 ""(assistantFromContent 只拼 text 段),
  // 若「空消息」只看 content 会误杀这一类 —— 实测一个会话有 67 条。
  it("只有 thinking 的 assistant 不隐藏(不能按空 content 误杀)", () => {
    const [m] = build([
      `{"type":"assistant","uuid":"a1",${ts},"message":{"role":"assistant","content":[{"type":"thinking","thinking":"先看看文件"}]}}`,
    ]);
    expect(m.content).toBe("");
    expect(m.thinking).toBe("先看看文件");
    expect(m.metadata?.readingHidden).toBeUndefined();
  });

  it("只有 tool_use 的 assistant → tool-only", () => {
    const [m] = build([
      `{"type":"assistant","uuid":"a1",${ts},"message":{"role":"assistant","content":[{"type":"tool_use","id":"toolu_1","name":"Bash","input":{"command":"ls"}}]}}`,
    ]);
    expect(m.metadata?.readingHidden).toBe("tool-only");
  });

  it("非 user/assistant 事件行 → appendix", () => {
    const [m] = build([`{"type":"file-history-snapshot",${ts}}`]);
    expect(m.metadata?.readingHidden).toBe("appendix");
  });
});

/**
 * AskUserQuestion:题在 assistant 的 tool_use,答在下一条 user 行的顶层 toolUseResult。
 * 两者靠 tool_use_id 配对 —— 一个会话可能出现多次提问,没有 join key 就配不上。
 */
describe("claudeCodeHistory normalize — AskUserQuestion 题答配对", () => {
  const ts = '"timestamp":"2026-01-01T00:00:00.000Z","sessionId":"sid"';
  function build(lines: string[]) {
    return buildClaudeSession({
      projectId: "proj",
      sessionId: "sid",
      parse: parseJsonlText(lines.join("\n")),
      fileMtimeMs: 0,
    }).session.messages;
  }

  it("tool_use 的 id 保留进 ToolCall.id(否则无法配对)", () => {
    const [m] = build([
      `{"type":"assistant","uuid":"a1",${ts},"message":{"role":"assistant","content":[{"type":"tool_use","id":"toolu_ask1","name":"AskUserQuestion","input":{"questions":[{"question":"存到哪?","options":[{"label":"gbrain"}]}]}}]}}`,
    ]);
    expect(m.toolCalls?.[0]?.id).toBe("toolu_ask1");
    expect(m.toolCalls?.[0]?.name).toBe("AskUserQuestion");
  });

  it("答案从顶层 toolUseResult.answers 读进 metadata,并带上配对用的 tool_use_id", () => {
    const [m] = build([
      `{"type":"user","uuid":"u1",${ts},"toolUseResult":{"answers":{"存到哪?":"gbrain"}},"message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_ask1","content":"answered"}]}}`,
    ]);
    expect(m.metadata?.answers).toEqual({ "存到哪?": "gbrain" });
    expect(m.metadata?.answersForToolUseId).toBe("toolu_ask1");
  });

  it("被 hook 拦截(无 toolUseResult)→ 无 answers,不抛错", () => {
    const [m] = build([
      `{"type":"user","uuid":"u1",${ts},"message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_ask2","content":"x"}]}}`,
    ]);
    expect(m.metadata?.answers).toBeUndefined();
  });

  it("toolUseResult 非对象 → 安静忽略", () => {
    const [m] = build([
      `{"type":"user","uuid":"u1",${ts},"toolUseResult":"字符串","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t","content":"x"}]}}`,
    ]);
    expect(m.metadata?.answers).toBeUndefined();
  });
});
