/**
 * 智能 JSON:把 appendix 事件的 ```json fence 解析成一棵便于渲染的树,并**递归解开
 * 「JSON 套在字符串里」**(JSON-in-string)。
 *
 * 背景(investigate 坐实):Claude appendix 事件正文 = JSON.stringify(整条记录,null,2)。
 * 其中 attachment.stdout 常是本身合法 JSON 的字符串(实测最大嵌套深 7),stringify 把它当
 * 普通字符串 → 内部换行/引号层层转义成一墙 \n \"。这里 parse 回来、把这类字符串再解成子树,
 * 长文本叶子按多行文本渲染,从根上消掉转义墙。
 *
 * 只对 appendix 事件用(前端分不出合成 fence 和真人写的 json 代码块,只有 appendix 有标记
 * 能安全区分)。顶层 parse 失败 / 超限 → 调用方降级回原始 Prism 渲染,绝不空白。
 */

export type SmartNode =
  | { kind: "object"; entries: [string, SmartNode][]; fromJsonString?: boolean }
  | { kind: "array"; items: SmartNode[]; fromJsonString?: boolean }
  /** 长文本叶子(含换行或够长)→ 渲染成多行 pre,显真实换行。 */
  | { kind: "text"; value: string }
  /** 短标量:string / number / boolean / null,行内渲染。 */
  | { kind: "scalar"; value: string | number | boolean | null }
  /** 到顶/超预算的占位,UI 提示「查看原文」。 */
  | { kind: "truncated"; reason: "depth" | "budget" };

// 递归深度上限(实测 JSON-in-string 最大嵌套 7,留 1 冗余)。
const MAX_DEPTH = 8;
// 规模预算:节点数 / 字符数,防巨型 stdout/数组一次性铺爆主线程。
const MAX_NODES = 5000;
const MAX_CHARS = 200_000;
// string 叶子:含换行或 ≥ 此长度 → 当长文本(多行 pre);否则短标量(行内)。
const LONG_TEXT = 200;

type Budget = { nodes: number; chars: number };

function overBudget(b: Budget): boolean {
  return b.nodes > MAX_NODES || b.chars > MAX_CHARS;
}

/** 解析后的值是否「非空对象/数组」—— 只有它才值得当 JSON-in-string 解嵌套(跳过 {} / [] / 基础类型)。 */
function isNonEmptyStructure(v: unknown): v is Record<string, unknown> | unknown[] {
  if (Array.isArray(v)) return v.length > 0;
  return typeof v === "object" && v !== null && Object.keys(v).length > 0;
}

function tryParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

function build(value: unknown, depth: number, b: Budget): SmartNode {
  b.nodes += 1;
  if (overBudget(b)) return { kind: "truncated", reason: "budget" };
  if (depth > MAX_DEPTH) return { kind: "truncated", reason: "depth" };

  if (value === null) return { kind: "scalar", value: null };

  const t = typeof value;
  if (t === "number" || t === "boolean") {
    b.chars += String(value).length;
    return { kind: "scalar", value: value as number | boolean };
  }

  if (t === "string") {
    const str = value as string;
    const trimmed = str.trim();
    // JSON-in-string:以 { 或 [ 开头、能干净 parse 成非空结构 → 递归解嵌套。
    if (trimmed[0] === "{" || trimmed[0] === "[") {
      const parsed = tryParse(str);
      if (isNonEmptyStructure(parsed)) {
        const node = build(parsed, depth + 1, b);
        if (node.kind === "object" || node.kind === "array") node.fromJsonString = true;
        return node;
      }
    }
    b.chars += str.length;
    // 含换行或够长 → 长文本叶子(多行);否则短标量(行内)。
    if (str.includes("\n") || str.length >= LONG_TEXT) return { kind: "text", value: str };
    return { kind: "scalar", value: str };
  }

  if (Array.isArray(value)) {
    const items: SmartNode[] = [];
    for (const el of value) {
      const node = build(el, depth + 1, b);
      items.push(node);
      if (node.kind === "truncated" && node.reason === "budget") break; // 超预算即止
    }
    return { kind: "array", items };
  }

  if (t === "object") {
    const entries: [string, SmartNode][] = [];
    // Object.entries 保留 string key 的 insertion order —— 调试日志依赖顺序,不排序。
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      b.chars += k.length;
      const node = build(v, depth + 1, b);
      entries.push([k, node]);
      if (node.kind === "truncated" && node.reason === "budget") break;
    }
    return { kind: "object", entries };
  }

  return { kind: "scalar", value: String(value) };
}

/**
 * 把一段 JSON 文本解析成 SmartNode 树。顶层必须是对象/数组(否则不值得树,返回 null 让调用方降级)。
 * parse 失败 / 半截 JSON → null。
 */
export function parseSmartJson(jsonText: string): SmartNode | null {
  const root = tryParse(jsonText);
  // 顶层非对象/数组(parse 失败的 undefined、null、基础类型)→ 不值得树,降级。
  if (root === null || typeof root !== "object") return null;
  return build(root, 0, { nodes: 0, chars: 0 });
}

/** 从 ```json fence 里抠出内层 JSON 文本;不是这种 fence → null。 */
export function extractJsonFence(content: string): string | null {
  const m = /^```json\s*\n([\s\S]*?)\n?```\s*$/.exec(content.trim());
  return m ? m[1] : null;
}
