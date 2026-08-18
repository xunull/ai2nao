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
  /** V53:'user' | 'assistant'。 */
  role: "user" | "assistant";
  /** assistant 行在回答的那条 user 消息的 messageKey;user 行恒为 null。 */
  answeringUserKey: string | null;
};

/**
 * 从一个 codex session 的 Message[](buildCodexSession 产出)抽消息。抽屉 + ingest 共用。
 *
 * **三态分流(2026-08-18)** —— 取代原来那个「programmatic 就整场跳过」的布尔门。
 * 全量实测 349 个会话证明那个门把三种性质完全不同的会话压成了一类:
 *
 *   normal    126 会话  AI 正文 13.24 MB  user 清洗后 5933/5933 非空
 *             → 两侧全收。这是主体,而且它本来就能通过旧门。
 *   subagent  137 会话  AI 正文  2.57 MB  user 清洗后 1087/1884 非空
 *             → **只收 assistant**。它的 user 侧是派给 codex 的审查 prompt
 *               (`Read this document and review it on 5 dimensions...`),是机器注入;
 *               而 assistant 侧是 codex 写回来的审查意见,有价值。
 *   exec       86 会话  AI 正文  0.37 MB  user 清洗后   12/83 非空
 *             → **两侧都跳**,与旧行为一致。实测那 12 条也是机器 prompt 残留
 *               (`You are a memory extractor`、`# Instructions (read first)`)。
 *
 * **user 侧的双重门保持不变**:role==='user' 且 codexSource==='event_msg'。codex 把
 * 消息同时写进 event_msg 和 response_item,后者是副本(现已由 readingHidden='duplicate'
 * 统一标记,这里的 src 判断因此成了冗余的第二道保险 —— 留着,因为它是这条路径上
 * 唯一显式表达「只认 event_msg」的地方)。
 *
 * **assistant 侧**用 readingHidden 判据(tool-only / duplicate 都跳),再按内容做会话内
 * 去重 —— readingHidden 的 duplicate 是按**来源**判的(response_item),挡不住同一条内容
 * 在两条 agent_message 里出现。跨会话不去重:不同会话说同样的话是正常的。
 */
export function extractCodexMessages(
  messages: Message[],
  opts?: { sessionKind?: "normal" | "subagent" | "exec"; programmatic?: boolean }
): CodexUserMessageExtract[] {
  // 兼容旧调用方:只传 programmatic 时,true 一律按最严格的 exec 处理。
  const kind: "normal" | "subagent" | "exec" =
    opts?.sessionKind ?? (opts?.programmatic ? "exec" : "normal");
  if (kind === "exec") return [];

  const out: CodexUserMessageExtract[] = [];
  let lastUserKey: string | null = null;
  const seenAssistantBody = new Set<string>();

  for (const m of messages) {
    const meta = m.metadata as
      | { codexSource?: string; readingHidden?: string }
      | undefined;
    if (meta?.readingHidden) continue;

    if (m.role === "user") {
      if (kind === "subagent") continue; // 它的 user 侧是派活的 prompt,不是你说的话
      if (meta?.codexSource !== "event_msg") continue;
      const rawText = m.content ?? "";
      const cleanedText = cleanCodexUserMessage(rawText);
      const messageKey = m.id ?? "";
      // 锚点只认人说的话 —— 纯样板轮不该成为 AI 回答的提问上下文。
      if (cleanedText.trim().length > 0) lastUserKey = messageKey;
      out.push({
        messageKey,
        eventAtMs: new Date(m.timestamp).getTime(),
        rawText,
        rawPayloadJson: JSON.stringify(rawText),
        cleanedText,
        isHuman: cleanedText.trim().length > 0,
        role: "user",
        answeringUserKey: null,
      });
      continue;
    }

    if (m.role !== "assistant") continue;
    const body = m.content ?? "";
    if (!body.trim()) continue;
    if (seenAssistantBody.has(body)) continue;
    seenAssistantBody.add(body);
    out.push({
      messageKey: m.id ?? "",
      eventAtMs: new Date(m.timestamp).getTime(),
      rawText: body,
      rawPayloadJson: JSON.stringify(body),
      // AI 输出不经清洗 —— 它不会往自己嘴里塞样板。
      cleanedText: body,
      isHuman: false,
      role: "assistant",
      answeringUserKey: lastUserKey,
    });
  }
  return out;
}

/**
 * 只要 user 消息(「只看我说的」抽屉用,语义与 2026-08-18 之前一致)。
 * 名字保持诚实:它确实只返回 user 行。ingest 要连 AI 一起收,用 `extractCodexMessages`。
 */
export function extractCodexUserMessages(
  messages: Message[],
  opts?: { sessionKind?: "normal" | "subagent" | "exec"; programmatic?: boolean }
): CodexUserMessageExtract[] {
  return extractCodexMessages(messages, opts).filter((m) => m.role === "user");
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
