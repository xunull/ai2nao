/**
 * 从配置文档派生出**给界面和运行路径看的视图**。纯函数,零 I/O。
 *
 * 依赖方向单向:views → document / apiKeySource。绝不反向 import `config.ts`。
 */
import {
  credentialSourceOf,
  resolveApiKeySource,
  type CredentialSource,
} from "./apiKeySource.js";
import {
  decodeModelViewId,
  encodeModelViewId,
  LLM_CHAT_DEFAULT_BASE_URLS,
  LLM_CHAT_PROVIDERS,
  type LlmChatConfig,
  type LlmChatDocument,
  type LlmChatProvider,
  type LlmChatProviderInstance,
} from "./document.js";

/** 设置页「服务商」下拉的选项。前端不再自己维护清单,只维护 id → 中文标签。 */
export type LlmChatProviderOption = { id: LlmChatProvider; defaultBaseURL: string };

export function availableProviderList(): LlmChatProviderOption[] {
  return LLM_CHAT_PROVIDERS.map((id) => ({
    id,
    defaultBaseURL: LLM_CHAT_DEFAULT_BASE_URLS[id],
  }));
}

function credentialOf(
  inst: LlmChatProviderInstance,
  env: NodeJS.ProcessEnv
): CredentialSource {
  const { source } = resolveApiKeySource({ provider: inst.provider, apiKey: inst.apiKey }, env);
  return credentialSourceOf(source);
}

/**
 * **厂商列的数据源。** 与 `listModelsFromDocument` 是两件事:
 * 那个按模型逐条展开,一个刚添加、刚粘上 key、还没选模型的实例在它里面是 0 行,
 * 于是在左栏里根本不存在 —— 而那正是配置一家新厂商必然经过的那一秒。
 * 这里**返回全部实例,含 0 模型的和已关闭的**。
 */
export type LlmChatProviderView = {
  id: string;
  label: string;
  provider: LlmChatProvider;
  baseURL: string;
  enabled: boolean;
  credentialSource: CredentialSource;
  modelCount: number;
};

export function listProvidersFromDocument(
  doc: LlmChatDocument,
  env: NodeJS.ProcessEnv = process.env
): LlmChatProviderView[] {
  return Object.entries(doc.providers).map(([id, inst]) => ({
    id,
    label: inst.label,
    provider: inst.provider,
    baseURL: inst.baseURL,
    enabled: inst.enabled,
    credentialSource: credentialOf(inst, env),
    modelCount: inst.models.length,
  }));
}

/** 给 picker 的扁平视图。**绝不含密钥**,只有来源分类。 */
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
 * 可用性判定复用 `apiKeySource.ts` 的解析顺序,不另起一套 ——
 * 单纯的 `Boolean(apiKey)` 会误禁靠环境变量拿 key 的、以及本地无需 key 的端点。
 *
 * **已关闭的实例整个不出现**,而不是置灰:关开关的意图是「别用这家」,
 * 与「配置不全」是两回事(后者才置灰并写明原因)。
 */
export function listModelsFromDocument(
  doc: LlmChatDocument,
  env: NodeJS.ProcessEnv = process.env
): LlmChatModelView[] {
  const out: LlmChatModelView[] = [];
  for (const [providerId, inst] of Object.entries(doc.providers)) {
    if (!inst.enabled) continue;
    const credentialSource = credentialOf(inst, env);
    for (const ref of inst.models) {
      out.push({
        id: encodeModelViewId(providerId, ref.model),
        label: ref.label,
        provider: inst.provider,
        model: ref.model,
        baseURL: inst.baseURL,
        available: credentialSource !== "none",
        credentialSource,
      });
    }
  }
  return out;
}

/**
 * 盖在每条 assistant 消息上的**不可变快照**。
 *
 * 只存 modelId 不够:实例可改名、可删、id 可被复用,半年后回看会把老消息
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
      reason: "not-configured" | "unknown-model" | "unavailable" | "disabled";
      message: string;
    };

/** 默认项:显式指定的那个,否则第一个「启用且有模型」的实例的第一条。 */
export function resolveDefaultTarget(
  doc: LlmChatDocument
): { providerId: string; model: string } | null {
  if (doc.defaultModel) {
    const inst = doc.providers[doc.defaultModel.providerId];
    if (inst?.enabled && inst.models.some((m) => m.model === doc.defaultModel!.model)) {
      return doc.defaultModel;
    }
  }
  for (const [providerId, inst] of Object.entries(doc.providers)) {
    if (!inst.enabled || inst.models.length === 0) continue;
    return { providerId, model: inst.models[0].model };
  }
  return null;
}

/**
 * 选出这一轮真正要用的模型。
 *
 * **不可用时报错,绝不静默回落默认家。** 用户明确点了 Kimi,系统却把内容发给
 * DeepSeek —— 费用、数据去向、以及「我以为在用 A」的误判全都错。
 *
 * `enabled: false` 在这里也必须被拒 —— 运行路径不经过 `listModelsFromDocument`,
 * `forwardedProps` 原样透传 modelId,只测视图函数等于没测。
 */
export function selectModelForTurn(
  doc: LlmChatDocument | null,
  modelId: string | null,
  env: NodeJS.ProcessEnv = process.env
): ModelSelection {
  if (!doc || Object.keys(doc.providers).length === 0) {
    return {
      ok: false,
      reason: "not-configured",
      message: "尚未配置任何 AI 对话模型。请到「设置 → AI 与模型」添加一个。",
    };
  }

  const target = modelId ? decodeModelViewId(modelId) : resolveDefaultTarget(doc);
  if (!target) {
    return {
      ok: false,
      reason: modelId ? "unknown-model" : "not-configured",
      message: modelId
        ? `选中的模型无法识别(id: ${modelId})。请重新选择。`
        : "没有可用的默认模型。请到「设置 → AI 与模型」指定一个。",
    };
  }

  const inst = doc.providers[target.providerId];
  const ref = inst?.models.find((m) => m.model === target.model);
  if (!inst || !ref) {
    return {
      ok: false,
      reason: "unknown-model",
      message: `选中的模型不存在(${target.providerId} / ${target.model})。它可能已被删除,请重新选择。`,
    };
  }

  if (!inst.enabled) {
    return {
      ok: false,
      reason: "disabled",
      message: `服务商「${inst.label}」已关闭,其下的模型不可用。到「设置 → AI 与模型」重新启用。`,
    };
  }

  if (credentialOf(inst, env) === "none") {
    return {
      ok: false,
      reason: "unavailable",
      message: `模型「${ref.label}」不可用:尚未配置 ${inst.provider} 的 API key。`,
    };
  }

  return {
    ok: true,
    config: {
      provider: inst.provider,
      baseURL: inst.baseURL,
      model: ref.model,
      // 原始的 config key(可能是 undefined);env 兜底留给 model.ts,
      // 挪上来会让「key 从哪来」的优先级悄悄变成两套。
      apiKey: inst.apiKey,
    },
    snapshot: {
      modelId: encodeModelViewId(target.providerId, ref.model),
      provider: inst.provider,
      model: ref.model,
      label: ref.label,
    },
  };
}

/**
 * status 里与模型有关的字段。
 *
 * `defaultModelId` 报的是**真正会被用的那个**(含默认失效时的回落),
 * 否则页面顶部的药丸会指向一个不存在的模型 —— 界面说谎正是要修的东西。
 */
export function statusModelFields(
  doc: LlmChatDocument,
  env: NodeJS.ProcessEnv = process.env
): {
  defaultModelId: string | null;
  models: LlmChatModelView[];
  providers: LlmChatProviderView[];
  /** 默认模型所在的实例被关掉了 —— 后台四个功能会停,页面要显式报出来。 */
  defaultDisabled: boolean;
} {
  const models = listModelsFromDocument(doc, env);
  const providers = listProvidersFromDocument(doc, env);
  const target = resolveDefaultTarget(doc);
  const explicit = doc.defaultModel;
  const defaultDisabled = Boolean(
    explicit && doc.providers[explicit.providerId] && !doc.providers[explicit.providerId].enabled
  );
  return {
    defaultModelId: target ? encodeModelViewId(target.providerId, target.model) : null,
    models,
    providers,
    defaultDisabled,
  };
}
