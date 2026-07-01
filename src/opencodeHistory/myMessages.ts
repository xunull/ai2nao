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
 *  3. 斜杠命令展开(`/agents`→大模板)无标记、看着像真人 → 本轮残留,靠抽屉诚实文案兜底。
 */

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
    const cleaned = stripModePreamble(raw).trim();
    if (cleaned) texts.push(cleaned);
  }
  return texts.join("\n\n");
}

export function parsePartData(data: string): ParsedPart {
  try {
    return JSON.parse(data) as ParsedPart;
  } catch {
    return {};
  }
}
