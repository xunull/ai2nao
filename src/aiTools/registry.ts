/**
 * AI 工具指纹库(本功能的核心资产)。curated,确定可解释,不用关键词启发式(会误判)。
 *
 * 说明:只有 Claude(`com.anthropic.*`)与 Kimi(`com.moonshot.kimichat`)的 bundle_id 是
 * 实机核实过的;其余桌面 app 用 `macNameExact`(app 名)匹配,不瞎编 bundle_id。扩充这份清单
 * 是 v1 落地后的第一件事(设计 §10)——覆盖度直接决定清单准不准。
 */
import type { AiToolFingerprint } from "./types.js";

export const AI_TOOL_REGISTRY: AiToolFingerprint[] = [
  {
    toolKey: "claude-desktop",
    name: "Claude",
    kind: "desktop-app",
    vendor: "Anthropic",
    macBundleIdPrefix: "com.anthropic.",
    binaries: ["claude"], // Claude Code CLI
  },
  {
    toolKey: "kimi-desktop",
    name: "Kimi",
    kind: "desktop-app",
    vendor: "Moonshot",
    macBundleId: "com.moonshot.kimichat",
  },
  {
    toolKey: "chatgpt-desktop",
    name: "ChatGPT",
    kind: "desktop-app",
    vendor: "OpenAI",
    macNameExact: "ChatGPT",
  },
  {
    toolKey: "cursor",
    name: "Cursor",
    kind: "desktop-app",
    vendor: "Anysphere",
    macNameExact: "Cursor",
    binaries: ["cursor"],
  },
  {
    toolKey: "lm-studio",
    name: "LM Studio",
    kind: "local-runtime",
    vendor: "Element Labs",
    macNameExact: "LM Studio",
    brewCask: "lm-studio",
  },
  {
    toolKey: "ollama",
    name: "Ollama",
    kind: "local-runtime",
    vendor: "Ollama",
    brewFormula: "ollama",
    brewCask: "ollama",
    binaries: ["ollama"],
  },
  {
    toolKey: "codex-cli",
    name: "Codex CLI",
    kind: "cli",
    vendor: "OpenAI",
    binaries: ["codex"],
  },
  {
    toolKey: "gemini-cli",
    name: "Gemini CLI",
    kind: "cli",
    vendor: "Google",
    binaries: ["gemini"],
  },
  {
    toolKey: "opencode",
    name: "opencode",
    kind: "cli",
    binaries: ["opencode"],
  },
  {
    toolKey: "aider",
    name: "Aider",
    kind: "cli",
    binaries: ["aider"],
  },
];
