/**
 * Codex「我说的」清洗 —— 后端权威版(option C:清洗归后端,抽屉/ingest 共用)。
 *
 * 逐字移植自原前端 `web/src/lib/cleanCodexUserMessage.ts`(现改为调本模块的后端端点)。
 * parity 测试锁死一致。
 *
 * codex 的 user_message 事件**不是**干净真人信号(2026-07-04 修正,原假设错):
 *   - codex exec / 审批 / 插件会话把机器 prompt + 「approval assessment」历史回灌成 user_message;
 *   - 交互会话里 slash 命令展开 `[$review](/path)` 也记成 user_message。
 * 故多重过滤:role=user + event_msg(排双份/AGENTS.md 注入)+ **跳过程序化会话**(programmatic:
 * originator=codex_exec / source=exec)+ 剥 exec 样板/审批回灌。**斜杠命令调用是你的输入**
 * → 不丢,显示紧凑 `/名字`(展开全文留 raw_payload)。
 */
import type { Message } from "../cursorHistory/types.js";

// v2(2026-07-04):程序化会话跳过 + [$cmd] 剥离。
// v3(2026-07-04):命令调用不再丢弃 → 显示紧凑 /名字(用户裁定:调用 skill 是我的输入)。
export const CODEX_CLEANER_VERSION = 3;
export const CODEX_PARSER_VERSION = 2;

/**
 * gstack 外部声音 / codex exec 注入的文件系统边界样板 prompt 开头
 * (见 /plan-eng-review、/office-hours 等 skill 的 codex exec 调用)。
 */
const CODEX_EXEC_BOILERPLATE_PREFIX =
  "IMPORTANT: Do NOT read or execute any files under ~/.claude/";

/** codex 把 slash 命令展开成 `[$review](/path/to/skill)`;调用是你的输入 → 显示紧凑 `/review`。 */
const CODEX_COMMAND_INVOCATION_RE = /^\[\$([^\]\n]+)\]\(/;

/**
 * codex 审批/子代理(guardian)评估把整段对话转录回灌成 user_message,均以此开头
 * (「…added since your last approval assessment」/「…whose request action you are assessing」)。
 * 内容前缀兜底:即便某会话没被 programmatic 标记,也能剥掉这类注入(防御纵深)。
 */
const CODEX_APPROVAL_INJECTION_PREFIX = "The following is the Codex agent history";

export function cleanCodexUserMessage(raw: string): string {
  if (!raw) return "";
  const head = raw.trimStart();
  // exec 样板 / 审批转录回灌 → 整条丢弃(机器生成,非你敲的)。
  if (head.startsWith(CODEX_EXEC_BOILERPLATE_PREFIX)) return "";
  if (head.startsWith(CODEX_APPROVAL_INJECTION_PREFIX)) return "";
  // slash 命令调用是你的输入 → 显示紧凑 /名字(展开全文仍留 raw_payload)。
  const cmd = CODEX_COMMAND_INVOCATION_RE.exec(head);
  if (cmd) return `/${cmd[1].trim()}`;
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
 * **门 0**:opts.programmatic(codex exec/审批/插件会话)→ 整场跳过(全是机器注入)。
 * **双重门**:role==='user' 且 metadata.codexSource==='event_msg'(排除 AGENTS.md 注入 + 双份)。
 * 纯样板/命令注入轮也返回(cleaned='' / isHuman=false),由调用方决定留底(ingest)或省略(抽屉)。
 */
export function extractCodexUserMessages(
  messages: Message[],
  opts?: { programmatic?: boolean }
): CodexUserMessageExtract[] {
  // 程序化会话(codex exec / 审批 / 插件):user_message 全是机器注入 → 整场跳过。
  if (opts?.programmatic) return [];
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
