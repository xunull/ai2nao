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


/** One deduped assistant request (keyed by message.id), MAX per field. */
type ClaudeUsageAcc = {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
  /** First non-null message timestamp for this request (all its streaming
   *  lines share ~one time). null → caller supplies a fallback (never
   *  last_updated). */
  eventAt: string | null;
};

/**
 * Dedupe assistant token usage by `message.id`, MAX per field — the single
 * source of truth for BOTH the session total ({@link extractClaudeSessionUsage})
 * and the per-message-day event rows ({@link extractClaudeTokenEvents}). Both
 * MUST come from this one map so they never disagree and the golden invariant
 * `SUM(events) == session total` holds by construction.
 *
 * Claude Code writes ONE assistant JSONL line per content block, plus extra
 * lines as the response streams — and every one repeats the SAME `message.usage`
 * (streaming lines only grow `output_tokens`). A single API request (one
 * `message.id`) is billed once, so summing per line double-counts ≈2x
 * (dominated by cache_read replay: one turn with 16 tool_use blocks counts its
 * cache_read 16x). input / cache_* are fixed for a request; `output_tokens`
 * grows while streaming so its max is the final billed value. Lines without a
 * `message.id` can't be deduped, so each gets a synthetic key, counted once.
 */
function dedupeClaudeUsageByMessage(
  parse: ParseJsonlResult
): Map<string, ClaudeUsageAcc> {
  const byMessageId = new Map<string, ClaudeUsageAcc>();
  let synthetic = 0;
  for (const { record } of parse.okLines) {
    if (!isAssistantShape(record)) continue;
    const msg = record.message as Record<string, unknown>;
    const tokenUsage = mapTokenUsage(msg.usage);
    if (!tokenUsage) continue;
    const key =
      typeof msg.id === "string" && msg.id ? msg.id : `__noid_${synthetic++}`;
    const tsRaw = typeof record.timestamp === "string" ? record.timestamp : null;
    const prev = byMessageId.get(key);
    byMessageId.set(key, {
      input: Math.max(prev?.input ?? 0, tokenUsage.inputTokens),
      output: Math.max(prev?.output ?? 0, tokenUsage.outputTokens),
      cacheRead: Math.max(prev?.cacheRead ?? 0, tokenUsage.cacheReadInputTokens ?? 0),
      cacheCreation: Math.max(
        prev?.cacheCreation ?? 0,
        tokenUsage.cacheCreationInputTokens ?? 0
      ),
      // Keep the first non-null timestamp; never overwrite a real time with null.
      eventAt: prev?.eventAt ?? tsRaw,
    });
  }
  return byMessageId;
}

export function extractClaudeSessionUsage(parse: ParseJsonlResult): SessionUsage | undefined {
  const byMessageId = dedupeClaudeUsageByMessage(parse);
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

/** One per-message-day token row for `claude_token_usage_event`. */
export type ClaudeTokenEvent = {
  message_id: string;
  /** message timestamp; when the message lacked one, the caller's fallback
   *  (created_at, NEVER last_updated — that would revive the day-dump bug). */
  event_at: string;
  /** FUSED (fresh + cache_read + cache_creation), same as the session column. */
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
};

/**
 * Per-message deduped token events for the day-attributed trend. Same dedup
 * source as the session total, so `SUM(events, per field) == session total`.
 * A message with no timestamp falls back to `fallbackIso` (the session's
 * created_at) — a past, bounded day; the caller MUST NOT pass last_updated_at.
 */
export function extractClaudeTokenEvents(
  parse: ParseJsonlResult,
  opts: { fallbackIso: string }
): ClaudeTokenEvent[] {
  const byMessageId = dedupeClaudeUsageByMessage(parse);
  const events: ClaudeTokenEvent[] = [];
  for (const [messageId, acc] of byMessageId) {
    events.push({
      message_id: messageId,
      event_at: acc.eventAt ?? opts.fallbackIso,
      input_tokens: acc.input,
      output_tokens: acc.output,
      cache_read_input_tokens: acc.cacheRead,
      cache_creation_input_tokens: acc.cacheCreation,
    });
  }
  return events;
}

/**
 * The session's DOMINANT model: the one with the most (deduped) output tokens.
 * Used to price the session for the USD cost view (Opus vs Sonnet differ ~5x);
 * 96% of real sessions are single-model so the dominant is exact. Dedupes by
 * message.id (same streaming-duplication guard as usage), ignores the
 * `<synthetic>` placeholder and null. Returns null when no real model is found
 * → cost shows "—" (unpriced), never guessed.
 */
export function extractClaudeDominantModel(parse: ParseJsonlResult): string | null {
  // Per message.id: keep the max-output line's model (a request's lines all
  // share one model; output grows while streaming).
  const byMessageId = new Map<string, { model: string | null; output: number }>();
  let synthetic = 0;
  for (const { record } of parse.okLines) {
    if (!isAssistantShape(record)) continue;
    const msg = record.message as Record<string, unknown>;
    const usage = msg.usage as Record<string, unknown> | undefined;
    const output =
      usage && typeof usage.output_tokens === "number" ? usage.output_tokens : 0;
    const model =
      typeof msg.model === "string" && msg.model && msg.model !== "<synthetic>"
        ? msg.model
        : null;
    const key =
      typeof msg.id === "string" && msg.id ? msg.id : `__noid_${synthetic++}`;
    const prev = byMessageId.get(key);
    if (!prev || output > prev.output) byMessageId.set(key, { model, output });
  }
  const outputByModel = new Map<string, number>();
  for (const { model, output } of byMessageId.values()) {
    if (!model) continue;
    outputByModel.set(model, (outputByModel.get(model) ?? 0) + output);
  }
  let best: string | null = null;
  let bestOutput = -1;
  for (const [model, output] of outputByModel) {
    if (output > bestOutput) {
      bestOutput = output;
      best = model;
    }
  }
  return best;
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

/**
 * 把「单条已解析的 JSONL 记录」映射成「一条 Message」——这是 buildClaudeSession 里
 * per-okLine 分支逻辑的原样抽取(make the change easy, then make the easy change)。
 *
 * - `lineNumber`:该记录所在的「1-based 物理行号」。仅当记录缺少 `uuid` 时用于合成 id
 *   (`user-L<line>` / `assistant-L<line>` / `event-L<line>`),与原实现逐字对齐。
 * - `fileMtimeMs`:记录缺时间戳时的回退基准(`ts ?? new Date(fileMtimeMs)`)。
 *
 * 纯函数:不做任何会话级聚合(firstUserText / 时间范围 / sessionId / cwd 仍归调用方)。
 * user → user 消息;assistant → assistant 消息(text/thinking/toolCalls/model/tokenUsage);
 * 其它类型 → 折叠为 appendix(role=assistant,metadata.claudeAppendix)。返回 null 预留
 * 给未来「该行不产出消息」的过滤;当前恒返回一条,故 buildClaudeSession 的输出保持逐字节一致。
 */
export function mapRecordToMessage(
  record: Record<string, unknown>,
  lineNumber: number,
  fileMtimeMs: number
): Message | null {
  const ts = isoDate(record.timestamp);

  if (isUserShape(record)) {
    const msg = record.message as Record<string, unknown>;
    const body = userVisibleFromContent(msg.content);
    const id = typeof record.uuid === "string" ? record.uuid : `user-L${lineNumber}`;
    return {
      id,
      role: "user",
      content: body,
      timestamp: ts ?? new Date(fileMtimeMs),
      codeBlocks: extractCodeBlocks(body),
    };
  }

  if (isAssistantShape(record)) {
    const msg = record.message as Record<string, unknown>;
    const { text, thinking, toolCalls } = assistantFromContent(msg.content);
    const id =
      typeof record.uuid === "string" ? record.uuid : `assistant-L${lineNumber}`;
    const model = typeof msg.model === "string" ? msg.model : undefined;
    const tokenUsage = mapTokenUsage(msg.usage);
    return {
      id,
      role: "assistant",
      content: text,
      timestamp: ts ?? new Date(fileMtimeMs),
      codeBlocks: extractCodeBlocks(text),
      thinking,
      toolCalls,
      model,
      tokenUsage,
    };
  }

  const typ = recordType(record) ?? "unknown";
  const id = typeof record.uuid === "string" ? record.uuid : `event-L${lineNumber}`;
  const appendixBody = "```json\n" + JSON.stringify(record, null, 2) + "\n```";
  return {
    id,
    role: "assistant",
    content: appendixBody,
    timestamp: ts ?? new Date(fileMtimeMs),
    codeBlocks: [],
    metadata: {
      claudeEventType: typ,
      claudeAppendix: true,
    },
  };
}

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
    // 时间范围仍是会话级聚合,保留在此(每条 okLine 都参与 min/max,与原实现一致)。
    const ts = isoDate(record.timestamp);
    bumpTime(ts);

    // per-okLine → Message 的映射抽到 mapRecordToMessage;输出与原内联逻辑逐字节一致。
    const message = mapRecordToMessage(record, line, fileMtimeMs);
    if (!message) continue;

    // firstUserText 仍是会话级聚合:只有 user-shape 会产出 role=user(assistant / appendix
    // 均为 role=assistant),且其 content 恰为 userVisibleFromContent 的 body,故等价原逻辑。
    if (message.role === "user" && !firstUserText && message.content.trim()) {
      firstUserText = message.content.trim();
    }

    messages.push(message);
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
