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
    const appendix = session.messages.find(
      (m) => m.metadata?.claudeAppendix === true
    );
    expect(appendix?.metadata?.claudeEventType).toBe("queue-operation");
  });
});
