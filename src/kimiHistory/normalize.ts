import { createHash } from "node:crypto";
import type { KimiMessage } from "./types.js";

/** 清洗口径版本。改判据必须 bump —— 与 claude/codex 的 CLEANER_VERSION 同语义。 */
export const KIMI_CLEANER_VERSION = 1;
export const KIMI_PARSER_VERSION = 1;


/**
 * 桌面版沙箱给每条真人消息加的控制标签,transcripts 那一层已经剥掉,wire 这层没有。
 * 实测:`<meta>` 43/43 条桌面消息全带,`<attachment>` 3 条;CLI 的 119 条一个都没有。
 *
 * 不剥的后果与 claude 的 bash-* 分叉(TODOS:1314)完全同类:标签文本被当人类词汇
 * 写进 agent_user_messages_fts,以后搜自己的提问会搜到 `<meta awareness=...>` 这种噪音,
 * 而且同一句话在两层里长得不一样,没法跨层对账。
 *
 *   <meta awareness="low" timestamp="..." />   会话开场的元信息,不是用户打的字
 *   <attachment>{"type":"image","path":...}</attachment>   附件**引用**(路径+大小),不是内容
 */
const META_TAG = /<meta\b[^>]*\/?>\s*/g;
const ATTACHMENT_BLOCK = /\s*<attachment>[\s\S]*?<\/attachment>\s*/g;

/** raw → 可搜索正文。改这里必须 bump KIMI_CLEANER_VERSION。 */
export function cleanKimiUserText(raw: string): string {
  return raw.replace(META_TAG, "").replace(ATTACHMENT_BLOCK, "").trim();
}

type WireEvent = {
  type?: unknown;
  time?: unknown;
  message?: {
    id?: unknown;
    role?: unknown;
    origin?: unknown;
    content?: unknown;
  };
  event?: {
    type?: unknown;
    uuid?: unknown;
    turnId?: unknown;
    step?: unknown;
    part?: { type?: unknown; text?: unknown };
  };
};

/**
 * 真人判据。**两个取值都算人**:
 *   origin.kind === "user"   带 origin 的正常情况(实测 80 条)
 *   origin === null/缺失     实测 82 条,全是真人打的字,只出现在 2026-08-11 之后
 *
 * 其余 kind(injection / task / background_task / system_trigger / shell_command)
 * 是 kimi 自己注入的上下文,入库留底但 is_human=0 —— 与 claude 的留底噪音同待遇。
 */
function originKindOf(message: NonNullable<WireEvent["message"]>): string | null {
  const o = message.origin;
  if (o === null || o === undefined) return null;
  if (typeof o === "object" && o !== null && "kind" in o) {
    const k = (o as { kind?: unknown }).kind;
    return typeof k === "string" ? k : null;
  }
  return null;
}

function isHumanOrigin(kind: string | null): boolean {
  return kind === null || kind === "user";
}

/** content 是 part 数组,取所有 text part 拼起来(user 侧实测全是 text,无 tool_result)。 */
function textOfContent(content: unknown): string {
  if (!Array.isArray(content)) return "";
  let out = "";
  for (const p of content) {
    if (p && typeof p === "object" && typeof (p as { text?: unknown }).text === "string") {
      out += (p as { text: string }).text;
    }
  }
  return out;
}

function stableHumanKey(agent: string, timeMs: number, text: string): string {
  const h = createHash("sha1").update(text).digest("hex").slice(0, 12);
  return `${agent}:t${timeMs}:${h}`;
}

export type KimiParseResult = {
  messages: KimiMessage[];
  /**
   * 同一 (turnId, step) 出现了多个 text part 的次数。
   *
   * 实测当前 1225 个 text part 里这个数是 0 —— 一个 part 就是一条完整消息,不需要
   * 聚合。但那是 16 个会话一种用法下的经验值,不是结构保证:重试、超长输出或换模型
   * 都可能让一轮吐出多段。所以把它记成可观察的数,而不是一个沉默的假设 ——
   * ingest 侧发现它 > 0 会把整轮标成 partial 并写进 lastError,而不是静默产生碎片行。
   */
  multiPartTurns: number;
};

/**
 * 解析一个 agent 的 wire.jsonl。人和 AI 走同一遍扫描,因为 AI 的锚点靠位置:
 * 同文件里出现在它前面、最近的那条真人消息(turn.prompt 事件不带 turnId,
 * content.part 的 turnId 对不上任何东西,所以只能用顺序 —— 与 claude/codex 同法)。
 */
export function parseKimiWire(
  lines: Iterable<string>,
  opts: { agent: string }
): KimiParseResult {
  const messages: KimiMessage[] = [];
  let lastHumanKey: string | null = null;
  const seenTurnStep = new Map<string, number>();
  let multiPartTurns = 0;

  for (const line of lines) {
    const s = line.trim();
    if (!s) continue;
    let d: WireEvent;
    try {
      d = JSON.parse(s) as WireEvent;
    } catch {
      continue; // 坏行跳过 —— 追加写的文件末尾可能是半行
    }
    const timeMs = typeof d.time === "number" ? d.time : 0;

    if (d.type === "context.append_message" && d.message) {
      const kind = originKindOf(d.message);
      const text = textOfContent(d.message.content);
      if (!text.trim()) continue;
      const cleaned = cleanKimiUserText(text);
      // 剥完标签只剩空的(纯 <meta/> 的心跳消息)也不写 —— 否则往 FTS 塞空串。
      if (!cleaned) continue;
      const human = isHumanOrigin(kind);
      const id = typeof d.message.id === "string" ? d.message.id : null;
      // key 用剥完的正文算:同一句话在两层里 raw 不同、cleaned 相同。
      const key = id ?? stableHumanKey(opts.agent, timeMs, cleaned);
      messages.push({
        messageKey: key,
        role: "user",
        eventAtMs: timeMs,
        text,
        cleanedText: cleaned,
        originKind: kind,
        isHuman: human,
        answeringUserKey: null,
        rawPayloadJson: s,
      });
      if (human) lastHumanKey = key;
      continue;
    }

    if (d.type === "context.append_loop_event" && d.event?.type === "content.part") {
      const part = d.event.part;
      // think 是 3.14 MB 的思考过程,不是回答,不入库。
      if (!part || part.type !== "text") continue;
      const text = typeof part.text === "string" ? part.text : "";
      if (!text.trim()) continue;
      const uuid = typeof d.event.uuid === "string" ? d.event.uuid : null;
      if (!uuid) continue; // 没有稳定 id 的 part 不入库,好过造一个会漂的键

      const turnKey = `${String(d.event.turnId ?? "")}#${String(d.event.step ?? "")}`;
      const prev = seenTurnStep.get(turnKey) ?? 0;
      seenTurnStep.set(turnKey, prev + 1);
      if (prev === 1) multiPartTurns++; // 第二次见到才算一次「多 part 轮」

      messages.push({
        messageKey: uuid,
        role: "assistant",
        eventAtMs: timeMs,
        text,
        cleanedText: text,
        originKind: null,
        isHuman: false,
        answeringUserKey: lastHumanKey,
        rawPayloadJson: s,
      });
    }
  }

  return { messages, multiPartTurns };
}
