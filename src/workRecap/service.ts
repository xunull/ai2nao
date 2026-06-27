import type Database from "better-sqlite3";
import { execGitSync } from "../git/exec.js";
import type { LlmChatConfig } from "../llmChat/config.js";
import { computeFacts, isSparseFacts } from "./facts.js";
import {
  WorkRecapLlmError,
  callLlm,
  inferenceFromLlmError,
  inferenceFromSparseSignal,
} from "./llm.js";
import { buildPrompt, PROMPT_VERSION } from "./prompt.js";
import {
  cleanupRetention,
  insertRecapRun,
  listIndexedRepoPaths,
} from "./queries.js";
import { scanCommits } from "./scan.js";
import {
  WORK_RECAP_RETENTION_PER_WINDOW,
  type WorkRecapDegradeReason,
  type WorkRecapEmptyResponse,
  type WorkRecapInference,
  type WorkRecapRun,
  type WorkRecapWindow,
  windowToDays,
} from "./types.js";

export type WorkRecapRuntime = {
  db: Database.Database;
  llmConfig: LlmChatConfig | null;
  /** Override author email; default = `git config --global user.email`. */
  authorEmail?: string;
  /** Override scan timeout (ms). */
  scanTimeoutMs?: number;
  /** Override LLM call timeout (ms). */
  llmTimeoutMs?: number;
  /** Injectable fetch for tests. */
  fetchImpl?: typeof fetch;
  /** Override retention. */
  retentionPerWindow?: number;
  /** Override "now" (defaults to new Date()). Tests pass a fixed clock. */
  now?: () => Date;
  /** Override repo path source (tests). */
  resolveRepoPaths?: (db: Database.Database) => string[];
  /** Override author resolver (tests). */
  resolveAuthorEmail?: () => string | null;
};

export type GenerateRecapResult =
  | { kind: "ok"; run: WorkRecapRun }
  | { kind: "empty"; response: WorkRecapEmptyResponse };

/** The machine's global git author email (`git config --global user.email`), or null. */
export function resolveGlobalAuthorEmail(): string | null {
  try {
    const out = execGitSync(["config", "--global", "user.email"], {
      cwd: process.cwd(),
    }).trim();
    return out || null;
  } catch {
    return null;
  }
}

function modelLabel(cfg: LlmChatConfig | null): string {
  if (!cfg) return "no-llm";
  return `${cfg.provider}:${cfg.model}`;
}

/**
 * Orchestrate a single recap generation:
 *   1. resolve author email (`git config --global user.email`)
 *   2. read repos.path_canonical from store
 *   3. scan all repos in parallel (10s hard timeout)
 *   4. compute deterministic facts
 *   5. if sparse → skip LLM, write sparse-signal recap
 *      else → buildPrompt → callLlm → handle degrade reasons
 *   6. insertRecapRun → cleanupRetention
 *
 * Returns either the inserted run or an empty-repos response. Never throws
 * for expected failure modes — degradation lives in inference.degraded.
 */
export async function generateRecap(
  windowKey: WorkRecapWindow,
  runtime: WorkRecapRuntime
): Promise<GenerateRecapResult> {
  const resolveRepos =
    runtime.resolveRepoPaths ?? ((db) => listIndexedRepoPaths(db));
  const repoPaths = resolveRepos(runtime.db);
  if (repoPaths.length === 0) {
    return {
      kind: "empty",
      response: {
        ok: true,
        empty: true,
        reason: "no_repos_indexed",
      },
    };
  }

  const resolveAuthor =
    runtime.resolveAuthorEmail ?? resolveGlobalAuthorEmail;
  const authorEmail = runtime.authorEmail ?? resolveAuthor() ?? "unknown";

  const now = runtime.now ? runtime.now() : new Date();
  const since = new Date(now.getTime() - windowToDays(windowKey) * 86_400_000);

  const scan = await scanCommits({
    repoPaths,
    authorEmail,
    since,
    timeoutMs: runtime.scanTimeoutMs,
  });

  const scanTruncatedReason: WorkRecapDegradeReason | null = scan.truncatedReason;

  const facts = computeFacts({
    commits: scan.commits,
    windowKey,
    windowStart: since,
    windowEnd: now,
    authorEmail,
    reposScanned: scan.reposScanned,
    reposTotal: scan.reposTotal,
    scanTruncated: scan.truncated,
    scanTruncatedReason,
    scanDiagnostics: scan.diagnostics,
  });

  let inference: WorkRecapInference;

  if (isSparseFacts(facts)) {
    inference = inferenceFromSparseSignal(facts);
  } else if (!runtime.llmConfig) {
    inference = inferenceFromLlmError(
      new WorkRecapLlmError(
        "llm_unavailable",
        "LLM chat config not present; install llm-chat.config.json"
      ),
      facts
    );
  } else {
    const prompt = buildPrompt({ facts, commits: scan.commits });
    if (prompt.budgetExceeded) {
      facts.scanTruncated = true;
      // Prefer the more specific reason if scan also truncated; otherwise
      // expose prompt_budget_exceeded to the UI.
      if (!facts.scanTruncatedReason) {
        facts.scanTruncatedReason = "prompt_budget_exceeded";
      }
      facts.diagnostics.push({
        severity: "warning",
        kind: "prompt_budget_exceeded",
        message: `prompt budget exceeded; trimmed to top projects and per-project sample`,
      });
    }
    try {
      inference = await callLlm({
        facts,
        prompt,
        config: runtime.llmConfig,
        timeoutMs: runtime.llmTimeoutMs,
        fetchImpl: runtime.fetchImpl,
      });
    } catch (e) {
      if (e instanceof WorkRecapLlmError) {
        inference = inferenceFromLlmError(e, facts);
      } else {
        inference = inferenceFromLlmError(
          new WorkRecapLlmError(
            "llm_unavailable",
            e instanceof Error ? e.message : String(e)
          ),
          facts
        );
      }
    }
  }

  const run = insertRecapRun(runtime.db, {
    windowKey,
    generatedAt: now,
    model: modelLabel(runtime.llmConfig),
    promptVersion: PROMPT_VERSION,
    facts,
    inference,
  });

  cleanupRetention(
    runtime.db,
    windowKey,
    runtime.retentionPerWindow ?? WORK_RECAP_RETENTION_PER_WINDOW
  );

  return { kind: "ok", run };
}

/** Exposed for tests so they can stub the author resolver without exec. */
export const __testing = { resolveGlobalAuthorEmail };
