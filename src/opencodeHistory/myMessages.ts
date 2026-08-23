/**
 * opencode「我的输入（已过滤注入）」清洗。opencode/oh-my-opencode 的注入**没有单一干净信号**,
 * 清洗只能 best-effort。核心原则:**误删 > 漏删** —— 过度 strip 删掉真人内容,比漏掉注入更糟。
 * 边界不明确一律保留原文,绝不静默删。
 *
 * 分层处理(见设计文档 20260630-design-opencode-my-messages-drawer.md §2/§4):
 *  1. 结构丢(有标记):part.metadata.kind==="editor_context"（IDE 文件打开注入）、
 *     part.metadata.compaction_continue===true（compaction 续写）、part.synthetic===true（插件块）。
 *  2. mode 块保守锚定前缀剥:oh-my-opencode 把 `[search-mode]`/`[analyze-mode]` 等 prepend 进同一
 *     text part、`---` 分隔。只在**文本开头**按 `---` 分段,逐块吃掉命中已知锚(mode 头 / MANDATORY
 *     delegate_task）的前导块,**遇第一个非前导块即停、保留其及其后全部**（含正文里的 `---`/HR）。
 *  3. 斜杠命令调用(`/agents`→大模板):调用是你的输入 → 压成紧凑 `/名字`(展开全文留
 *     raw_payload)。用户裁定,与 claude/codex 一致(2026-07-04)。
 */

import type { OpencodeRawMessage, OpencodeRawPart } from "./stateDb.js";
import { parseDataUri, putBlob } from "../blobStore.js";

export type ParsedPart = {
  type?: string;
  text?: string;
  synthetic?: boolean;
  metadata?: { kind?: string; compaction_continue?: boolean } | null;
};

/** 行首匹配 oh-my-opencode mode 头,如 `[search-mode]`、`[analyze-mode]`。 */
const MODE_HEADER = /^\[[a-z0-9-]+-mode\]/i;
/** oh-my-opencode 的 `MANDATORY delegate_task …` 前导块。 */
const MANDATORY_HEADER = /^MANDATORY delegate_task/i;
/** 仅由 `---` 组成的分隔行（前后可有空白）。 */
const HR_LINE = /^\s*---\s*$/;

/** 有结构标记的注入 → 整条 part 丢。 */
export function isStructuralInjection(pd: ParsedPart): boolean {
  if (pd.synthetic === true) return true;
  const kind = pd.metadata?.kind;
  if (kind === "editor_context") return true;
  if (pd.metadata?.compaction_continue === true) return true;
  return false;
}

/**
 * oh-my-opencode 背景任务 / 系统提醒注入:整段是 `<system-reminder>…OMO_INTERNAL_INITIATOR…>`
 * 这类机器通知,冒充 user 轮但**无 synthetic 标记**(实测占 user text part ~71%,1266 条)。
 * 靠内容标记整条丢:
 * - 含 `OMO_INTERNAL_INITIATOR`(oh-my-opencode 内部标记,真人绝不会打)→ 丢。
 * - 完整 `<system-reminder>…</system-reminder>` 块(需开+闭标签,prefer-preserve:引用片段不误伤)→ 丢。
 */
function isOmoInjection(text: string): boolean {
  if (text.includes("OMO_INTERNAL_INITIATOR")) return true;
  const t = text.trimStart();
  if (t.startsWith("<system-reminder>") && text.includes("</system-reminder>")) return true;
  return false;
}

/** 一个 `---` 分段的首个非空行是否命中已知前导锚。 */
function isPreambleSegment(seg: string): boolean {
  const firstLine = seg.split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? "";
  return MODE_HEADER.test(firstLine) || MANDATORY_HEADER.test(firstLine);
}

/**
 * 保守锚定前缀剥:只在文本**开头**处理,绝不扫进正文。
 * - 不以 mode 头开头 → 原样返回(可能是真人以 `---`/YAML 开头的正文，保留)。
 * - 无 `---` 边界(单段)→ 原样返回(边界不明确,prefer-preserve;含用户真打 `[x-mode]` 的情况)。
 * - 逐前导段吃掉,遇第一个非前导段即停,保留其及其后全部(rejoin,还原正文里的 `---`)。
 * - 全部段都是前导 → 返回 ""（纯注入,该 message 会被省略）。
 */
export function stripModePreamble(text: string): string {
  if (!MODE_HEADER.test(text.trimStart())) return text;

  const lines = text.split("\n");
  const segs: string[] = [];
  let cur: string[] = [];
  for (const line of lines) {
    if (HR_LINE.test(line)) {
      segs.push(cur.join("\n"));
      cur = [];
    } else {
      cur.push(line);
    }
  }
  segs.push(cur.join("\n"));

  if (segs.length < 2) return text; // 无 --- 边界 → 保留

  let i = 0;
  while (i < segs.length && isPreambleSegment(segs[i])) i++;
  if (i === 0) return text; // 首段其实不是前导 → 保留
  if (i >= segs.length) return ""; // 全是前导 → 纯注入

  return segs.slice(i).join("\n---\n").trim();
}

/**
 * 清洗一条 user message 的全部 part → 拼出「我的输入」文本（可能为空 = 该 message 应省略）。
 * 非 text part 忽略;结构注入整条丢;mode 块保守剥;多 text part 按**原顺序**空行 join。
 */
export function cleanOpencodeUserMessageParts(parts: ParsedPart[]): string {
  const texts: string[] = [];
  for (const pd of parts) {
    if (pd.type !== "text") continue;
    if (isStructuralInjection(pd)) continue;
    const raw = typeof pd.text === "string" ? pd.text : "";
    if (isOmoInjection(raw)) continue;
    const cleaned = stripModePreamble(raw).trim();
    if (cleaned) texts.push(cleaned);
  }
  const joined = texts.join("\n\n");
  // 斜杠命令调用是你的输入 → 显示紧凑 /名字(展开的技能全文留 raw_payload)。用户裁定,三源一致。
  const cmd = detectSlashCommand(joined);
  if (cmd) return `/${cmd.name}`;
  return joined;
}

export function parsePartData(data: string): ParsedPart {
  try {
    return JSON.parse(data) as ParsedPart;
  } catch {
    return {};
  }
}

/**
 * 把 `file` part 里内联的 `data:` URI 抽进 blob 仓,原地换成一个引用桩。
 *
 * 真库实测:129 段内联附件共 53.2 MB(平均 422 KB / 最大 3.6 MB),让 1934 行
 * opencode 消息的 `raw_payload_json` 占到 65.8 MB,而真正的正文只有 12 MB。
 *
 * 只动 `data:` 开头的 —— `file://` 那种是本地路径引用,本身就几个字节,动它没收益。
 *
 * **返回的仍然是 JSON 字符串**,因为载荷是「字符串数组的 JSON」,
 * 而 `recleanOpencodeFromPayload` 做的是 `arr.map(x => String(x))` 再 parse。
 * 塞一个对象进去会变成 `"[object Object]"`,往返就断了。
 *
 * blob 写失败时**原样返回**:宁可继续占地方,也不能出现「正文剥了、blob 没写成」
 * 那种两头落空的行。
 */
export function slimPartData(data: string): string {
  let parsed: ParsedPart & { url?: unknown; mime?: unknown; filename?: unknown };
  try {
    parsed = JSON.parse(data) as typeof parsed;
  } catch {
    return data; // 坏 JSON 原样留底,重清洗时自会跳过
  }
  if (parsed.type !== "file" || typeof parsed.url !== "string") return data;
  const decoded = parseDataUri(parsed.url);
  if (!decoded) return data; // file:// 引用或坏 URI —— 不动

  const ref = putBlob(decoded.bytes, decoded.mime ?? (typeof parsed.mime === "string" ? parsed.mime : null));
  if (!ref) return data; // 写不成就不剥

  const stub: Record<string, unknown> = { ...parsed };
  delete stub.url;
  stub.blob = { sha256: ref.sha256, bytes: ref.bytes, mime: ref.mime };
  return JSON.stringify(stub);
}

/**
 * oh-my-opencode 斜杠命令展开:`/graphify` 展成 ~2000 字模板,清洗后的正文**开头**是
 * `<auto-slash-command>` 标记 + `# /<name> Command` 头。抽屉据此折叠。
 *
 * 保守 + prefer-preserve(承 mode 剥的原则,codex 加固):
 * - 只在文本**开头**锚定(`^`),mid-text 的 marker 不算(用户可能引用它)。
 * - 有 marker 但提取不到合法命令名头 → 返回 null(不折叠,当普通文本,不藏内容)。
 * - 命令名放宽到 `[A-Za-z0-9._:-]`(容 `foo-bar`/`foo:bar`/`ns.cmd`)。
 * - marker 与 header 间容 CRLF / 空行(`\s*`),但 marker 必须在 char 0(不容任意前缀空白)。
 * - 版本漂移(标记/头格式变)→ 失配 → null → 普通显示,不崩。
 */
const SLASH_COMMAND_RE =
  /^<auto-slash-command>\s*#\s*\/([A-Za-z0-9][A-Za-z0-9._:-]*)\s+Command/;

export function detectSlashCommand(cleanedText: string): { name: string } | null {
  const m = SLASH_COMMAND_RE.exec(cleanedText);
  return m ? { name: m[1] } : null;
}

/**
 * 清洗口径版本。**改动任何清洗规则(isStructuralInjection / isOmoInjection /
 * stripModePreamble / cleanOpencodeUserMessageParts)必须 bump**,触发 agent_user_messages
 * 的 cleaner_version 回填(从 raw_payload_json 从头重算)。有 pin 测试逼出有意识的版本升。
 */
// v2(2026-07-04):斜杠命令调用 → 显示紧凑 /名字(用户裁定:调用是我的输入,与 claude/codex 一致)。
export const CLEANER_VERSION = 2;
/** 解析口径版本:改 part→text 组装 / role 判定 / 时间解析时 bump。 */
export const PARSER_VERSION = 1;

export type ExtractedOpencodeUserMessage = {
  messageId: string;
  /** 语义时间:优先 data.time.created,回落 message.time_created 列(ms)。 */
  eventAtMs: number;
  /** 逐字拼接的 text part(不做注入过滤,raw 留底轨)。 */
  rawText: string;
  /** 完整原始 part.data JSON 数组的 JSON(D6:无 per-part 上限,供 cleaner 升级后重清洗)。 */
  rawPayloadJson: string;
  /** 注入清洗后的「我的输入」。 */
  cleanedText: string;
  /** cleanedText 非空 => true。 */
  isHuman: boolean;
};

/** 按 messageId 归组原始 part(保留原始 data,供 extractor 内部解析)。 */
export function groupRawPartsByMessage(
  parts: OpencodeRawPart[]
): Map<string, OpencodeRawPart[]> {
  const byMsg = new Map<string, OpencodeRawPart[]>();
  for (const p of parts) {
    const arr = byMsg.get(p.messageId);
    if (arr) arr.push(p);
    else byMsg.set(p.messageId, [p]);
  }
  return byMsg;
}

/**
 * 单一真相(D5):从**原始** message + 它的原始 parts 抽「用户消息」。抽屉与 ingest 共用。
 * - **role==='user' 门在此**(两个调用点不再各自判、不再重复)。非 user → null。
 * - 产 4 轨:raw_text / raw_payload_json(完整结构,可重清洗) / cleaned_text / is_human。
 * - 纯注入的 user 消息也返回(cleanedText='' / isHuman=false),由调用方决定留底(ingest)
 *   还是省略(抽屉)。
 */
export function extractOpencodeUserMessage(
  message: OpencodeRawMessage,
  rawParts: OpencodeRawPart[]
): ExtractedOpencodeUserMessage | null {
  let role: string | undefined;
  let eventAtMs = message.timeCreated;
  try {
    const d = JSON.parse(message.data) as {
      role?: string;
      time?: { created?: number };
    };
    role = d.role;
    if (typeof d.time?.created === "number" && d.time.created > 0) {
      eventAtMs = d.time.created;
    }
  } catch {
    // 坏 JSON:role 未知 → 非 user,省略。
  }
  if (role !== "user") return null;

  const parsed = rawParts.map((p) => parsePartData(p.data));
  const rawText = parsed
    .filter((pd) => pd.type === "text" && typeof pd.text === "string")
    .map((pd) => pd.text as string)
    .join("\n\n");
  // 附件本体不进载荷 —— 见 slimPartData 的注释。写不成 blob 就原样保留,
  // 绝不在没写成的情况下把正文剥掉。
  const rawPayloadJson = JSON.stringify(rawParts.map((p) => slimPartData(p.data)));
  const cleanedText = cleanOpencodeUserMessageParts(parsed);
  return {
    messageId: message.id,
    eventAtMs,
    rawText,
    rawPayloadJson,
    cleanedText,
    isHuman: cleanedText.trim().length > 0,
  };
}

/** assistant 轮抽出来的一行 + 它的 token 向量。 */
export type ExtractedOpencodeAssistantMessage = {
  messageId: string;
  eventAtMs: number;
  /** 逐字拼接的 text part。**不含 reasoning** —— 与另外三家一致,不存思考正文。 */
  text: string;
  /** `message.data.tokens`。opencode 是四个源里唯一逐消息带完整向量的。 */
  tokens: OpencodeMessageTokens | null;
};

/** 原子分量,不含任何可派生的量。全 0 表示这条消息没有 token 信息。 */
export type OpencodeMessageTokens = {
  freshInput: number;
  cacheReadInput: number;
  cacheCreationInput: number;
  output: number;
  reasoningOutput: number;
};

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0;
}

/**
 * 抽 assistant 轮。与 `extractOpencodeUserMessage` 分开而不是给它加 role 参数 ——
 * 那个函数被「我的输入」抽屉(`load.ts:175`)与 ingest 共用,就地放宽会让抽屉
 * 开始渲染 AI 消息。
 *
 * **正文只取 `text` part。** assistant 的 `tool` part 序列化后是 166.29 MB
 * (实测),把它们也留底会往库里加 184 MB —— 比正在修的 58 MB 问题糟三倍。
 * 所以照 claude 的做法(`claudeCodeHistory/myMessages.ts:172`),
 * `raw_payload_json` 只存正文本身。
 *
 * 返回 null 的两种情况:非 assistant 轮、或没有可读正文(纯 tool/step 的轮)。
 * 后者**整行不写** —— 与 claude 的「纯 thinking 行跳过而不是写空串」同一条规矩,
 * 否则空正文会污染 FTS。
 */
export function extractOpencodeAssistantMessage(
  message: OpencodeRawMessage,
  rawParts: OpencodeRawPart[]
): ExtractedOpencodeAssistantMessage | null {
  let role: string | undefined;
  let eventAtMs = message.timeCreated;
  let tokens: OpencodeMessageTokens | null = null;
  try {
    const d = JSON.parse(message.data) as {
      role?: string;
      time?: { created?: number };
      tokens?: {
        input?: number;
        output?: number;
        reasoning?: number;
        cache?: { read?: number; write?: number };
      };
    };
    role = d.role;
    if (typeof d.time?.created === "number" && d.time.created > 0) {
      eventAtMs = d.time.created;
    }
    if (d.tokens) {
      tokens = {
        freshInput: num(d.tokens.input),
        cacheReadInput: num(d.tokens.cache?.read),
        cacheCreationInput: num(d.tokens.cache?.write),
        output: num(d.tokens.output),
        reasoningOutput: num(d.tokens.reasoning),
      };
    }
  } catch {
    return null; // 坏 JSON:role 未知 → 不当 assistant 处理
  }
  if (role !== "assistant") return null;

  const text = rawParts
    .map((p) => parsePartData(p.data))
    .filter((pd) => pd.type === "text" && typeof pd.text === "string")
    .map((pd) => pd.text as string)
    .join("\n\n");

  // 没有正文的轮(纯 tool / step)整行不写,但 token 仍要入事件表 ——
  // 调用方据此区分:正文侧 2260 条,事件侧 7430 条。
  if (!text.trim()) {
    return tokens ? { messageId: message.id, eventAtMs, text: "", tokens } : null;
  }
  return { messageId: message.id, eventAtMs, text, tokens };
}

/**
 * 从 raw_payload_json 重算 cleaned/is_human(D10 cleaner_version 回填用)。
 * payload = extractOpencodeUserMessage 存的「原始 part.data 数组」,故重清洗输入与
 * 首次入库完全一致 → 往返可复现(T8 round-trip 测试)。坏 payload → 空清洗,不崩。
 */
export function recleanOpencodeFromPayload(rawPayloadJson: string): {
  cleanedText: string;
  isHuman: boolean;
} {
  let dataStrings: string[] = [];
  try {
    const arr = JSON.parse(rawPayloadJson) as unknown;
    if (Array.isArray(arr)) dataStrings = arr.map((x) => String(x));
  } catch {
    // 坏 payload → 空清洗(留底行仍在,只是重算为空)
  }
  const cleanedText = cleanOpencodeUserMessageParts(
    dataStrings.map((d) => parsePartData(d))
  );
  return { cleanedText, isHuman: cleanedText.trim().length > 0 };
}
