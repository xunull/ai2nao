import { describe, expect, it } from "vitest";
import {
  parseSmartJson,
  extractJsonFence,
  type SmartNode,
} from "../web/src/util/smartJson.js";

// 从 object 节点按 key 取子节点。
function entry(node: SmartNode, key: string): SmartNode {
  if (node.kind !== "object") throw new Error("not object");
  const e = node.entries.find(([k]) => k === key);
  if (!e) throw new Error(`no key ${key}`);
  return e[1];
}

describe("smartJson —— 解嵌套 + 树", () => {
  it("顶层非对象/数组 → null(降级)", () => {
    expect(parseSmartJson("123")).toBeNull();
    expect(parseSmartJson('"hi"')).toBeNull();
    expect(parseSmartJson("null")).toBeNull();
    expect(parseSmartJson("{ 半截")).toBeNull(); // parse 失败
  });

  it("JSON-in-string 递归解开,标 fromJsonString,里层长文本叶子显真实换行", () => {
    const inner = JSON.stringify({ hookSpecificOutput: { ctx: "line1\nline2 长文本".padEnd(210, "x") } });
    const raw = JSON.stringify({ type: "hook_success", stdout: inner });
    const root = parseSmartJson(raw)!;
    expect(root.kind).toBe("object");
    const stdout = entry(root, "stdout");
    // stdout 本是字符串,解嵌套成对象并标记来源。
    expect(stdout.kind).toBe("object");
    expect((stdout as { fromJsonString?: boolean }).fromJsonString).toBe(true);
    const ctx = entry(entry(stdout, "hookSpecificOutput"), "ctx");
    expect(ctx.kind).toBe("text"); // 长文本叶子
    expect((ctx as { value: string }).value).toContain("line1\nline2"); // 真实换行,无转义
  });

  it("空 {} / [] / 短串不解嵌套(452 噪音闸)", () => {
    const raw = JSON.stringify({ a: "{}", b: "[]", c: "{x", d: "hi" });
    const root = parseSmartJson(raw)!;
    expect(entry(root, "a").kind).toBe("scalar"); // "{}" 当短标量,不展成空对象
    expect(entry(root, "b").kind).toBe("scalar");
    expect(entry(root, "c").kind).toBe("scalar"); // parse 失败 → 文本
    expect(entry(root, "d")).toEqual({ kind: "scalar", value: "hi" });
  });

  it("非空但短的 JSON-in-string 也解(严闸只卡空,不卡短)", () => {
    const raw = JSON.stringify({ v: '{"ok":true}' });
    const v = entry(parseSmartJson(raw)!, "v");
    expect(v.kind).toBe("object");
    expect((v as { fromJsonString?: boolean }).fromJsonString).toBe(true);
  });

  it("含换行的字符串 → text 叶子;短无换行 → scalar", () => {
    const root = parseSmartJson(JSON.stringify({ multi: "a\nb", one: "short" }))!;
    expect(entry(root, "multi").kind).toBe("text");
    expect(entry(root, "one").kind).toBe("scalar");
  });

  it("保留 key insertion order(不排序,调试日志依赖)", () => {
    const root = parseSmartJson(JSON.stringify({ z: 1, a: 2, m: 3 }))!;
    if (root.kind !== "object") throw new Error();
    expect(root.entries.map(([k]) => k)).toEqual(["z", "a", "m"]);
  });

  it("递归深度超上限 → truncated:depth", () => {
    // 造 12 层嵌套对象。
    let v: unknown = { leaf: 1 };
    for (let i = 0; i < 12; i++) v = { n: v };
    const root = parseSmartJson(JSON.stringify(v))!;
    // 一路下钻,应在某层撞到 truncated:depth。
    let cur: SmartNode = root;
    let hitDepth = false;
    for (let i = 0; i < 20 && cur.kind === "object"; i++) {
      const next = cur.entries[0]?.[1];
      if (!next) break;
      if (next.kind === "truncated" && next.reason === "depth") { hitDepth = true; break; }
      cur = next;
    }
    expect(hitDepth).toBe(true);
  });

  it("规模超预算 → 某处出现 truncated:budget", () => {
    const big = Array.from({ length: 6000 }, (_, i) => i);
    const root = parseSmartJson(JSON.stringify({ arr: big }))!;
    const arr = entry(root, "arr");
    expect(arr.kind).toBe("array");
    if (arr.kind !== "array") throw new Error();
    expect(arr.items.some((n) => n.kind === "truncated" && n.reason === "budget")).toBe(true);
  });

  it("extractJsonFence:抠出 json fence 内层;非该形状 → null", () => {
    expect(extractJsonFence('```json\n{"a":1}\n```')).toBe('{"a":1}');
    expect(extractJsonFence("just text")).toBeNull();
  });
});
