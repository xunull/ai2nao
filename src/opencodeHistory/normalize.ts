import type { ChatSession, Message, ToolCall } from "../cursorHistory/types.js";
import { extractCodeBlocks } from "../cursorHistory/parser.js";
import type { OpencodeRawMessage, OpencodeRawPart } from "./stateDb.js";
import type { OpencodeSessionRow } from "./types.js";

// 大 payload 截断上限（codex#6）：opencode.db 3.46GB，单个 tool/patch/reasoning
// 可能极大，原样塞进 API/React 会卡。超限截断 + 标记，避免拖死页面。
const MAX_TEXT = 16 * 1024;
const MAX_THINKING = 8 * 1024;
const MAX_TOOL = 4 * 1024;

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + `\n…[已截断 ${s.length - max} 字]`;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

type PartData = {
  type?: string;
  text?: string;
  synthetic?: boolean;
  // tool part
  tool?: string;
  state?: { status?: string; input?: unknown; output?: string; error?: string } | undefined;
  callID?: string;
};

/**
 * 把 opencode 的 message + 它的 parts 折成一条 ai2nao Message。
 * 一条 message 的正文 = 它所有 `type:text` 的 part 拼接;reasoning→thinking;
 * tool→toolCalls;patch→正文补一行折叠提示;step-start/step-finish 跳过(纯标记)。
 * 空 message(无 text/thinking/tool)直接跳过,避免 UI 空泡泡(codex#4)。
 */
function buildMessage(
  raw: OpencodeRawMessage,
  parts: OpencodeRawPart[]
): Message | null {
  let data: { role?: string; time?: { created?: number }; model?: { id?: string; modelID?: string } } = {};
  try {
    data = JSON.parse(raw.data);
  } catch {
    // 坏 JSON：当作降级空消息,但仍保留时间戳。
  }
  const role: "user" | "assistant" = data.role === "user" ? "user" : "assistant";
  const ts = new Date(
    typeof data.time?.created === "number" && data.time.created > 0
      ? data.time.created
      : raw.timeCreated || 0
  );

  const texts: string[] = [];
  const reasonings: string[] = [];
  const toolCalls: ToolCall[] = [];
  let hasPatch = false;

  for (const p of parts) {
    let pd: PartData = {};
    try {
      pd = JSON.parse(p.data) as PartData;
    } catch {
      continue;
    }
    switch (pd.type) {
      case "text":
        if (pd.text) texts.push(pd.text);
        break;
      case "reasoning":
        if (pd.text) reasonings.push(pd.text);
        break;
      case "tool":
        toolCalls.push({
          name: pd.tool ?? "tool",
          status:
            pd.state?.status === "error"
              ? "error"
              : pd.state?.status === "cancelled"
                ? "cancelled"
                : "completed",
          params:
            pd.state?.input && typeof pd.state.input === "object"
              ? (pd.state.input as Record<string, unknown>)
              : undefined,
          result: pd.state?.output ? truncate(String(pd.state.output), MAX_TOOL) : undefined,
          error: str(pd.state?.error),
        });
        break;
      case "patch":
        hasPatch = true;
        break;
      // step-start / step-finish / 其它 → 跳过
    }
  }

  let content = truncate(texts.join("\n\n").trim(), MAX_TEXT);
  if (hasPatch) content = (content ? content + "\n\n" : "") + "_[文件改动 patch]_";
  const thinking = reasonings.length
    ? truncate(reasonings.join("\n\n").trim(), MAX_THINKING)
    : undefined;

  // 空 message(无任何可见内容)跳过。
  if (!content && !thinking && toolCalls.length === 0) return null;

  return {
    id: raw.id,
    role,
    content,
    timestamp: ts,
    codeBlocks: extractCodeBlocks(content),
    thinking,
    toolCalls: toolCalls.length ? toolCalls : undefined,
    model: data.model?.id ?? data.model?.modelID,
    metadata: {},
  };
}

export function buildOpencodeSession(args: {
  row: OpencodeSessionRow;
  messages: OpencodeRawMessage[];
  parts: OpencodeRawPart[];
}): { session: ChatSession; warnings: string[] } {
  const { row, messages, parts } = args;

  // part 按 message_id 分桶(已按 time_created,id 排序，保序）。
  const byMsg = new Map<string, OpencodeRawPart[]>();
  for (const p of parts) {
    const arr = byMsg.get(p.messageId);
    if (arr) arr.push(p);
    else byMsg.set(p.messageId, [p]);
  }

  const built: Message[] = [];
  for (const m of messages) {
    const msg = buildMessage(m, byMsg.get(m.id) ?? []);
    if (msg) built.push(msg);
  }

  const session: ChatSession = {
    id: row.id,
    index: 0,
    title: row.title || "无标题会话",
    createdAt: row.createdAt,
    lastUpdatedAt: row.lastUpdatedAt,
    messageCount: built.length,
    messages: built,
    workspaceId: row.projectId,
    workspacePath: row.directory,
    source: "opencode",
    metadata: {
      opencode: {
        directory: row.directory,
        agent: row.agent,
        model: row.model,
        archived: row.archived,
        tokensInput: row.tokensInput,
        tokensOutput: row.tokensOutput,
        cost: row.cost,
      },
    },
  };
  return { session, warnings: [] };
}
