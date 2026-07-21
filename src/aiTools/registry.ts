/**
 * AI 工具指纹库(本功能的核心资产)。curated,确定可解释,不用关键词启发式(会误判)。
 *
 * 说明:桌面 app 的 bundle_id 尽量取自本机 `mac_apps` 表(已装即权威),没装的用
 * `macNameExact`(app 名)兜底,绝不瞎编;CLI 用二进制名。扩充这份清单直接决定清单准不准
 * (设计 §10)。
 */
import type { AiToolFingerprint } from "./types.js";

export const AI_TOOL_REGISTRY: AiToolFingerprint[] = [
  {
    toolKey: "claude-desktop",
    name: "Claude",
    kind: "desktop-app",
    vendor: "Anthropic",
    macBundleId: "com.anthropic.claudefordesktop",
  },
  {
    toolKey: "claude-code",
    name: "Claude Code",
    kind: "cli",
    vendor: "Anthropic",
    binaries: ["claude"],
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
  {
    toolKey: "cc-switch",
    name: "CC Switch",
    kind: "desktop-app",
    vendor: "ccswitch.io",
    macBundleId: "com.ccswitch.desktop",
  },
  {
    toolKey: "warp",
    name: "Warp",
    kind: "desktop-app",
    vendor: "Warp",
    macBundleId: "dev.warp.Warp-Stable",
  },
  {
    toolKey: "cherry-studio",
    name: "Cherry Studio",
    kind: "desktop-app",
    vendor: "Cherry Studio",
    macBundleId: "com.kangfenmao.CherryStudio",
  },
  {
    toolKey: "tencent-ima",
    name: "ima.copilot",
    kind: "desktop-app",
    vendor: "腾讯",
    macBundleId: "com.tencent.imamac",
  },
  {
    toolKey: "hermes-agent",
    name: "Hermes Agent",
    kind: "cli",
    vendor: "Nous Research",
    // 注:React Native 的 JS 引擎二进制也叫 hermes;本机的是 ~/.hermes 下的 Nous agent。
    binaries: ["hermes"],
  },
];
