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

/** 设置页「服务商」下拉的选项。前端不再自己维护清单,只维护 id → 中文标签。 */
export type LlmChatProviderOption = { id: LlmChatProvider; defaultBaseURL: string };

export type LlmChatStatus = {
  configured: boolean;
  /** 单数字段保留,含义是**默认那个** —— 老消费者不用改。 */
  provider: LlmChatProvider | null;
  model: string | null;
  /** 实际生效的默认模型 id。默认项悬空时这里是真正会被用的那个,不是那个死 id。 */
  defaultModelId: string | null;
  /** picker 的数据源。绝不含密钥,只有 available / credentialSource。 */
  models: LlmChatModelView[];
  /** 与 LlmChatProvider 联合类型同源;加一家前端自动看见,不用改硬编码清单。 */
  availableProviders: LlmChatProviderOption[];
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

  // 从旧格式升级时的一次性搬运。设置页第一次保存多模型配置只 PATCH
  // {defaultModelId, keys, models},而 mergePatch 保留未发送的字段 ——
  // 合并结果里于是同时有旧的顶层 apiKey 和新的 models。若在这里无视它,
  // 用户存一次就把已有的 key 弄丢了:静默、不可逆,要等下次对话报 401 才发现。
  const legacyKey = optionalTrimmedString(data.apiKey);
  if (legacyKey && !keys[LEGACY_MODEL_ID]) keys[LEGACY_MODEL_ID] = legacyKey;

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
/**
 * 把两种存储形状归到同一对 `(entries, keys)`。
 * 旧格式合成一条稳定条目 —— 否则老用户升级后「已配置」而 picker 是空的。
 * 抽出来是因为 listModelsFromDocument 与 selectModelForTurn 都要它,
 * 各抄一份就会出现「picker 里有、选中却说找不到」。
 */
function documentEntries(doc: LlmChatStoredDocument): {
  entries: LlmChatModelEntry[];
  keys: Record<string, string>;
  defaultModelId: string | null;
} {
  if (isMultiDocument(doc)) {
    return { entries: doc.models, keys: doc.keys, defaultModelId: doc.defaultModelId };
  }
  return {
    entries: [
      {
        id: LEGACY_MODEL_ID,
        label: `${doc.provider} · ${doc.model}`,
        provider: doc.provider,
        model: doc.model,
        baseURL: doc.baseURL,
        keyRef: LEGACY_MODEL_ID,
      },
    ],
    keys: { [LEGACY_MODEL_ID]: doc.apiKey ?? "" },
    defaultModelId: LEGACY_MODEL_ID,
  };
}

export function listModelsFromDocument(
  doc: LlmChatStoredDocument,
  env: NodeJS.ProcessEnv = process.env
): LlmChatModelView[] {
  const { entries, keys } = documentEntries(doc);

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
 * 盖在每条 assistant 消息上的**不可变快照**。
 *
 * 只存 modelId 不够:条目可改名、可删、id 可被复用,半年后回看会把老消息
 * 标成新配置 —— 那是篡改历史。provider/model/label 三项当时是什么就永远是什么。
 */
export type LlmChatModelSnapshot = {
  modelId: string;
  provider: LlmChatProvider;
  model: string;
  label: string;
};

export type ModelSelection =
  | { ok: true; config: LlmChatConfig; snapshot: LlmChatModelSnapshot }
  | {
      ok: false;
      reason: "not-configured" | "unknown-model" | "unavailable";
      message: string;
    };

/**
 * 选出这一轮真正要用的模型。
 *
 * **不可用时报错,绝不静默回落默认家。** 用户明确点了 Kimi,系统却把内容发给
 * DeepSeek —— 费用、数据去向、以及「我以为在用 A」的误判全都错。这与
 * `resolveLlmChatConfig` 对 defaultModelId 悬空时回落 models[0] 不冲突:
 * 那里服务的是 4 个后台消费者,没有「用户刚点了谁」这个意图可违背。
 *
 * 可用性判定与 picker 走同一个 `resolveApiKeySource`,否则会出现
 * 「界面能选、发出去报错」或反过来的分歧。
 */
export function selectModelForTurn(
  doc: LlmChatStoredDocument | null,
  modelId: string | null,
  env: NodeJS.ProcessEnv = process.env
): ModelSelection {
  if (!doc) {
    return {
      ok: false,
      reason: "not-configured",
      message: "尚未配置任何 AI 对话模型。请到「设置 → AI 与模型」添加一个。",
    };
  }
  const { entries, keys, defaultModelId } = documentEntries(doc);
  if (entries.length === 0) {
    return {
      ok: false,
      reason: "not-configured",
      message: "模型列表为空。请到「设置 → AI 与模型」添加一个。",
    };
  }

  const wanted = modelId
    ? entries.find((e) => e.id === modelId)
    : (entries.find((e) => e.id === defaultModelId) ?? entries[0]);

  if (!wanted) {
    return {
      ok: false,
      reason: "unknown-model",
      message: `选中的模型不存在(id: ${modelId})。它可能已被删除,请重新选择。`,
    };
  }

  const { source } = resolveApiKeySource(
    { provider: wanted.provider, apiKey: keys[wanted.keyRef] },
    env
  );
  if (credentialSourceOf(source) === "none") {
    return {
      ok: false,
      reason: "unavailable",
      message: `模型「${wanted.label}」不可用:尚未配置 ${wanted.provider} 的 API key。`,
    };
  }

  return {
    ok: true,
    config: {
      provider: wanted.provider,
      baseURL: wanted.baseURL,
      model: wanted.model,
      // 这里给回原始的 config key(可能是 undefined);env 兜底留给 model.ts,
      // 挪上来会让「key 从哪来」的优先级悄悄变成两套。
      apiKey: keys[wanted.keyRef]?.trim() || undefined,
    } as LlmChatConfig,
    snapshot: {
      modelId: wanted.id,
      provider: wanted.provider,
      model: wanted.model,
      label: wanted.label,
    },
  };
}

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

export function availableProviderList(): LlmChatProviderOption[] {
  return LLM_CHAT_PROVIDERS.map((id) => ({
    id,
    defaultBaseURL: LLM_CHAT_DEFAULT_BASE_URLS[id],
  }));
}

/**
 * status 里与模型有关的两个字段。
 *
 * `defaultModelId` 报的是**真正会被用的那个**:默认项悬空时回落 models[0],
 * 与 `resolveLlmChatConfig` 的口径一致。若照抄那个死 id,页面顶部的药丸就会
 * 指向一个不存在的模型 —— 界面说谎正是 1B 要修的东西。
 */
export function statusModelFields(
  doc: LlmChatStoredDocument,
  env: NodeJS.ProcessEnv = process.env
): { defaultModelId: string | null; models: LlmChatModelView[] } {
  const models = listModelsFromDocument(doc, env);
  if (models.length === 0) return { defaultModelId: null, models: [] };
  const { defaultModelId } = documentEntries(doc);
  const resolved = models.find((m) => m.id === defaultModelId)?.id ?? models[0].id;
  return { defaultModelId: resolved, models };
}

export function llmChatStatus(): LlmChatStatus {
  const configPath = configPathFromEnv();
  // 只读一次文档:两次读会让「刚保存完」这一瞬间的 cfg 与 models 来自不同快照。
  const doc = readLlmChatDocument();
  const cfg = doc ? resolveLlmChatConfig(doc) : null;
  // availableProviders 在「什么都没配」时也要给 —— 否则设置页连服务商下拉都是空的,
  // 用户第一次进来就没法添加任何模型。
  const availableProviders = availableProviderList();
  if (!cfg || !doc) {
    return {
      configured: false,
      provider: null,
      model: null,
      defaultModelId: null,
      models: [],
      availableProviders,
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
    ...statusModelFields(doc),
    availableProviders,
    baseHost: baseHostFromUrl(cfg.baseURL),
    configPath,
    source: stored && parseLlmChatDocument(stored) ? "db" : "file",
  };
}
