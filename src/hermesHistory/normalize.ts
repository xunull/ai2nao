/**
 * hermes 原始行 → 展示 / 入库口径。本文件承载本设计里全部有争议的判断,
 * 每一条都有真库实测撑着(2026-09-01,120 场 / 1537 条)。
 */
import type { HermesSessionOrigin, HermesToolCall } from "./types.js";

/**
 * 清洗口径版本。改「assistant 正文取哪一层 / 工具摘要怎么拼」时 +1。
 * 1 = 三层回落(content → reasoning_content → 工具调用摘要)。
 */
export const CLEANER_VERSION = 1;

/**
 * 解析口径版本。改「收哪些行 / payload 存什么」时 +1。
 * 1 = 收 user + assistant;tool 结果折进宿主 assistant 的 payload;session_meta 丢弃。
 */
export const PARSER_VERSION = 1;

/** 归一 `sessions.source`。真库只出现过 cron / cli / feishu 三种。 */
export function normalizeOrigin(raw: string | null | undefined): HermesSessionOrigin {
  switch ((raw ?? "").trim().toLowerCase()) {
    case "cron":
      return "cron";
    case "cli":
      return "cli";
    case "feishu":
      return "feishu";
    default:
      return "other";
  }
}

// 这里原来有个 isHumanOrigin(origin) { return origin !== "cron" },注释写着
// 「列表页默认只看这些」—— 但全仓零调用:列表页是在前端自己写死
// `s.origin === "cron"` 过滤的(HermesHistory.tsx:94),而 web/ 与 src/ 是两个
// tsconfig,前端 import 不到这里。留着一个「看起来是真相源、其实改了没用」的
// 函数,正是同一天在 topicStream 里踩到的那个坑(CONVERSATION_SOURCES),故删除。

/**
 * 标题坏不坏。真库 120 场里 25 场是坏的(20 场 NULL + 5 场存了模型的 <think> 原文),
 * 而且坏的**全在人类侧**(cron 侧 87% 可用,人类侧只有 50%)。
 *
 * **不能用 `title_source` 列判**:那 5 场污染 + 20 场 NULL 的 `title_source` 全是 NULL,
 * 零判别力(实测 GROUP BY:NULL 98 场含全部坏标题 / user 21 场 / llm 1 场且是好标题)。
 */
export function isBadTitle(raw: string | null | undefined): boolean {
  const t = (raw ?? "").trim();
  if (!t) return true;
  return t.includes("<think");
}

const TITLE_MAX = 40;

/** 一行化 + 截断,给兜底标题和工具摘要共用。 */
function oneLine(s: string, max: number): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return [...flat].length > max ? `${[...flat].slice(0, max).join("")}…` : flat;
}

/**
 * 标题兜底:坏标题时取该会话首条 user 消息的开头。
 * 首条 user 也没有时给一个不撒谎的占位(不编内容)。
 */
export function resolveTitle(
  rawTitle: string | null | undefined,
  firstUserText: string | null | undefined
): { title: string; fallback: boolean } {
  if (!isBadTitle(rawTitle)) return { title: (rawTitle ?? "").trim(), fallback: false };
  const first = (firstUserText ?? "").trim();
  if (first) return { title: oneLine(first, TITLE_MAX), fallback: true };
  return { title: "(无标题)", fallback: true };
}

type RawToolCall = { callId: string; name: string; arguments: string };

/**
 * 解析 assistant 行的 `tool_calls` JSON。真库 649/649 条解析成功、零畸形,
 * 但这里仍然吞异常返回空数组 —— 上游是别人的库,不能因为它改格式就让整轮同步挂掉。
 */
export function parseToolCalls(rawJson: string | null | undefined): RawToolCall[] {
  const s = (rawJson ?? "").trim();
  if (!s) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(s);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: RawToolCall[] = [];
  for (const c of parsed) {
    if (!c || typeof c !== "object") continue;
    const rec = c as Record<string, unknown>;
    const fn = (rec.function ?? {}) as Record<string, unknown>;
    const name = typeof fn.name === "string" ? fn.name : typeof rec.name === "string" ? rec.name : "";
    const callId = typeof rec.id === "string" ? rec.id : "";
    if (!name || !callId) continue;
    const args = fn.arguments ?? rec.arguments;
    out.push({
      callId,
      name,
      arguments: typeof args === "string" ? args : args == null ? "" : JSON.stringify(args),
    });
  }
  return out;
}

const TOOL_SUMMARY_ARG_MAX = 80;

/**
 * 把工具调用拼成一行可读摘要,给三层回落的**第三层**用。
 * 例:`terminal: {"command": "date '+%Y-%m-%d'"}`
 *
 * 为什么这一层必须存在:真库里 725 条 assistant 有 225 条 content 与 reasoning 都空,
 * 而这 225 条**100% 带工具调用**。跳过它们会让 229 条 tool 结果失去宿主(649 的 35%);
 * 写空 cleaned_text 又会破掉一条 100% 成立的不变量 —— 现有四源 46595 条 assistant 行里
 * char_len=0 的是 0 条。
 */
export function summarizeToolCalls(calls: readonly RawToolCall[]): string {
  return calls
    .map((c) => {
      const a = oneLine(c.arguments, TOOL_SUMMARY_ARG_MAX);
      return a ? `${c.name}: ${a}` : c.name;
    })
    .join("\n");
}

export type AssistantText = { text: string; kind: "content" | "reasoning" | "tool-calls" };

/**
 * assistant 行的展示 / 索引正文,三层回落。真库分布:
 * ```
 * 有正文          291 条
 * 无正文·有推理   209 条   ← 全部带工具调用
 * 两者皆无        225 条   ← 全部带工具调用
 * ```
 * **tool 结果全文不进这里** —— 它留在 raw_payload_json。否则就是把工具输出
 * 伪装成「AI 说的话」,污染搜索页的 role='assistant' 筛子。
 */
export function assistantText(
  content: string | null | undefined,
  reasoning: string | null | undefined,
  calls: readonly RawToolCall[]
): AssistantText {
  const c = (content ?? "").trim();
  if (c) return { text: c, kind: "content" };
  const r = (reasoning ?? "").trim();
  if (r) return { text: r, kind: "reasoning" };
  return { text: summarizeToolCalls(calls), kind: "tool-calls" };
}

/** hermes 的 REAL unix epoch → ISO。非有限值回落到 epoch 0(与 opencode 的 dateFromMs 同口径)。 */
export function isoFromEpochSeconds(v: unknown): string {
  if (typeof v === "number" && Number.isFinite(v) && v > 0) {
    return new Date(v * 1000).toISOString();
  }
  return new Date(0).toISOString();
}

/** 把 tool 行按 tool_call_id 挂回宿主。真库 649/649 全部挂得上,零孤儿。 */
export function attachToolResults(
  calls: readonly RawToolCall[],
  resultsByCallId: ReadonlyMap<string, string>
): HermesToolCall[] {
  return calls.map((c) => ({
    callId: c.callId,
    name: c.name,
    arguments: c.arguments,
    result: resultsByCallId.get(c.callId) ?? null,
  }));
}
