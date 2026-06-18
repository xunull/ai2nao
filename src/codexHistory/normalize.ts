import { extractCodeBlocks } from "../cursorHistory/parser.js";
import type {
  ChatSession,
  ChatSessionSummary,
  Message,
  SessionUsage,
} from "../cursorHistory/types.js";
import type { ParseJsonlResult } from "../localJsonl/parse.js";
import type {
  BuiltCodexSession,
  CodexSessionMetadata,
  CodexSessionMetrics,
  CodexThreadRow,
} from "./types.js";

function asObj(v: unknown): Record<string, unknown> | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  return v as Record<string, unknown>;
}

function isoDate(v: unknown): Date | null {
  if (typeof v !== "string") return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    const b = asObj(block);
    if (!b) continue;
    if ((b.type === "input_text" || b.type === "output_text" || b.type === "text") && typeof b.text === "string") {
      parts.push(b.text);
    }
  }
  return parts.join("\n\n");
}

function truncate(s: string, len: number): string {
  if (s.length <= len) return s;
  return s.slice(0, len) + "...";
}

function parseJsonObject(raw: unknown): Record<string, unknown> | undefined {
  if (!raw) return undefined;
  if (typeof raw === "object" && !Array.isArray(raw)) return raw as Record<string, unknown>;
  if (typeof raw !== "string" || raw.trim() === "") return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    return asObj(parsed) ?? undefined;
  } catch {
    return undefined;
  }
}

function collectFilePaths(value: unknown, out: Set<string>): void {
  if (typeof value === "string") {
    if (
      value.includes("/") &&
      !value.includes("\n") &&
      value.length < 400 &&
      !value.startsWith("http://") &&
      !value.startsWith("https://")
    ) {
      out.add(value);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const v of value) collectFilePaths(v, out);
    return;
  }
  const o = asObj(value);
  if (!o) return;
  for (const [k, v] of Object.entries(o)) {
    if (/cwd|workdir/i.test(k)) continue;
    if (/path|file/i.test(k)) collectFilePaths(v, out);
    else if (typeof v === "object") collectFilePaths(v, out);
  }
}

function emptyMetrics(): CodexSessionMetrics {
  return {
    toolCallCount: 0,
    commandCount: 0,
    failedCommandCount: 0,
    fileCount: 0,
  };
}

function numberField(obj: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
      return value;
    }
  }
  return undefined;
}

function findObject(value: unknown, keys: string[]): Record<string, unknown> | undefined {
  const root = asObj(value);
  if (!root) return undefined;
  for (const key of keys) {
    const child = asObj(root[key]);
    if (child) return child;
  }
  return root;
}

type CodexTokenUsage = {
  inputTokens: number;
  outputTokens: number;
  /** Reasoning (thinking) tokens. SUBSET of outputTokens — already counted
   *  inside it, never added on top. Tracked separately for display only. */
  reasoningOutputTokens: number;
};

type CodexTokenCountUsage =
  | { kind: "increment"; usage: CodexTokenUsage; totalUsage?: CodexTokenUsage }
  | { kind: "total"; usage: CodexTokenUsage };

function usageFromObject(candidate: Record<string, unknown>): CodexTokenUsage | undefined {
  const input = numberField(candidate, [
    "input_tokens",
    "inputTokens",
    "prompt_tokens",
    "promptTokens",
    "total_input_tokens",
    "totalInputTokens",
  ]);
  const output = numberField(candidate, [
    "output_tokens",
    "outputTokens",
    "completion_tokens",
    "completionTokens",
    "total_output_tokens",
    "totalOutputTokens",
  ]);
  const reasoningOutput = numberField(candidate, [
    "reasoning_output_tokens",
    "reasoningOutputTokens",
    "total_reasoning_output_tokens",
    "totalReasoningOutputTokens",
  ]);
  if (input == null || output == null) return undefined;
  // NOTE: do NOT add reasoning_output_tokens to output. Codex (OpenAI
  // semantics) reports reasoning as a SUBSET of output_tokens, not an extra
  // amount — verified against real rollouts: total_tokens == input + output
  // on 23202/23202 reasoning>0 samples (NOT input+output+reasoning). Adding it
  // double-counted reasoning, inflating Codex output by ~22.6%. Investigation
  // 2026-06-18; root cause present since the first Codex backend (4dbdc34).
  // reasoningOutputTokens is tracked separately for the "Codex 输出构成"
  // display, never summed into outputTokens.
  return {
    inputTokens: input,
    outputTokens: output,
    reasoningOutputTokens: reasoningOutput ?? 0,
  };
}

function usageFromTokenCountPayload(payload: Record<string, unknown>): CodexTokenCountUsage | undefined {
  const info = asObj(payload.info);
  const lastUsage =
    usageFromObject(asObj(payload.last_token_usage) ?? {}) ??
    usageFromObject(asObj(payload.lastTokenUsage) ?? {}) ??
    usageFromObject(asObj(info?.last_token_usage) ?? {}) ??
    usageFromObject(asObj(info?.lastTokenUsage) ?? {});
  const totalUsage =
    usageFromObject(asObj(payload.total_token_usage) ?? {}) ??
    usageFromObject(asObj(payload.totalTokenUsage) ?? {}) ??
    usageFromObject(asObj(info?.total_token_usage) ?? {}) ??
    usageFromObject(asObj(info?.totalTokenUsage) ?? {});

  if (lastUsage) return { kind: "increment", usage: lastUsage, totalUsage };
  if (totalUsage) return { kind: "total", usage: totalUsage };

  const candidates = [
    payload,
    findObject(payload, ["usage", "token_usage", "tokens", "counts"]),
    findObject(info, ["usage", "token_usage", "tokens", "counts"]),
  ].filter((v): v is Record<string, unknown> => Boolean(v));

  for (const candidate of candidates) {
    const usage = usageFromObject(candidate);
    if (usage) return { kind: "increment", usage };
  }
  return undefined;
}

function mergeUsage(
  current: SessionUsage | undefined,
  next: CodexTokenUsage | undefined
): SessionUsage | undefined {
  if (!next) return current;
  return {
    totalInputTokens:
      (current?.totalInputTokens ?? 0) + next.inputTokens,
    totalOutputTokens:
      (current?.totalOutputTokens ?? 0) + next.outputTokens,
    totalReasoningOutputTokens:
      (current?.totalReasoningOutputTokens ?? 0) + next.reasoningOutputTokens,
  };
}

function deltaUsage(
  total: CodexTokenUsage,
  previousTotal: CodexTokenUsage | undefined
): CodexTokenUsage | undefined {
  if (!previousTotal) return total;
  const inputTokens = total.inputTokens - previousTotal.inputTokens;
  const outputTokens = total.outputTokens - previousTotal.outputTokens;
  // reasoning is a subset of output; clamp at 0 so a non-monotonic blip never
  // produces a negative subset (output delta already guards the row).
  const reasoningOutputTokens = Math.max(
    0,
    total.reasoningOutputTokens - previousTotal.reasoningOutputTokens
  );
  if (inputTokens < 0 || outputTokens < 0) return undefined;
  return { inputTokens, outputTokens, reasoningOutputTokens };
}

export function extractCodexSessionUsage(parse: ParseJsonlResult): SessionUsage | undefined {
  let usage: SessionUsage | undefined;
  let previousTotalUsage: CodexTokenUsage | undefined;
  for (const { record } of parse.okLines) {
    const payload = asObj(record.payload);
    if (str(record.type) !== "event_msg" || !payload) continue;
    if (str(payload.type) !== "token_count") continue;
    const tokenCount = usageFromTokenCountPayload(payload);
    if (tokenCount?.kind === "increment") {
      usage = mergeUsage(usage, tokenCount.usage);
      if (tokenCount.totalUsage) previousTotalUsage = tokenCount.totalUsage;
    } else if (tokenCount?.kind === "total") {
      usage = mergeUsage(usage, deltaUsage(tokenCount.usage, previousTotalUsage));
      previousTotalUsage = tokenCount.usage;
    }
  }
  return usage;
}

function summaryTitle(firstUserText: string | null, fallback: string): string {
  const t = (firstUserText || fallback || "(无用户消息)").trim();
  return truncate(t, 120);
}

export function buildCodexSession(options: {
  sessionId: string;
  parse: ParseJsonlResult;
  fileMtimeMs: number;
  thread?: CodexThreadRow;
  rolloutPath?: string;
  degraded?: boolean;
  degradationReason?: CodexSessionMetadata["degradationReason"];
}): BuiltCodexSession {
  const { sessionId, parse, fileMtimeMs, thread } = options;
  const warnings: string[] = [];
  const messages: Message[] = [];
  const filePaths = new Set<string>();
  const metrics = emptyMetrics();
  const callNames = new Map<string, string>();
  const usage = extractCodexSessionUsage(parse);

  if (parse.errors.length > 0) {
    warnings.push(`${parse.errors.length} JSONL line(s) failed to parse`);
  }

  let firstUserText: string | null = thread?.firstUserMessage?.trim() || null;
  let titleFromEvent: string | null = null;
  let cwd = thread?.cwd ?? "";
  let model = thread?.model;
  let tMin: Date | null = thread?.createdAt ?? null;
  let tMax: Date | null = thread?.lastUpdatedAt ?? null;

  const bumpTime = (d: Date | null) => {
    if (!d) return;
    if (!tMin || d < tMin) tMin = d;
    if (!tMax || d > tMax) tMax = d;
  };

  const pushMessage = (m: Message) => {
    messages.push(m);
    bumpTime(m.timestamp);
  };

  for (const { line, record } of parse.okLines) {
    const ts = isoDate(record.timestamp) ?? new Date(fileMtimeMs);
    const payload = asObj(record.payload);
    const typ = str(record.type) ?? "unknown";

    if (typ === "turn_context" && payload) {
      const pCwd = str(payload.cwd);
      if (pCwd && !cwd) cwd = pCwd;
      const pModel = str(payload.model);
      if (pModel && !model) model = pModel;
      collectFilePaths(payload, filePaths);
      continue;
    }

    if (typ === "session_meta" && payload) {
      const pCwd = str(payload.cwd);
      if (pCwd && !cwd) cwd = pCwd;
      continue;
    }

    if (typ === "event_msg" && payload) {
      const eventType = str(payload.type) ?? "event";
      if (eventType === "thread_name_updated") {
        titleFromEvent = str(payload.thread_name) ?? titleFromEvent;
        continue;
      }
      if (eventType === "user_message") {
        const body = str(payload.message) ?? "";
        if (!firstUserText && body.trim()) firstUserText = body.trim();
        pushMessage({
          id: `user-L${line}`,
          role: "user",
          content: body,
          timestamp: ts,
          codeBlocks: extractCodeBlocks(body),
        });
        continue;
      }
      if (eventType === "agent_message") {
        const body = str(payload.message) ?? "";
        pushMessage({
          id: `assistant-L${line}`,
          role: "assistant",
          content: body,
          timestamp: ts,
          codeBlocks: extractCodeBlocks(body),
          metadata: { codexEventType: eventType },
        });
        continue;
      }
      if (eventType === "exec_command_end") {
        metrics.commandCount++;
        metrics.toolCallCount++;
        const exitCode = typeof payload.exit_code === "number" ? payload.exit_code : undefined;
        const failed = exitCode != null && exitCode !== 0;
        if (failed) metrics.failedCommandCount++;
        const command = str(payload.command) ?? "(command unavailable)";
        const body = [
          `Command: ${command}`,
          str(payload.cwd) ? `cwd: ${payload.cwd}` : "",
          exitCode != null ? `exit: ${exitCode}` : "",
          typeof payload.duration === "object" ? "" : "",
        ].filter(Boolean).join("\n");
        pushMessage({
          id: `tool-L${line}`,
          role: "assistant",
          content: body,
          timestamp: ts,
          codeBlocks: [],
          toolCalls: [
            {
              name: "exec_command",
              status: failed ? "error" : "completed",
              params: { command, cwd: str(payload.cwd) },
              error: failed ? `exit ${exitCode}` : undefined,
            },
          ],
          metadata: {
            codexEventType: eventType,
            codexToolEvent: true,
            codexFailed: failed,
          },
        });
        continue;
      }
      if (eventType === "token_count") continue;
      if (eventType === "task_started") {
        continue;
      }
    }

    if (typ === "response_item" && payload) {
      const itemType = str(payload.type) ?? "unknown";
      if (itemType === "message") {
        const role = str(payload.role);
        if (role !== "user" && role !== "assistant") continue;
        const body = textFromContent(payload.content);
        if (!firstUserText && role === "user" && body.trim()) firstUserText = body.trim();
        pushMessage({
          id: `${role}-L${line}`,
          role,
          content: body,
          timestamp: ts,
          codeBlocks: extractCodeBlocks(body),
          model,
        });
        continue;
      }
      if (itemType === "reasoning") {
        continue;
      }
      if (itemType === "function_call") {
        metrics.toolCallCount++;
        const name = str(payload.name) ?? "function_call";
        const callId = str(payload.call_id) ?? `call-L${line}`;
        callNames.set(callId, name);
        const params = parseJsonObject(payload.arguments);
        collectFilePaths(params, filePaths);
        pushMessage({
          id: `call-L${line}`,
          role: "assistant",
          content: `Tool call: ${name}`,
          timestamp: ts,
          codeBlocks: [],
          toolCalls: [{ name, status: "completed", params }],
          metadata: {
            codexEventType: itemType,
            codexToolEvent: true,
          },
        });
        continue;
      }
      if (itemType === "function_call_output") {
        const callId = str(payload.call_id);
        const name = (callId && callNames.get(callId)) || "function_call_output";
        pushMessage({
          id: `call-output-L${line}`,
          role: "assistant",
          content: `Tool result: ${name}`,
          timestamp: ts,
          codeBlocks: [],
          toolCalls: [{ name, status: "completed" }],
          metadata: {
            codexEventType: itemType,
            codexToolEvent: true,
          },
        });
        continue;
      }
      if (itemType.endsWith("_call")) {
        metrics.toolCallCount++;
        pushMessage({
          id: `tool-L${line}`,
          role: "assistant",
          content: `Tool call: ${itemType}`,
          timestamp: ts,
          codeBlocks: [],
          toolCalls: [{ name: itemType, status: "completed" }],
          metadata: {
            codexEventType: itemType,
            codexToolEvent: true,
          },
        });
      }
    }
  }

  metrics.fileCount = filePaths.size;
  const createdAt = tMin ?? new Date(fileMtimeMs);
  const lastUpdatedAt = tMax ?? new Date(fileMtimeMs);
  const title =
    thread?.title?.trim() ||
    titleFromEvent?.trim() ||
    summaryTitle(firstUserText, "");
  const preview = firstUserText ? truncate(firstUserText, 100) : title;
  const metadata: { codex: CodexSessionMetadata } = {
    codex: {
      cwd: cwd || thread?.cwd || "",
      gitBranch: thread?.gitBranch,
      model,
      archived: thread?.archived ?? false,
      rolloutPath: options.rolloutPath ?? thread?.rolloutPath,
      degraded: options.degraded,
      degradationReason: options.degradationReason,
      metrics,
    },
  };

  const session: ChatSession = {
    id: sessionId,
    index: 0,
    title,
    createdAt,
    lastUpdatedAt,
    messageCount: messages.length,
    messages,
    workspaceId: cwd || thread?.cwd || "codex",
    workspacePath: cwd || thread?.cwd || "",
    source: "codex",
    metadata,
    usage,
  };

  const summary: ChatSessionSummary = {
    id: sessionId,
    index: 0,
    title,
    createdAt,
    lastUpdatedAt,
    messageCount: messages.length,
    workspaceId: session.workspaceId,
    workspacePath: session.workspacePath ?? "",
    preview,
    source: "codex",
    metadata,
  };

  return { session, summary, warnings, metrics };
}
