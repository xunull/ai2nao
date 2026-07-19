import type { LlmChatConfig } from "../llmChat/config.js";
import {
  chatCompletionsUrl,
  resolveLlmChatApiKey,
} from "../llmChat/chatCompletions.js";
import type {
  DailySummaryDegradeReason,
  DailySummaryFacts,
  DailySummaryWorkMode,
} from "./types.js";

export type DailySummaryLlmConfig = {
  baseUrl: string | null;
  model: string | null;
  apiKey: string | null;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
};

/**
 * 从 llm-chat 配置(设置 → AI 与模型)构造每日摘要要用的 LLM config。
 * 每日摘要与工作复盘共用同一份 llm-chat —— 之前它走 `--llm-base-url`/`--llm-model`
 * 命令行/env 是条没并进设置中心的老路,已收编。
 */
export function buildDailySummaryLlmConfig(
  cfg: LlmChatConfig | null,
  timeoutMs: number,
  fetchImpl?: typeof fetch
): DailySummaryLlmConfig {
  return {
    baseUrl: cfg?.baseURL ?? null,
    model: cfg?.model ?? null,
    apiKey: cfg ? resolveLlmChatApiKey(cfg) : null,
    timeoutMs,
    ...(fetchImpl ? { fetchImpl } : {}),
  };
}

export type DailySummaryLlmResult = {
  summary: string;
  nextUp: string | null;
  workMode: DailySummaryWorkMode | null;
  primaryRepoLabel: string | null;
};

export class DailySummaryLlmError extends Error {
  constructor(readonly reason: DailySummaryDegradeReason, message: string) {
    super(message);
  }
}

type LlmResponseShape = {
  summary?: unknown;
  nextUp?: unknown;
  workMode?: unknown;
  primaryRepoLabel?: unknown;
};

const WORK_MODES = new Set<DailySummaryWorkMode>([
  "implementation",
  "debugging",
  "exploration",
]);

function buildPrompt(date: string, facts: DailySummaryFacts): string {
  const repoFacts = facts.repoFacts.map((repo) => ({
    repoLabel: repo.repoLabel,
    matched: repo.matched,
    commandCount: repo.commandCount,
    sampleCommands: repo.sampleCommands,
    blurb: repo.blurb,
  }));

  return [
    "You are generating a concise developer daily summary.",
    "Return JSON only. No markdown fences. No extra prose.",
    "Schema:",
    JSON.stringify(
      {
        summary: "string",
        nextUp: "string|null",
        workMode: "implementation|debugging|exploration|null",
        primaryRepoLabel: "string|null",
      },
      null,
      2
    ),
    "Rules:",
    "- Use uncertainty when evidence is weak.",
    "- Never invent a repo label outside the provided repoFacts.",
    "- If nextUp is weak, return null.",
    `- Date: ${date}`,
    "Facts:",
    JSON.stringify(
      {
        recap: facts.recap,
        topRepoLabel: facts.topRepoLabel,
        nextUpHint: facts.nextUpHint,
        sparse: facts.sparse,
        totalCommands: facts.totalCommands,
        distinctCwds: facts.distinctCwds,
        repoMatches: facts.repoMatches,
        outsideIndexedRepos: facts.outsideIndexedRepos,
        repoFacts,
      },
      null,
      2
    ),
  ].join("\n");
}

function normalizeResult(json: LlmResponseShape): DailySummaryLlmResult {
  if (typeof json.summary !== "string" || !json.summary.trim()) {
    throw new DailySummaryLlmError("llm_malformed", "summary missing");
  }

  const nextUp =
    typeof json.nextUp === "string" && json.nextUp.trim()
      ? json.nextUp.trim()
      : null;

  const workMode =
    typeof json.workMode === "string" && WORK_MODES.has(json.workMode as DailySummaryWorkMode)
      ? (json.workMode as DailySummaryWorkMode)
      : null;

  const primaryRepoLabel =
    typeof json.primaryRepoLabel === "string" && json.primaryRepoLabel.trim()
      ? json.primaryRepoLabel.trim()
      : null;

  return {
    summary: json.summary.trim(),
    nextUp,
    workMode,
    primaryRepoLabel,
  };
}

export async function generateDailySummaryText(
  date: string,
  facts: DailySummaryFacts,
  config: DailySummaryLlmConfig
): Promise<DailySummaryLlmResult> {
  if (!config.baseUrl || !config.model) {
    throw new DailySummaryLlmError(
      "llm_unavailable",
      "daily summary LLM not configured"
    );
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
  const fetchImpl = config.fetchImpl ?? fetch;

  try {
    const response = await fetchImpl(chatCompletionsUrl(config.baseUrl), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: config.model,
        temperature: 0.2,
        messages: [
          {
            role: "system",
            content:
              "You summarize local developer activity. Return strict JSON that matches the requested schema.",
          },
          {
            role: "user",
            content: buildPrompt(date, facts),
          },
        ],
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new DailySummaryLlmError(
        "llm_unavailable",
        `LLM request failed with ${response.status}`
      );
    }

    const body = (await response.json()) as {
      choices?: Array<{ message?: { content?: unknown } }>;
    };
    const rawContent = body.choices?.[0]?.message?.content;
    if (typeof rawContent !== "string" || !rawContent.trim()) {
      throw new DailySummaryLlmError("llm_empty", "LLM returned empty content");
    }

    let parsed: LlmResponseShape;
    try {
      parsed = JSON.parse(rawContent) as LlmResponseShape;
    } catch {
      throw new DailySummaryLlmError(
        "llm_malformed",
        "LLM returned malformed JSON"
      );
    }

    return normalizeResult(parsed);
  } catch (error) {
    if (error instanceof DailySummaryLlmError) throw error;
    if (error instanceof Error && error.name === "AbortError") {
      throw new DailySummaryLlmError("llm_timeout", "LLM request timed out");
    }
    throw new DailySummaryLlmError(
      "llm_unavailable",
      error instanceof Error ? error.message : String(error)
    );
  } finally {
    clearTimeout(timeout);
  }
}

