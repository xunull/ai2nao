/**
 * Codex「我说的」清洗 —— 后端权威版(option C:清洗归后端,抽屉/ingest 共用)。
 *
 * 逐字移植自原前端 `web/src/lib/cleanCodexUserMessage.ts`(现改为调本模块的后端端点)。
 * parity 测试锁死一致。
 *
 * codex 把每条 user 记两遍、且 AGENTS.md 注入也算 user,所以先按
 * `metadata.codexSource === "event_msg"` 过滤(干净的真人输入信号),再丢 codex-exec 样板。
 */
import type { Message } from "../cursorHistory/types.js";

export const CODEX_CLEANER_VERSION = 1;
export const CODEX_PARSER_VERSION = 1;

/**
 * gstack 外部声音 / codex exec 注入的文件系统边界样板 prompt 开头
 * (见 /plan-eng-review、/office-hours 等 skill 的 codex exec 调用)。
 */
const CODEX_EXEC_BOILERPLATE_PREFIX =
  "IMPORTANT: Do NOT read or execute any files under ~/.claude/";

export function cleanCodexUserMessage(raw: string): string {
  if (!raw) return "";
  // 命中 exec 样板 → 整条丢弃(仅 startsWith:正文中段偶含 IMPORTANT 的普通消息不受影响)。
  if (raw.trimStart().startsWith(CODEX_EXEC_BOILERPLATE_PREFIX)) return "";
  return raw.trim();
}

export type CodexUserMessageExtract = {
  messageKey: string;
  eventAtMs: number;
  rawText: string;
  rawPayloadJson: string;
  cleanedText: string;
  isHuman: boolean;
};

/**
 * 从一个 codex session 的 Message[](buildCodexSession 产出)抽「用户消息」。抽屉 + ingest 共用。
 * **双重门**:role==='user' 且 metadata.codexSource==='event_msg'(排除 AGENTS.md 注入 + 双份)。
 * 纯样板轮也返回(cleaned='' / isHuman=false),由调用方决定留底(ingest)或省略(抽屉)。
 */
export function extractCodexUserMessages(
  messages: Message[]
): CodexUserMessageExtract[] {
  const out: CodexUserMessageExtract[] = [];
  for (const m of messages) {
    const src = (m.metadata as { codexSource?: string } | undefined)?.codexSource;
    if (m.role !== "user" || src !== "event_msg") continue;
    const rawText = m.content ?? "";
    const cleanedText = cleanCodexUserMessage(rawText);
    out.push({
      messageKey: m.id ?? "",
      eventAtMs: new Date(m.timestamp).getTime(),
      rawText,
      rawPayloadJson: JSON.stringify(rawText),
      cleanedText,
      isHuman: cleanedText.trim().length > 0,
    });
  }
  return out;
}

/** 从 raw_payload_json 重算(cleaner_version 回填)。payload = JSON 编码的原始 body。 */
export function recleanCodexFromPayload(rawPayloadJson: string): {
  cleanedText: string;
  isHuman: boolean;
} {
  let raw = "";
  try {
    const v = JSON.parse(rawPayloadJson) as unknown;
    if (typeof v === "string") raw = v;
  } catch {
    // 坏 payload → 空清洗
  }
  const cleanedText = cleanCodexUserMessage(raw);
  return { cleanedText, isHuman: cleanedText.trim().length > 0 };
}
