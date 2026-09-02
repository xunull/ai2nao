import {
  defaultGithubConfigPath,
  defaultLlmChatConfigPath,
  defaultWebSearchConfigPath,
} from "../config.js";
import { parseGithubConfigJson } from "../github/config.js";
import { parseLlmChatDocument } from "../llmChat/config.js";
import { defaultNotifyConfigPath, parseNotifyConfigJson } from "../notify/config.js";
import { parseRagEmbeddingJson } from "../rag/config.js";
import { parseWebSearchConfigJson } from "../webSearch/config.js";
import { resolve } from "node:path";
import type { CredentialName } from "./store.js";

/**
 * name → validator registry.
 *
 * The validators are the SAME parsers the features already used on their JSON
 * files, so a credential's `value_json` is exactly the JSON that used to be the
 * file's contents. Two consequences worth stating: migration is a copy (never a
 * translation, so it can't mangle a config), and a value that round-trips
 * through this table is by construction one the feature can already read.
 *
 * Imported only by leaves (routes, migration). `store.ts` must NOT import this,
 * or readers → store → schema → readers would be a cycle.
 */

export type CredentialSpec = {
  /** Reject invalid shapes. Returns the value to persist (normalized by the parser). */
  parse: (raw: string) => unknown | null;
  /** Env var that WINS over the stored value, for the credentials where it does today. */
  envVar: string | null;
  /** True when the parsed value actually carries a secret (vs. just settings). */
  hasSecret: (parsed: unknown) => boolean;
  /**
   * Strip every secret field, leaving only what is safe to show in the UI
   * (provider, model, baseURL, hours…). This is the ONLY shape that may leave
   * the server — no plaintext key, and no last-4 either: a Feishu signing secret
   * is short enough that four characters is a real chunk of its entropy.
   */
  redact: (parsed: unknown) => unknown;
  /** Which keys the redactor removes — also the keys a PATCH treats as secrets. */
  secretFields: readonly string[];
  /** Legacy JSON file this credential was read from, if any (null = never had one). */
  legacyPath: (() => string) | null;
  /** Human label for the settings UI. */
  label: string;
};

/**
 * Resolve a legacy config path the SAME way its reader does — honouring the
 * `AI2NAO_*_CONFIG` override. Using the bare `default…Path()` here would point
 * migration at the developer's real `~/.ai2nao/github.json` even when a test had
 * redirected the reader to a temp file, and migration RENAMES what it finds.
 */
function pathFromEnv(envVar: string, fallback: () => string): () => string {
  return () => {
    const raw = (process.env[envVar] ?? "").trim();
    return raw.length > 0 ? resolve(raw) : fallback();
  };
}

/** Shallow drop of the given keys. */
function omit(parsed: unknown, keys: readonly string[]): unknown {
  if (typeof parsed !== "object" || parsed === null) return parsed;
  const out: Record<string, unknown> = { ...(parsed as Record<string, unknown>) };
  for (const k of keys) delete out[k];
  return out;
}

function field(parsed: unknown, key: string): string | undefined {
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const v = (parsed as Record<string, unknown>)[key];
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

/** Minimax has no JSON file — its key lived in index.db's `provider_config.api_key`. */
function parseMinimaxJson(raw: string): { apiKey: string } | null {
  try {
    const data: unknown = JSON.parse(raw);
    const apiKey = field(data, "apiKey");
    return apiKey ? { apiKey } : null;
  } catch {
    return null;
  }
}

/** Kimi Code has no JSON file either — key entered on the Providers page, config.db only. */
function parseKimiJson(raw: string): { apiKey: string } | null {
  try {
    const data: unknown = JSON.parse(raw);
    const apiKey = field(data, "apiKey");
    return apiKey ? { apiKey } : null;
  } catch {
    return null;
  }
}

const API_KEY_ONLY = ["apiKey"] as const;

function isPlainRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

/**
 * llm-chat 的秘密**有两个位置**:多模型文档在顶层 `keys` 对象里,迁移前的单模型
 * 配置在顶层 `apiKey`。只列其中一个,另一种形状就会原样漏进 API 响应 ——
 * `omit()` 是浅删,不会替你去嵌套结构里找。
 */
const LLM_CHAT_SECRET_FIELDS = ["apiKey", "keys"] as const;

/**
 * `keys` 不整块抹掉,换成 presence map:设置页需要显示「这家配过 / 没配过」,
 * 整块删会让 UI 无从判断,而返回原值就是把 5 把 key 明文送进浏览器。
 */
function redactLlmChat(parsed: unknown): unknown {
  const out = omit(parsed, LLM_CHAT_SECRET_FIELDS) as Record<string, unknown>;
  if (isPlainRecord(parsed) && isPlainRecord(parsed.keys)) {
    const presence: Record<string, boolean> = {};
    for (const [k, v] of Object.entries(parsed.keys)) {
      presence[k] = typeof v === "string" && v.trim().length > 0;
    }
    out.keys = presence;
  }
  return out;
}

function llmChatHasSecret(parsed: unknown): boolean {
  if (field(parsed, "apiKey")) return true;
  if (isPlainRecord(parsed) && isPlainRecord(parsed.keys)) {
    return Object.values(parsed.keys).some(
      (v) => typeof v === "string" && v.trim().length > 0
    );
  }
  return false;
}

export const CREDENTIAL_SPECS: Record<CredentialName, CredentialSpec> = {
  "llm-chat": {
    // 形状保持的解析器,不是塌缩的那个:patchCredential 把 parse 的输出写回库,
    // 用 resolveLlmChatConfig 那种塌缩语义会让每次保存吃掉其余模型条目。
    parse: parseLlmChatDocument,
    // Env keys (DEEPSEEK_API_KEY etc.) are a FALLBACK applied downstream in
    // llmChat/model.ts (`cfg.apiKey || env`), not an override — so: null.
    envVar: null,
    hasSecret: llmChatHasSecret,
    redact: redactLlmChat,
    secretFields: LLM_CHAT_SECRET_FIELDS,
    legacyPath: pathFromEnv("AI2NAO_LLM_CHAT_CONFIG", defaultLlmChatConfigPath),
    label: "AI 对话模型",
  },
  "rag-embedding": {
    parse: parseRagEmbeddingJson,
    envVar: null,
    hasSecret: (p) => Boolean(field(p, "apiKey")),
    redact: (p) => omit(p, API_KEY_ONLY),
    secretFields: API_KEY_ONLY,
    // Only the `embedding` block moves; the rest of rag.json (corpusRoots …)
    // stays a file, so there is no whole-file legacy path to retire here.
    legacyPath: null,
    label: "RAG 向量化",
  },
  "web-search": {
    parse: parseWebSearchConfigJson,
    envVar: "BRAVE_SEARCH_API_KEY", // env-first today (webSearch/config.ts) — kept
    hasSecret: (p) => Boolean(field(p, "apiKey")),
    redact: (p) => omit(p, API_KEY_ONLY),
    secretFields: API_KEY_ONLY,
    legacyPath: pathFromEnv("AI2NAO_WEB_SEARCH_CONFIG", defaultWebSearchConfigPath),
    label: "联网搜索",
  },
  github: {
    parse: parseGithubConfigJson,
    envVar: "GITHUB_TOKEN", // env-first today (github/config.ts) — kept
    hasSecret: (p) => Boolean(field(p, "token")),
    redact: (p) => omit(p, ["token"]),
    secretFields: ["token"],
    legacyPath: pathFromEnv("AI2NAO_GITHUB_CONFIG", defaultGithubConfigPath),
    label: "GitHub",
  },
  feishu: {
    parse: parseNotifyConfigJson,
    envVar: null,
    // The webhook URL is itself a credential — anyone holding it can post to your
    // group, signing secret or not. So it gets redacted like a key, not shown
    // back like a setting.
    hasSecret: (p) => {
      if (typeof p !== "object" || p === null) return false;
      const f = (p as { feishu?: unknown }).feishu;
      return Boolean(field(f, "webhookUrl"));
    },
    redact: (p) => {
      if (typeof p !== "object" || p === null) return p;
      const o = p as Record<string, unknown>;
      const f = (o.feishu ?? {}) as Record<string, unknown>;
      return { ...o, feishu: omit(f, ["webhookUrl", "secret"]) };
    },
    secretFields: ["webhookUrl", "secret"], // nested under `feishu` — see patchFeishu
    legacyPath: defaultNotifyConfigPath,
    label: "飞书推送",
  },
  minimax: {
    parse: parseMinimaxJson,
    envVar: null,
    hasSecret: (p) => Boolean(field(p, "apiKey")),
    redact: (p) => omit(p, API_KEY_ONLY),
    secretFields: API_KEY_ONLY,
    legacyPath: null,
    label: "MiniMax",
  },
  kimi: {
    parse: parseKimiJson,
    envVar: null,
    hasSecret: (p) => Boolean(field(p, "apiKey")),
    redact: (p) => omit(p, API_KEY_ONLY),
    secretFields: API_KEY_ONLY,
    legacyPath: null,
    label: "Kimi Code",
  },
};
