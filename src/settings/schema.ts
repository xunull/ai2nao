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
 * **深走 `providers{}`,不是浅 omit。**
 *
 * 密钥已经从顶层 `keys{}` 搬进了每个实例的 `apiKey`。浅 omit 只删顶层键,
 * 对嵌套一层的 `providers.x.apiKey` 完全够不着 —— 那就是把每一把 key 的明文
 * 原样送进浏览器。脱敏函数必须跟着形状走,否则它只是看起来在脱敏。
 *
 * 不整块删 apiKey 而换成 `hasKey` 布尔:设置页要显示「这家配过 / 没配过」,
 * 整块删会让界面无从判断,于是把一个明明存着 key 的实例画成「未配置」,
 * 用户以为要重填 —— 而留空才是「别动已存的那把」。
 */
function redactLlmChat(parsed: unknown): unknown {
  if (!isPlainRecord(parsed)) return omit(parsed, LLM_CHAT_SECRET_FIELDS);
  const out = omit(parsed, LLM_CHAT_SECRET_FIELDS) as Record<string, unknown>;
  if (!isPlainRecord(parsed.providers)) return out;
  const providers: Record<string, unknown> = {};
  for (const [id, inst] of Object.entries(parsed.providers)) {
    if (!isPlainRecord(inst)) continue;
    const { apiKey, ...rest } = inst;
    providers[id] = { ...rest, hasKey: typeof apiKey === "string" && apiKey.trim().length > 0 };
  }
  out.providers = providers;
  return out;
}

function llmChatHasSecret(parsed: unknown): boolean {
  if (!isPlainRecord(parsed)) return false;
  // 顶层 apiKey:归一之后不该再出现,但迁移途中/手改文件时可能有,别漏判。
  if (field(parsed, "apiKey")) return true;
  if (!isPlainRecord(parsed.providers)) return false;
  return Object.values(parsed.providers).some(
    (inst) =>
      isPlainRecord(inst) && typeof inst.apiKey === "string" && inst.apiKey.trim().length > 0
  );
}

export const CREDENTIAL_SPECS: Record<CredentialName, CredentialSpec> = {
  "llm-chat": {
    // 归一到 providers{} 的解析器,不是塌缩的那个:patchCredential 把 parse 的
    // 输出写回库,用 resolveLlmChatConfig 那种塌缩语义会让每次保存吃掉其余厂商。
    // 它对内容问题一律降级、只在结构性不可解析时返回 null —— 那是刻意的:
    // 返回 null 会让 mergePatch 退化成空对象,把库里其余厂商连密钥一起清掉。
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
    // 「· 额度查询」是与 llm-chat 里的对话 key 区分用途:这把打 token_plan/remains,
    // 那把打 /chat/completions,实测可能不是同一把(2026-09-02:kimi 的额度 key 打
    // api.moonshot.ai 是 401)。同名会让人不知道该填哪个,改一把也不会拖累另一个。
    label: "MiniMax · 额度查询",
  },
  kimi: {
    parse: parseKimiJson,
    envVar: null,
    hasSecret: (p) => Boolean(field(p, "apiKey")),
    redact: (p) => omit(p, API_KEY_ONLY),
    secretFields: API_KEY_ONLY,
    legacyPath: null,
    label: "Kimi Code · 额度查询",
  },
};
