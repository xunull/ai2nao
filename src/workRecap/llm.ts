import type { LlmChatConfig } from "../llmChat/config.js";
import {
  WORK_RECAP_LLM_TIMEOUT_MS,
  type WorkRecapDegradeReason,
  type WorkRecapFacts,
  type WorkRecapFragmentation,
  type WorkRecapInference,
  type WorkRecapWorkMode,
} from "./types.js";
import { SYSTEM_PROMPT, type PromptOutput } from "./prompt.js";

export class WorkRecapLlmError extends Error {
  constructor(
    readonly reason: WorkRecapDegradeReason,
    message: string
  ) {
    super(message);
  }
}

const WORK_MODES = new Set<WorkRecapWorkMode>([
  "build",
  "debug",
  "explore",
  "fragmented",
  "low_signal",
]);

const FRAGMENTATION_VALUES = new Set<WorkRecapFragmentation>([
  "low",
  "med",
  "high",
]);

const DEGRADE_REASONS = new Set<WorkRecapDegradeReason>([
  "sparse_signal",
  "text_fact_conflict",
]);

type LlmRawResponse = {
  summary?: unknown;
  workMode?: unknown;
  workModeReason?: unknown;
  nextUp?: unknown;
  fragmentation?: unknown;
  degraded?: unknown;
  degradeReason?: unknown;
};

function providerApiKeyEnv(provider: LlmChatConfig["provider"]): string | null {
  switch (provider) {
    case "deepseek":
      return "DEEPSEEK_API_KEY";
    case "moonshotai":
      return "MOONSHOT_API_KEY";
    case "alibaba":
      return "ALIBABA_API_KEY";
    case "openai":
      return "OPENAI_API_KEY";
    case "openai-compatible":
      return null;
  }
}

function resolveApiKey(cfg: LlmChatConfig): string | null {
  if (cfg.apiKey?.trim()) return cfg.apiKey.trim();
  const envKey = providerApiKeyEnv(cfg.provider);
  if (envKey) {
    const provider = process.env[envKey]?.trim();
    if (provider) return provider;
  }
  const shared = process.env.AI2NAO_LLM_API_KEY?.trim();
  if (shared) return shared;
  if (cfg.provider === "openai-compatible") return "local-no-key";
  return null;
}

function isOpenAiCompatBase(url: string): boolean {
  return /\/v\d+\/?$/.test(url) || url.endsWith("/openai/v1");
}

function chatCompletionsUrl(baseURL: string): string {
  const trimmed = baseURL.replace(/\/$/, "");
  if (isOpenAiCompatBase(trimmed)) {
    return `${trimmed}/chat/completions`;
  }
  // DeepSeek base URL doesn't include /v1 by convention; append both `/v1`
  // and `/chat/completions` to land on the right endpoint.
  return `${trimmed}/v1/chat/completions`;
}

function asNonEmptyTrimmedString(x: unknown, max = 4096): string | null {
  if (typeof x !== "string") return null;
  const t = x.trim();
  if (!t) return null;
  return t.length > max ? t.slice(0, max) : t;
}

function asStringArray(x: unknown, maxItems = 5, maxChars = 200): string[] {
  if (!Array.isArray(x)) return [];
  const out: string[] = [];
  for (const item of x.slice(0, maxItems)) {
    const s = asNonEmptyTrimmedString(item, maxChars);
    if (s) out.push(s);
  }
  return out;
}

function detectTextFactConflict(
  inf: WorkRecapInference,
  facts: WorkRecapFacts
): boolean {
  // Rule: if LLM claims workMode "debug" but >70% of commits are feat, OR
  // claims "build" but >60% are fix, treat as a fact/text conflict.
  if (facts.totalCommits === 0) return false;
  const total = facts.totalCommits;
  const featRatio = facts.commitTypeCounts.feat / total;
  const fixRatio = facts.commitTypeCounts.fix / total;
  if (inf.workMode === "debug" && featRatio > 0.7) return true;
  if (inf.workMode === "build" && fixRatio > 0.6) return true;
  return false;
}

function normalizeResult(
  raw: LlmRawResponse,
  facts: WorkRecapFacts
): WorkRecapInference {
  const summary = asNonEmptyTrimmedString(raw.summary, 400);
  if (!summary) {
    throw new WorkRecapLlmError("llm_malformed", "LLM omitted summary");
  }
  const workMode =
    typeof raw.workMode === "string" &&
    WORK_MODES.has(raw.workMode as WorkRecapWorkMode)
      ? (raw.workMode as WorkRecapWorkMode)
      : "low_signal";
  const workModeReason =
    asNonEmptyTrimmedString(raw.workModeReason, 80) ?? "";
  const nextUp = asStringArray(raw.nextUp, 2, 120);
  const fragmentation =
    typeof raw.fragmentation === "string" &&
    FRAGMENTATION_VALUES.has(raw.fragmentation as WorkRecapFragmentation)
      ? (raw.fragmentation as WorkRecapFragmentation)
      : "low";

  let degraded = raw.degraded === true;
  let degradeReason: WorkRecapDegradeReason | null = null;
  if (
    typeof raw.degradeReason === "string" &&
    DEGRADE_REASONS.has(raw.degradeReason as WorkRecapDegradeReason)
  ) {
    degradeReason = raw.degradeReason as WorkRecapDegradeReason;
  }
  if (degraded && !degradeReason) degradeReason = "sparse_signal";
  if (!degraded && degradeReason) degraded = true;

  const inference: WorkRecapInference = {
    summary,
    workMode,
    workModeReason,
    nextUp,
    fragmentation,
    degraded,
    degradeReason,
  };

  // Fact-vs-text guard: if LLM claim contradicts deterministic facts, force
  // degrade (text dropped in favor of facts, per design).
  if (detectTextFactConflict(inference, facts)) {
    return {
      ...inference,
      summary: factualFallbackSummary(facts),
      degraded: true,
      degradeReason: "text_fact_conflict",
    };
  }

  return inference;
}

/**
 * Build a deterministic factual summary when no LLM is available or the LLM
 * output was rejected. This is what the user sees in the degraded card.
 */
export function factualFallbackSummary(facts: WorkRecapFacts): string {
  if (facts.totalCommits === 0) {
    return `窗口 ${facts.windowKey} 内未检测到 ${facts.authorEmail} 的 commit。`;
  }
  const topProjects = facts.projectShare
    .slice(0, 3)
    .map((p) => `${p.projectLabel}(${p.commitCount})`)
    .join("、");
  const kindBreakdown = Object.entries(facts.commitTypeCounts)
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([k, n]) => `${k}=${n}`)
    .join(" / ");
  return `${facts.windowKey} 内共 ${facts.totalCommits} 条 commit，跨 ${facts.projectCount} 个项目。最活跃：${topProjects}。类型分布：${kindBreakdown || "—"}。`;
}

export type CallLlmArgs = {
  facts: WorkRecapFacts;
  prompt: PromptOutput;
  config: LlmChatConfig;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
};

/**
 * Call the configured LLM provider with the prepared prompt. Returns a
 * normalized WorkRecapInference or throws WorkRecapLlmError with a
 * structured reason code.
 *
 * Timeout pattern mirrors src/dailySummary/llm.ts:128 (AbortController +
 * setTimeout + clearTimeout in finally).
 */
export async function callLlm(args: CallLlmArgs): Promise<WorkRecapInference> {
  const apiKey = resolveApiKey(args.config);
  if (!apiKey) {
    throw new WorkRecapLlmError(
      "llm_unavailable",
      `LLM provider ${args.config.provider} requires an API key`
    );
  }

  const url = chatCompletionsUrl(args.config.baseURL);
  const fetchImpl = args.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timeoutMs = args.timeoutMs ?? WORK_RECAP_LLM_TIMEOUT_MS;
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: args.config.model,
        temperature: 0.2,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: args.prompt.prompt },
        ],
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new WorkRecapLlmError(
        "llm_unavailable",
        `LLM request failed with ${response.status}`
      );
    }

    const body = (await response.json()) as {
      choices?: Array<{ message?: { content?: unknown } }>;
    };
    const rawContent = body.choices?.[0]?.message?.content;
    if (typeof rawContent !== "string" || !rawContent.trim()) {
      throw new WorkRecapLlmError("llm_empty", "LLM returned empty content");
    }

    let parsed: LlmRawResponse;
    try {
      parsed = JSON.parse(rawContent) as LlmRawResponse;
    } catch {
      throw new WorkRecapLlmError(
        "llm_malformed",
        "LLM returned non-JSON content"
      );
    }

    return normalizeResult(parsed, args.facts);
  } catch (error) {
    if (error instanceof WorkRecapLlmError) throw error;
    if (error instanceof Error && error.name === "AbortError") {
      throw new WorkRecapLlmError(
        "llm_timeout",
        `LLM request timed out after ${timeoutMs}ms`
      );
    }
    throw new WorkRecapLlmError(
      "llm_unavailable",
      error instanceof Error ? error.message : String(error)
    );
  } finally {
    clearTimeout(timeout);
  }
}

/** Convert a thrown WorkRecapLlmError into a degraded inference payload. */
export function inferenceFromLlmError(
  error: WorkRecapLlmError,
  facts: WorkRecapFacts
): WorkRecapInference {
  return {
    summary: factualFallbackSummary(facts),
    workMode: "low_signal",
    workModeReason: `LLM 摘要不可用（${error.reason}），仅展示事实层。`,
    nextUp: [],
    fragmentation: "low",
    degraded: true,
    degradeReason: error.reason,
  };
}

/** Convert a sparse-signal window into the degraded inference payload. */
export function inferenceFromSparseSignal(
  facts: WorkRecapFacts
): WorkRecapInference {
  return {
    summary: factualFallbackSummary(facts),
    workMode: "low_signal",
    workModeReason: "窗口内 commit 极少，未做主观推断。",
    nextUp: [],
    fragmentation: "low",
    degraded: true,
    degradeReason: "sparse_signal",
  };
}
