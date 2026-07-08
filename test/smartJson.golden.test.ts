import { describe, expect, it } from "vitest";
import { parseSmartJson, extractJsonFence, type SmartNode } from "../web/src/util/smartJson.js";

/**
 * Golden —— 形态取自真实 Claude jsonl 的 hook_success attachment(截图那条):
 * attachment.stdout 是 JSON-in-string,里层 additionalContext 是带真实换行的长文本。
 * 断言智能 JSON 能把它解成可读结构、additionalContext 显真实换行、无 \n \" 转义墙。
 * 路径用 /tmp 占位(公开仓 + gitleaks 拦真实家目录)。
 */

function entry(node: SmartNode, key: string): SmartNode {
  if (node.kind !== "object") throw new Error("not object");
  const e = node.entries.find(([k]) => k === key);
  if (!e) throw new Error(`no key ${key}`);
  return e[1];
}

// 里层 hook 输出(本身是 JSON,被塞进 stdout 字符串)。additionalContext 含真实换行。
const HOOK_STDOUT = JSON.stringify({
  hookSpecificOutput: {
    hookEventName: "SessionStart",
    additionalContext:
      "<EXTREMELY_IMPORTANT>\nYou have superpowers.\n\ndot\ndigraph skill_flow {\n  a -> b;\n}\n</EXTREMELY_IMPORTANT>",
  },
});

// 外层 appendix 记录(mapRecordToMessage 会 JSON.stringify 它成 fence)。
const RECORD = {
  parentUuid: null,
  isSidechain: false,
  attachment: {
    type: "hook_success",
    hookName: "SessionStart:startup",
    hookEvent: "SessionStart",
    content: "",
    stdout: HOOK_STDOUT,
    stderr: "",
    exitCode: 0,
    command: '"/tmp/plugin/hooks/run-hook.cmd" session-start',
    durationMs: 103,
  },
  type: "attachment",
  uuid: "c4bba162-f855-40e3-bcd6-94ecbae1f90a",
  timestamp: "2026-06-09T02:39:20.525Z",
  userType: "external",
};

const FENCE = "```json\n" + JSON.stringify(RECORD, null, 2) + "\n```";

describe("smartJson golden —— 真实 hook_success attachment", () => {
  it("从 fence 抠出、解嵌套 stdout、additionalContext 显真实换行无转义墙", () => {
    const inner = extractJsonFence(FENCE);
    expect(inner).not.toBeNull();
    const root = parseSmartJson(inner!)!;
    expect(root.kind).toBe("object");

    const att = entry(root, "attachment");
    const stdout = entry(att, "stdout");
    // stdout 本是字符串 → 解嵌套成对象并标来源。
    expect(stdout.kind).toBe("object");
    expect((stdout as { fromJsonString?: boolean }).fromJsonString).toBe(true);

    const addCtx = entry(entry(stdout, "hookSpecificOutput"), "additionalContext");
    expect(addCtx.kind).toBe("text"); // 长文本叶子
    const text = (addCtx as { value: string }).value;
    // 真实换行、无 \n \" 转义残留。
    expect(text).toContain("You have superpowers.\n");
    expect(text).toContain("digraph skill_flow");
    expect(text).not.toContain("\\n");

    // exitCode 是数字标量、命令路径已占位。
    expect(entry(att, "exitCode")).toEqual({ kind: "scalar", value: 0 });
    expect((entry(att, "command") as { value: string }).value).toContain("/tmp/");
  });
});
