/**
 * SmartJsonView —— 把 smartJson.ts 解出的 SmartNode 树渲染成可读结构。
 *
 * 对象/数组 → 缩进 + 可折叠子树(大子树默认折叠);长文本叶子 → 多行 pre(显真实换行,
 * 消掉 JSON-in-string 的转义墙);短标量 → 行内。解析自字符串的节点标小徽标,提示这原本是
 * 一段被塞进字符串的 JSON。
 *
 * 安全:全部作文本 / React 节点渲染,绝不 dangerouslySetInnerHTML。
 */
import type { ReactNode } from "react";
import type { SmartNode } from "../util/smartJson";

// 子节点数超过此值 → 该对象/数组默认折叠,避免一次性铺开大结构。
const COLLAPSE_OVER = 30;

function ScalarValue({ value }: { value: string | number | boolean | null }) {
  if (value === null) return <span className="text-neutral-400">null</span>;
  if (typeof value === "boolean")
    return <span className="text-amber-600">{String(value)}</span>;
  if (typeof value === "number")
    return <span className="text-blue-600">{value}</span>;
  return <span className="text-emerald-700">"{value}"</span>;
}

function FromJsonBadge() {
  return (
    <span className="ml-1 rounded bg-violet-100 px-1 py-0.5 align-middle text-[10px] font-medium text-violet-700">
      ⤷ 解析自字符串
    </span>
  );
}

function TruncatedNode({ reason }: { reason: "depth" | "budget" }) {
  return (
    <span className="text-[11px] italic text-neutral-400">
      {reason === "depth" ? "… 已达最大嵌套深度,查看原文" : "… 内容过大已截断,查看原文"}
    </span>
  );
}

// 一个「键: 值」行 / 数组项;值是对象/数组时可折叠。
function NodeRow({ node, label }: { node: SmartNode; label: ReactNode }) {
  const isBranch = node.kind === "object" || node.kind === "array";
  if (!isBranch) {
    return (
      <div className="flex flex-wrap gap-1">
        {label}
        <SmartJsonNode node={node} />
      </div>
    );
  }
  const count = node.kind === "object" ? node.entries.length : node.items.length;
  const defaultOpen = count <= COLLAPSE_OVER;
  const summary =
    node.kind === "object" ? `{…} ${count} 项` : `[…] ${count} 项`;
  return (
    <details open={defaultOpen} className="min-w-0">
      <summary className="cursor-pointer select-none list-none">
        {label}
        <span className="text-neutral-400">{summary}</span>
        {node.fromJsonString && <FromJsonBadge />}
      </summary>
      <div className="ml-4 border-l border-neutral-200 pl-3">
        <SmartJsonNode node={node} />
      </div>
    </details>
  );
}

/** 渲染一个 SmartNode 的「内容」(不含它作为某行的 key 标签)。 */
export function SmartJsonNode({ node }: { node: SmartNode }) {
  switch (node.kind) {
    case "truncated":
      return <TruncatedNode reason={node.reason} />;
    case "text":
      return (
        <pre className="mt-0.5 overflow-x-auto whitespace-pre-wrap break-words rounded bg-slate-50 px-2 py-1 text-[11px] leading-relaxed text-neutral-700">
          {node.value}
        </pre>
      );
    case "scalar":
      return <ScalarValue value={node.value} />;
    case "object":
      return (
        <div className="space-y-0.5">
          {node.entries.map(([k, child], i) => (
            <NodeRow
              key={`${k}-${i}`}
              node={child}
              label={<span className="font-medium text-sky-800">{k}:</span>}
            />
          ))}
        </div>
      );
    case "array":
      return (
        <div className="space-y-0.5">
          {node.items.map((child, i) => (
            <NodeRow
              key={i}
              node={child}
              label={<span className="text-neutral-400">{i}:</span>}
            />
          ))}
        </div>
      );
  }
}

export function SmartJsonView({ node }: { node: SmartNode }) {
  return (
    <div className="font-mono text-xs text-neutral-800">
      <SmartJsonNode node={node} />
    </div>
  );
}
