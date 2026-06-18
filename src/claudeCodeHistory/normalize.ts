import { extractCodeBlocks } from "../cursorHistory/parser.js";
import type {
  ChatSession,
  ChatSessionSummary,
  Message,
  SessionUsage,
  ToolCall,
  TokenUsage,
} from "../cursorHistory/types.js";
import type { ParseJsonlResult } from "./parseJsonl.js";

function isoDate(v: unknown): Date | null {
  if (typeof v !== "string") return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

function recordType(rec: Record<string, unknown>): string | undefined {
  const t = rec.type;
  return typeof t === "string" ? t : undefined;
}

function userVisibleFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const b = block as Record<string, unknown>;
    if (b.type === "text" && typeof b.text === "string") parts.push(b.text);
  }
  return parts.join("\n\n");
}

function mapTokenUsage(u: unknown): TokenUsage | undefined {
  if (!u || typeof u !== "object") return undefined;
  const o = u as Record<string, unknown>;
  const input = o.input_tokens;
  const output = o.output_tokens;
  if (typeof input !== "number" || typeof output !== "number") return undefined;
  // Claude API prompt cache: the headline `input_tokens` field is ONLY the
  // bytes that hit the model fresh in this turn. `cache_creation_input_tokens`
  // (just-written cache) and `cache_read_input_tokens` (replayed cache) both
  // count toward billed prompt size. Long Claude Code sessions read tens of
  // thousands of cache tokens per turn while `input_tokens` may be < 100;
  // missing them under-reports Claude usage by 100-1000x.
  // Ref: https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching
  const cacheCreation = typeof o.cache_creation_input_tokens === "number"
    ? o.cache_creation_input_tokens
    : 0;
  const cacheRead = typeof o.cache_read_input_tokens === "number"
    ? o.cache_read_input_tokens
    : 0;
  return {
    inputTokens: input + cacheCreation + cacheRead,
    outputTokens: output,
    cacheReadInputTokens: cacheRead,
    cacheCreationInputTokens: cacheCreation,
  };
}


export function extractClaudeSessionUsage(parse: ParseJsonlResult): SessionUsage | undefined {
  // Claude Code writes ONE assistant JSONL line per content block, plus extra
  // lines as the response streams — and every one of those lines repeats the
  // SAME `message.usage` (the streaming lines only grow `output_tokens`). A
  // single API request (one `message.id`) is billed once, so summing usage
  // per line double-counts: corpus-wide ≈2x overall, dominated by cache_read
  // replay (one turn with 16 tool_use blocks → its cache_read counted 16x).
  //
  // Dedupe by `message.id`, taking the MAX of each field: input / cache_* are
  // fixed for a request, `output_tokens` grows while the response streams so
  // its max is the final billed value. Lines without a `message.id` can't be
  // deduped, so each gets a synthetic key and is counted once.
  type Acc = {
    input: number;
    output: number;
    cacheRead: number;
    cacheCreation: number;
  };
  const byMessageId = new Map<string, Acc>();
  let synthetic = 0;
  for (const { record } of parse.okLines) {
    if (!isAssistantShape(record)) continue;
    const msg = record.message as Record<string, unknown>;
    const tokenUsage = mapTokenUsage(msg.usage);
    if (!tokenUsage) continue;
    const key =
      typeof msg.id === "string" && msg.id ? msg.id : `__noid_${synthetic++}`;
    const prev = byMessageId.get(key);
    byMessageId.set(key, {
      input: Math.max(prev?.input ?? 0, tokenUsage.inputTokens),
      output: Math.max(prev?.output ?? 0, tokenUsage.outputTokens),
      cacheRead: Math.max(prev?.cacheRead ?? 0, tokenUsage.cacheReadInputTokens ?? 0),
      cacheCreation: Math.max(
        prev?.cacheCreation ?? 0,
        tokenUsage.cacheCreationInputTokens ?? 0
      ),
    });
  }
  if (byMessageId.size === 0) return undefined;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCacheReadInputTokens = 0;
  let totalCacheCreationInputTokens = 0;
  for (const acc of byMessageId.values()) {
    totalInputTokens += acc.input;
    totalOutputTokens += acc.output;
    totalCacheReadInputTokens += acc.cacheRead;
    totalCacheCreationInputTokens += acc.cacheCreation;
  }
  return {
    totalInputTokens,
    totalOutputTokens,
    totalCacheReadInputTokens,
    totalCacheCreationInputTokens,
  };
}

function assistantFromContent(content: unknown): {
  text: string;
  thinking?: string;
  toolCalls?: ToolCall[];
} {
  if (typeof content === "string") {
    return { text: content };
  }
  if (!Array.isArray(content)) {
    return { text: "" };
  }
  const textParts: string[] = [];
  let thinking: string | undefined;
  const toolCalls: ToolCall[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const b = block as Record<string, unknown>;
    const typ = b.type;
    if (typ === "text" && typeof b.text === "string") {
      textParts.push(b.text);
    } else if (typ === "thinking" && typeof b.thinking === "string") {
      thinking = thinking ? `${thinking}\n\n${b.thinking}` : b.thinking;
    } else if (typ === "tool_use") {
      const name = typeof b.name === "string" ? b.name : "tool";
      const params =
        b.input && typeof b.input === "object" && !Array.isArray(b.input)
          ? (b.input as Record<string, unknown>)
          : undefined;
      toolCalls.push({
        name,
        status: "completed",
        params,
      });
    } else {
      textParts.push("```json\n" + JSON.stringify(b, null, 2) + "\n```");
    }
  }
  return {
    text: textParts.join("\n\n"),
    thinking,
    toolCalls: toolCalls.length ? toolCalls : undefined,
  };
}

function isUserShape(rec: Record<string, unknown>): boolean {
  if (recordType(rec) !== "user") return false;
  const msg = rec.message;
  if (!msg || typeof msg !== "object" || Array.isArray(msg)) return false;
  const m = msg as Record<string, unknown>;
  return m.role === "user";
}

function isAssistantShape(rec: Record<string, unknown>): boolean {
  if (recordType(rec) !== "assistant") return false;
  const msg = rec.message;
  if (!msg || typeof msg !== "object" || Array.isArray(msg)) return false;
  const m = msg as Record<string, unknown>;
  return m.role === "assistant";
}

export type BuiltClaudeSession = {
  session: ChatSession;
  summary: ChatSessionSummary;
  warnings: string[];
};

export function buildClaudeSession(options: {
  projectId: string;
  sessionId: string;
  parse: ParseJsonlResult;
  fileMtimeMs: number;
}): BuiltClaudeSession {
  const { projectId, sessionId, parse, fileMtimeMs } = options;
  const warnings: string[] = [];

  if (parse.errors.length > 0) {
    warnings.push(`${parse.errors.length} JSONL line(s) failed to parse`);
  }

  const sessionIds = new Set<string>();
  let cwdFallback = "";
  for (const { record } of parse.okLines) {
    const sid = record.sessionId;
    if (typeof sid === "string") sessionIds.add(sid);
    const cwd = record.cwd;
    if (typeof cwd === "string" && cwd && !cwdFallback) cwdFallback = cwd;
  }
  if (sessionIds.size > 1) {
    warnings.push(`multiple distinct sessionId values in file (${sessionIds.size})`);
  }
  if (sessionIds.size === 1) {
    const [only] = [...sessionIds];
    if (only !== sessionId) {
      warnings.push(`sessionId mismatch: file name ${sessionId} vs payload ${only}`);
    }
  }

  const messages: Message[] = [];
  let firstUserText: string | null = null;
  let tMin: Date | null = null;
  let tMax: Date | null = null;

  const bumpTime = (d: Date | null) => {
    if (!d) return;
    if (!tMin || d < tMin) tMin = d;
    if (!tMax || d > tMax) tMax = d;
  };

  for (const { line, record } of parse.okLines) {
    const ts = isoDate(record.timestamp);
    bumpTime(ts);

    if (isUserShape(record)) {
      const msg = record.message as Record<string, unknown>;
      const body = userVisibleFromContent(msg.content);
      if (!firstUserText && body.trim()) firstUserText = body.trim();
      const id = typeof record.uuid === "string" ? record.uuid : `user-L${line}`;
      messages.push({
        id,
        role: "user",
        content: body,
        timestamp: ts ?? new Date(fileMtimeMs),
        codeBlocks: extractCodeBlocks(body),
      });
      continue;
    }

    if (isAssistantShape(record)) {
      const msg = record.message as Record<string, unknown>;
      const { text, thinking, toolCalls } = assistantFromContent(msg.content);
      const id =
        typeof record.uuid === "string" ? record.uuid : `assistant-L${line}`;
      const model = typeof msg.model === "string" ? msg.model : undefined;
      const tokenUsage = mapTokenUsage(msg.usage);
      messages.push({
        id,
        role: "assistant",
        content: text,
        timestamp: ts ?? new Date(fileMtimeMs),
        codeBlocks: extractCodeBlocks(text),
        thinking,
        toolCalls,
        model,
        tokenUsage,
      });
      continue;
    }

    const typ = recordType(record) ?? "unknown";
    const id = typeof record.uuid === "string" ? record.uuid : `event-L${line}`;
    const appendixBody = "```json\n" + JSON.stringify(record, null, 2) + "\n```";
    messages.push({
      id,
      role: "assistant",
      content: appendixBody,
      timestamp: ts ?? new Date(fileMtimeMs),
      codeBlocks: [],
      metadata: {
        claudeEventType: typ,
        claudeAppendix: true,
      },
    });
  }

  const titleText = firstUserText
    ? firstUserText.length > 120
      ? `${firstUserText.slice(0, 120)}…`
      : firstUserText
    : "(无用户消息)";

  const preview = firstUserText
    ? firstUserText.length > 100
      ? `${firstUserText.slice(0, 100)}…`
      : firstUserText
    : "(无用户消息)";

  const createdAt = tMin ?? new Date(fileMtimeMs);
  const lastUpdatedAt = tMax ?? new Date(fileMtimeMs);
  const workspacePath = cwdFallback || projectId;

  const session: ChatSession = {
    id: sessionId,
    index: 0,
    title: titleText,
    createdAt,
    lastUpdatedAt,
    messageCount: messages.length,
    messages,
    workspaceId: projectId,
    workspacePath,
    source: "claude-code",
    // Deduped by message.id — see extractClaudeSessionUsage. (Per-message
    // tokenUsage stays per-line for individual message display.)
    usage: extractClaudeSessionUsage(parse),
  };

  const summary: ChatSessionSummary = {
    id: sessionId,
    index: 0,
    title: session.title,
    createdAt,
    lastUpdatedAt,
    messageCount: messages.length,
    workspaceId: projectId,
    workspacePath,
    preview,
  };

  return { session, summary, warnings };
}
