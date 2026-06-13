/**
 * Cosmos session 摘要生成。
 *
 * 哲学：embedding 的"语义信号"应来自**用户问的实质问题**和**模型回的实质
 * 答案**，不应被 Claude Code 自己注入的 boilerplate（slash-command 前缀、
 * `<local-command-caveat>`、`<command-message>`、`<system-reminder>` 等等）
 * 拽走。
 *
 * T1b spike 发现：5 个最大的 Claude session 里 4 个都以
 * `<local-command-caveat>Caveat: ...` 开头，导致 cosine 0.997 的伪相似。
 * 不剥掉这些前缀，cosmos 散点会被同源 boilerplate 拽到一起，毁掉视觉。
 */
import type { Message } from "../cursorHistory/types.js";

/**
 * Patterns we strip from user message text before embedding. The list is
 * intentionally narrow: we only strip Claude Code / Codex CLI control wrappers
 * that the user does NOT type — they're metadata the host injects to give the
 * model context. The user's actual question, if any, still survives.
 */
const CONTROL_TAG_PATTERNS: RegExp[] = [
  /<local-command-caveat>[\s\S]*?<\/local-command-caveat>/gi,
  /<local-command-stdout>[\s\S]*?<\/local-command-stdout>/gi,
  /<local-command-stderr>[\s\S]*?<\/local-command-stderr>/gi,
  /<command-message>[\s\S]*?<\/command-message>/gi,
  /<command-name>[\s\S]*?<\/command-name>/gi,
  /<command-args>[\s\S]*?<\/command-args>/gi,
  /<command-stdout>[\s\S]*?<\/command-stdout>/gi,
  /<command-stderr>[\s\S]*?<\/command-stderr>/gi,
  /<system-reminder>[\s\S]*?<\/system-reminder>/gi,
  /<bash-input>[\s\S]*?<\/bash-input>/gi,
  /<bash-stdout>[\s\S]*?<\/bash-stdout>/gi,
  /<bash-stderr>[\s\S]*?<\/bash-stderr>/gi,
];

// ANSI escape sequences (\x1B[...m, \x1B[K, etc.) leak through from terminal
// command output and pollute embedding signal. Strip CSI / SGR cleanly.
const ANSI_PATTERN = /\x1B\[[0-9;?]*[A-Za-z]/g;

const MAX_SUMMARY_CHARS = 2048;

export function stripControlTags(raw: string): string {
  let out = raw;
  for (const pat of CONTROL_TAG_PATTERNS) {
    out = out.replace(pat, "");
  }
  out = out.replace(ANSI_PATTERN, "");
  return out.trim();
}

function pickFirstSubstantiveUser(messages: Message[]): string {
  for (const m of messages) {
    if (m.role !== "user") continue;
    const cleaned = stripControlTags(m.content ?? "");
    if (cleaned.length >= 20) return cleaned;
  }
  // fallback — first user message even if boilerplate, just to have something
  for (const m of messages) {
    if (m.role !== "user") continue;
    const fallback = stripControlTags(m.content ?? "");
    if (fallback) return fallback;
  }
  return "";
}

function pickLastSubstantiveAssistant(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role !== "assistant") continue;
    const cleaned = stripControlTags(m.content ?? "");
    if (cleaned.length >= 20) return cleaned;
  }
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role !== "assistant") continue;
    const fallback = stripControlTags(m.content ?? "");
    if (fallback) return fallback;
  }
  return "";
}

/**
 * Build the text we hand to the embedding provider for one session.
 * Returns null when there's nothing substantive to embed — the caller must
 * mark that session `embedding_status='no_summary'` and skip it.
 */
export function summarizeSessionForCosmos(
  messages: Message[]
): string | null {
  const firstUser = pickFirstSubstantiveUser(messages);
  const lastAssistant = pickLastSubstantiveAssistant(messages);
  if (!firstUser && !lastAssistant) return null;
  const combined = [firstUser, "---", lastAssistant]
    .filter(Boolean)
    .join("\n\n")
    .slice(0, MAX_SUMMARY_CHARS);
  return combined.trim() || null;
}
