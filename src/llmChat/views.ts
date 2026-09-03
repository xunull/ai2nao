/**
 * 从配置文档派生出**给界面和运行路径看的视图**。纯函数,零 I/O。
 *
 * 依赖方向单向:views → document / apiKeySource。绝不反向 import `config.ts`
 * (那是读取管道那一层),否则就成环。
 */
import {
  credentialSourceOf,
  resolveApiKeySource,
  type CredentialSource,
} from "./apiKeySource.js";
import {
  documentEntries,
  LLM_CHAT_DEFAULT_BASE_URLS,
  LLM_CHAT_PROVIDERS,
  type LlmChatConfig,
  type LlmChatProvider,
  type LlmChatStoredDocument,
} from "./document.js";

/** 设置页「服务商」下拉的选项。前端不再自己维护清单,只维护 id → 中文标签。 */
export type LlmChatProviderOption = { id: LlmChatProvider; defaultBaseURL: string };

export function availableProviderList(): LlmChatProviderOption[] {
  return LLM_CHAT_PROVIDERS.map((id) => ({
    id,
    defaultBaseURL: LLM_CHAT_DEFAULT_BASE_URLS[id],
  }));
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
