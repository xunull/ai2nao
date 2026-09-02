import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { defaultLlmChatConfigPath } from "../config.js";
import { getCredentialRaw } from "../settings/store.js";
// 运行期依赖是单向的:config → apiKeySource。反向只有 type-only import,编译后擦除,不成环。
import {
  credentialSourceOf,
  resolveApiKeySource,
  type CredentialSource,
} from "./apiKeySource.js";
import { llmChatLog } from "./log.js";

export type LlmChatProvider =
  | "alibaba"
  | "deepseek"
  | "minimax"
  | "moonshotai"
  | "openai"
  | "openai-compatible"
  | "volcengine";

/**
 * 每家的默认 base URL。设置页选服务商时预填这个值,`parseLlmChatConfigJson`
 * 在缺省时也用它 —— 两处必须同源,否则「界面显示的地址」与「真正打出去的地址」会分叉。
 *
 * volcengine / minimax 底层都走 `openai-compatible` 适配器,但给它们独立的
 * provider id 是为了能预填地址;让用户自己去记 ark 的那串路径不现实。
 */
export const LLM_CHAT_DEFAULT_BASE_URLS: Record<LlmChatProvider, string> = {
  alibaba: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
  deepseek: "https://api.deepseek.com",
  minimax: "https://api.minimaxi.com/v1",
  moonshotai: "https://api.moonshot.ai/v1",
  openai: "https://api.openai.com/v1",
  "openai-compatible": "",
  volcengine: "https://ark.cn-beijing.volces.com/api/v3",
};

export const LLM_CHAT_PROVIDERS = Object.keys(
  LLM_CHAT_DEFAULT_BASE_URLS
) as LlmChatProvider[];

export type LlmChatConfig =
  | {
      provider: "deepseek";
      /** DeepSeek API base URL. Do not append `/v1` for the official API. */
      baseURL: string;
      model: string;
      /** Optional; falls back to `DEEPSEEK_API_KEY` or `AI2NAO_LLM_API_KEY`. */
      apiKey?: string;
    }
  | {
      provider: "moonshotai";
      /** Moonshot API base URL, defaulting to `https://api.moonshot.ai/v1`. */
      baseURL: string;
      model: string;
      /** Optional; falls back to `MOONSHOT_API_KEY` or `AI2NAO_LLM_API_KEY`. */
      apiKey?: string;
    }
  | {
      provider: "alibaba";
      /** DashScope OpenAI-compatible base URL. */
      baseURL: string;
      model: string;
      /** Optional; falls back to `ALIBABA_API_KEY` or `AI2NAO_LLM_API_KEY`. */
      apiKey?: string;
    }
  | {
      provider: "openai";
      /** OpenAI API base URL, defaulting to `https://api.openai.com/v1`. */
      baseURL: string;
      model: string;
      /** Optional; falls back to `OPENAI_API_KEY` or `AI2NAO_LLM_API_KEY`. */
      apiKey?: string;
    }
  | {
      provider: "openai-compatible";
      /** Base URL including `/v1` when the server expects it (LM Studio, Ollama compat). */
      baseURL: string;
      model: string;
      /** Optional; falls back to `AI2NAO_LLM_API_KEY`, `OPENAI_API_KEY`, or a local placeholder. */
      apiKey?: string;
    }
  | {
      provider: "volcengine";
      /** 火山方舟。OpenAI 兼容,路径实测存在(2026-09-02:401 而非 404)。 */
      baseURL: string;
      model: string;
      /** Optional; falls back to `ARK_API_KEY` or `AI2NAO_LLM_API_KEY`. */
      apiKey?: string;
    }
  | {
      provider: "minimax";
      /** MiniMax。OpenAI 兼容,T0 实测 tool_calls 走标准字段。 */
      baseURL: string;
      model: string;
      /** Optional; falls back to `MINIMAX_API_KEY` or `AI2NAO_LLM_API_KEY`. */
      apiKey?: string;
    };

export type LlmChatStatus = {
  configured: boolean;
  provider: LlmChatProvider | null;
  model: string | null;
  /** Host only, for debugging (no path, no key). */
  baseHost: string | null;
  configPath: string;
  /** Where the config actually came from. Without this the UI would keep naming
   * llm-chat.json after migration renamed it — pointing the user at a file that
   * no longer exists. */
  source: "db" | "file" | null;
};

function configPathFromEnv(): string {
  const raw = (process.env.AI2NAO_LLM_CHAT_CONFIG ?? "").trim();
  return raw.length > 0 ? resolve(raw) : defaultLlmChatConfigPath();
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

function optionalTrimmedString(x: unknown): string | undefined {
  return typeof x === "string" && x.trim() ? x.trim() : undefined;
}

export function parseLlmChatConfigJson(raw: string): LlmChatConfig | null {
  let data: unknown;
  try {
    data = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
  if (!isRecord(data)) return null;
  const provider = data.provider;
  const baseURL = optionalTrimmedString(data.baseURL);
  const model = optionalTrimmedString(data.model);
  if (!model) return null;
  const apiKey = optionalTrimmedString(data.apiKey);
  if (!isLlmChatProvider(provider)) return null;
  // 表驱动,不是 if 链:加一家只改 LLM_CHAT_DEFAULT_BASE_URLS 一处。
  // 穷尽性由 model.ts 末尾的 `const _exhaustive: never = cfg` 兜底 ——
  // 加了 provider 却不写适配器分支,那里会编译报错。
  const resolvedBase = baseURL ?? LLM_CHAT_DEFAULT_BASE_URLS[provider];
  // openai-compatible 没有默认地址(空串),必须显式给,否则不知道往哪打。
  if (!resolvedBase) return null;
  return { provider, baseURL: resolvedBase, model, apiKey } as LlmChatConfig;
}

export function isLlmChatProvider(x: unknown): x is LlmChatProvider {
  return typeof x === "string" && x in LLM_CHAT_DEFAULT_BASE_URLS;
}

/**
 * Config source, in order: config.db → JSON file. (The API-key ENV fallback
 * lives downstream in model.ts as `cfg.apiKey || env`, so it is deliberately
 * NOT consulted here — moving it would silently change precedence.)
 */
/** 一条模型条目。`id` 一经保存不可编辑 —— 消息归属的快照里存着它。 */
export type LlmChatModelEntry = {
  id: string;
  label: string;
  provider: LlmChatProvider;
  model: string;
  baseURL: string;
  /** 指向 `keys` 里的某一把。悬空不阻止保存,只让该条目不可用。 */
  keyRef: string;
};

/** 多模型文档。秘密全部收在顶层 `keys` 一个对象里,浅层 omit 就能脱敏干净。 */
export type LlmChatMultiDocument = {
  defaultModelId: string | null;
  keys: Record<string, string>;
  models: LlmChatModelEntry[];
};

/** 库里可能存着两种形状:多模型文档,或者迁移前的单模型配置。 */
export type LlmChatStoredDocument = LlmChatMultiDocument | LlmChatConfig;

export function isMultiDocument(doc: LlmChatStoredDocument): doc is LlmChatMultiDocument {
  return Array.isArray((doc as LlmChatMultiDocument).models);
}

function parseModelEntry(x: unknown): LlmChatModelEntry | null {
  if (!isRecord(x)) return null;
  const id = optionalTrimmedString(x.id);
  const model = optionalTrimmedString(x.model);
  const keyRef = optionalTrimmedString(x.keyRef);
  const baseURL = optionalTrimmedString(x.baseURL);
  if (!id || !model || !keyRef) return null;
  if (!isLlmChatProvider(x.provider)) return null;
  const resolvedBase = baseURL ?? LLM_CHAT_DEFAULT_BASE_URLS[x.provider];
  if (!resolvedBase) return null;
  return {
    id,
    label: optionalTrimmedString(x.label) ?? model,
    provider: x.provider,
    model,
    baseURL: resolvedBase,
    keyRef,
  };
}

/**
 * **形状保持**的解析器,给写回路径用。
 *
 * `credentialApi.ts` 的 `patchCredential` 把本函数的**输出写回库**
 * (`setCredentialRaw(name, JSON.stringify(validated))`)。所以它绝不能塌缩成
 * 单条配置 —— 那样用户每次在设置页保存都会丢掉其余模型,而 tsc 不报、测试不红。
 * 「解析成可用配置」是 `resolveLlmChatConfig` 的活,两者语义相反,必须分开。
 */
export function parseLlmChatDocument(raw: string): LlmChatStoredDocument | null {
  let data: unknown;
  try {
    data = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
  if (!isRecord(data)) return null;

  // 只填了 key 还没建条目也算多模型文档,否则「先填 key 后建条目」这个顺序会丢数据。
  const looksMulti = Array.isArray(data.models) || isRecord(data.keys);
  if (!looksMulti) return parseLlmChatConfigJson(raw);

  const keys: Record<string, string> = {};
  if (isRecord(data.keys)) {
    for (const [k, v] of Object.entries(data.keys)) {
      if (typeof v === "string") keys[k] = v;
    }
  }

  const models: LlmChatModelEntry[] = [];
  const seen = new Set<string>();
  for (const raw of Array.isArray(data.models) ? data.models : []) {
    const entry = parseModelEntry(raw);
    // 一条坏条目让整份文档非法,而不是被静默丢掉 —— 静默丢会让用户
    // 「保存成功但那条没了」,是本设计一路在躲的那类失败。
    if (!entry) return null;
    // 重复 id 会让解析结果取决于数组遍历顺序,且复用 id 会篡改历史消息归属。
    if (seen.has(entry.id)) return null;
    seen.add(entry.id);
    models.push(entry);
  }

  const defaultModelId = optionalTrimmedString(data.defaultModelId) ?? null;
  return { defaultModelId, keys, models };
}

/**
 * **塌缩**成今天的 `LlmChatConfig`,给 6 个下游消费者用
 * (每日摘要 / RAG 兜底 / 工作回顾 ×2 / 话题簇命名 / serve)。
 * 它们的行为必须一字不变,所以这里返回的形状与迁移前逐字段相同。
 */
export function resolveLlmChatConfig(doc: LlmChatStoredDocument): LlmChatConfig | null {
  if (!isMultiDocument(doc)) return doc;
  if (doc.models.length === 0) return null;
  // defaultModelId 悬空(条目被删、手改配置、并发)时回落首条。
  // 这与「用户选中的模型不可用要报错」不冲突:那里有用户意图可违背,这里没有。
  const entry = doc.models.find((m) => m.id === doc.defaultModelId) ?? doc.models[0];
  const apiKey = doc.keys[entry.keyRef]?.trim() || undefined;
  return {
    provider: entry.provider,
    baseURL: entry.baseURL,
    model: entry.model,
    apiKey,
  } as LlmChatConfig;
}

/** 给 picker 与设置页的视图。**绝不含密钥**,只有来源分类。 */
export type LlmChatModelView = {
  id: string;
  label: string;
  provider: LlmChatProvider;
  model: string;
  baseURL: string;
  available: boolean;
  credentialSource: CredentialSource;
};

/**
 * 可用性判定复用 `apiKeySource.ts` 的解析顺序,不另起一套。
 *
 * 单纯的 `Boolean(keys[keyRef])` 会误禁两种合法情况:靠 `DEEPSEEK_API_KEY`
 * 这类环境变量拿 key 的,以及本地 `openai-compatible` 端点(LM Studio / Ollama
 * 压根不需要 key)。
 */
export function listModelsFromDocument(
  doc: LlmChatStoredDocument,
  env: NodeJS.ProcessEnv = process.env
): LlmChatModelView[] {
  const entries: LlmChatModelEntry[] = isMultiDocument(doc)
    ? doc.models
    : // 旧格式合成一条稳定条目,否则老用户升级后「已配置」而 picker 是空的。
      [
        {
          id: LEGACY_MODEL_ID,
          label: `${doc.provider} · ${doc.model}`,
          provider: doc.provider,
          model: doc.model,
          baseURL: doc.baseURL,
          keyRef: LEGACY_MODEL_ID,
        },
      ];
  const keys = isMultiDocument(doc)
    ? doc.keys
    : { [LEGACY_MODEL_ID]: doc.apiKey ?? "" };

  return entries.map((e) => {
    const { source } = resolveApiKeySource({ provider: e.provider, apiKey: keys[e.keyRef] }, env);
    const credentialSource = credentialSourceOf(source);
    return {
      id: e.id,
      label: e.label,
      provider: e.provider,
      model: e.model,
      baseURL: e.baseURL,
      available: credentialSource !== "none",
      credentialSource,
    };
  });
}

/** 旧单模型配置被合成出来的条目 id。前端不应该依赖这个字面量,只当普通 id 用。 */
export const LEGACY_MODEL_ID = "legacy";

/**
 * 读出库里存着的文档。来源顺序:config.db → JSON 文件。
 * (API-key 的 ENV 兜底在下游 `model.ts` 里,不在这里 —— 挪上来会悄悄改变优先级。)
 */
export function readLlmChatDocument(): LlmChatStoredDocument | null {
  const stored = getCredentialRaw("llm-chat");
  if (stored) {
    const doc = parseLlmChatDocument(stored);
    if (doc) {
      llmChatLog.debug("config loaded from config.db", {
        multi: isMultiDocument(doc),
        models: isMultiDocument(doc) ? doc.models.length : 1,
      });
      return doc;
    }
    llmChatLog.warn("config.db holds an invalid llm-chat value; falling back to file");
  }
  const path = configPathFromEnv();
  if (!existsSync(path)) {
    llmChatLog.debug("config file missing", path);
    return null;
  }
  try {
    const raw = readFileSync(path, "utf8");
    const doc = parseLlmChatDocument(raw);
    if (!doc) {
      llmChatLog.warn("config file present but invalid JSON shape", path);
      return null;
    }
    llmChatLog.debug("config loaded", { path, multi: isMultiDocument(doc) });
    return doc;
  } catch (e) {
    llmChatLog.warn("config read failed", path, e instanceof Error ? e.message : String(e));
    return null;
  }
}

export function readLlmChatConfig(): LlmChatConfig | null {
  const doc = readLlmChatDocument();
  return doc ? resolveLlmChatConfig(doc) : null;
}

/** picker 与设置页的模型清单。库里没配置时返回空数组,不是抛。 */
export function listLlmChatModels(): LlmChatModelView[] {
  const doc = readLlmChatDocument();
  return doc ? listModelsFromDocument(doc) : [];
}

function baseHostFromUrl(baseURL: string): string | null {
  try {
    const u = new URL(baseURL);
    return u.host || null;
  } catch {
    return null;
  }
}

export function llmChatStatus(): LlmChatStatus {
  const configPath = configPathFromEnv();
  const cfg = readLlmChatConfig();
  if (!cfg) {
    return {
      configured: false,
      provider: null,
      model: null,
      baseHost: null,
      configPath,
      source: null,
    };
  }
  const stored = getCredentialRaw("llm-chat");
  return {
    configured: true,
    provider: cfg.provider,
    model: cfg.model,
    baseHost: baseHostFromUrl(cfg.baseURL),
    configPath,
    source: stored && parseLlmChatConfigJson(stored) ? "db" : "file",
  };
}
