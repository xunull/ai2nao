/**
 * llm-chat 配置的**读取管道**:从 config.db / JSON 文件把文档取出来,
 * 塌缩给 6 个后台消费者,并组装 status。
 *
 * 形状与解析在 `document.ts`,视图与选择在 `views.ts`。
 * 依赖方向单向:config → views → document。
 *
 * 本文件末尾 re-export 了 document/views 的公开符号,**这不是环** ——
 * 那两个模块从不反向 import 本文件。re-export 的目的只是让既有的
 * `from "./config.js"` 调用点不必改动(S0 是纯搬家)。
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { defaultLlmChatConfigPath } from "../config.js";
import { getCredentialRaw } from "../settings/store.js";
import {
  isMultiDocument,
  parseLlmChatDocument,
  type LlmChatConfig,
  type LlmChatProvider,
  type LlmChatStoredDocument,
} from "./document.js";
import {
  availableProviderList,
  statusModelFields,
  listModelsFromDocument,
  type LlmChatModelView,
  type LlmChatProviderOption,
} from "./views.js";
import { llmChatLog } from "./log.js";

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

function baseHostFromUrl(baseURL: string): string | null {
  try {
    const u = new URL(baseURL);
    return u.host || null;
  } catch {
    return null;
  }
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

// ---------------------------------------------------------------------------
// 向后兼容的 re-export。document/views 从不反向 import 本文件,所以这不是环。
// 存在的唯一理由是让 S0 保持「纯搬家」:既有的 `from "./config.js"` 一处不用改。
// ---------------------------------------------------------------------------
export {
  documentEntries,
  isLlmChatProvider,
  isMultiDocument,
  LEGACY_MODEL_ID,
  LLM_CHAT_DEFAULT_BASE_URLS,
  LLM_CHAT_PROVIDERS,
  parseLlmChatConfigJson,
  parseLlmChatDocument,
} from "./document.js";
export type {
  LlmChatConfig,
  LlmChatModelEntry,
  LlmChatMultiDocument,
  LlmChatProvider,
  LlmChatStoredDocument,
} from "./document.js";
export {
  availableProviderList,
  listModelsFromDocument,
  selectModelForTurn,
  statusModelFields,
} from "./views.js";
export type {
  LlmChatModelSnapshot,
  LlmChatModelView,
  LlmChatProviderOption,
  ModelSelection,
} from "./views.js";
