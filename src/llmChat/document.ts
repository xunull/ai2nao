/**
 * llm-chat 配置文档的**形状与解析**。纯函数,零 I/O。
 *
 * 这里没有任何 llmChat 内部 import —— provider 联合类型、默认地址表、
 * `LEGACY_MODEL_ID` 全都住在这里,而不是留在 `config.ts`。
 *
 * **这个位置是有意的。** 解析需要地址表,而 `config.ts` 的读取管道需要解析;
 * 把地址表留在 `config.ts` 会让 `config.ts ⇄ document.ts` 在**运行期**双向依赖,
 * 而 `LLM_CHAT_PROVIDERS` 是模块顶层 `Object.keys(...)` 求值,成环时直接 TDZ。
 * (`apiKeySource.ts` 反向只有 type-only import,编译后擦除,不算依赖。)
 */

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

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

function optionalTrimmedString(x: unknown): string | undefined {
  return typeof x === "string" && x.trim() ? x.trim() : undefined;
}

export function isLlmChatProvider(x: unknown): x is LlmChatProvider {
  return typeof x === "string" && x in LLM_CHAT_DEFAULT_BASE_URLS;
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

/** 旧单模型配置被合成出来的条目 id。前端不应该依赖这个字面量,只当普通 id 用。 */
export const LEGACY_MODEL_ID = "legacy";

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
 * 把两种存储形状归到同一对 `(entries, keys)`。
 * 旧格式合成一条稳定条目 —— 否则老用户升级后「已配置」而 picker 是空的。
 * 抽出来是因为 listModelsFromDocument 与 selectModelForTurn 都要它,
 * 各抄一份就会出现「picker 里有、选中却说找不到」。
 */
export function documentEntries(doc: LlmChatStoredDocument): {
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
