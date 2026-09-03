/**
 * llm-chat 配置文档的**形状、解析与归一**。纯函数,零 I/O。
 *
 * 这里没有任何 llmChat 内部 import —— provider 联合类型、默认地址表全都住在这里,
 * 而不是留在 `config.ts`。解析需要地址表,而 `config.ts` 的读取管道需要解析;
 * 把地址表留在 `config.ts` 会让两者在**运行期**双向依赖,而 `LLM_CHAT_PROVIDERS`
 * 是模块顶层 `Object.keys(...)` 求值,成环时直接 TDZ。
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
 * 每家的默认 base URL。设置页选服务商时预填这个值,解析在缺省时也用它 ——
 * 两处必须同源,否则「界面显示的地址」与「真正打出去的地址」会分叉。
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

/** 运行期真正交给 AI SDK 的那一份。6 个后台消费者拿到的也是它。 */
export type LlmChatConfig = {
  provider: LlmChatProvider;
  baseURL: string;
  model: string;
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

/** 迁移前的单模型配置。只在解析入口出现,不再是运行期形状。 */
export function parseLlmChatConfigJson(raw: string): LlmChatConfig | null {
  let data: unknown;
  try {
    data = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
  if (!isRecord(data)) return null;
  const model = optionalTrimmedString(data.model);
  if (!model) return null;
  if (!isLlmChatProvider(data.provider)) return null;
  const baseURL = optionalTrimmedString(data.baseURL) ?? LLM_CHAT_DEFAULT_BASE_URLS[data.provider];
  if (!baseURL) return null;
  return { provider: data.provider, baseURL, model, apiKey: optionalTrimmedString(data.apiKey) };
}

// ---------------------------------------------------------------------------
// 新形状:厂商为一等公民
// ---------------------------------------------------------------------------

/** 一个厂商实例底下的一条模型。`label` 是用户可编辑的显示名。 */
export type LlmChatModelRef = { model: string; label: string };

/**
 * 一个**厂商实例**。map 的键是实例 id(自由字符串,但不含冒号),
 * `provider` 是适配器 id —— 两者分开,是为了让「同一家两个端点」可表达
 * (官方 + 代理 = 两个实例,同一个 provider)。
 */
export type LlmChatProviderInstance = {
  provider: LlmChatProvider;
  label: string;
  baseURL: string;
  apiKey?: string;
  enabled: boolean;
  models: LlmChatModelRef[];
};

export type LlmChatDocument = {
  /** 结构化,不是 `"实例:模型"` 拼接串 —— 实例 id 自由,拼接不可逆。 */
  defaultModel: { providerId: string; model: string } | null;
  providers: Record<string, LlmChatProviderInstance>;
};

const VIEW_ID_SEP = ":";

/**
 * picker 与 `forwardedProps.modelId` 走的是字符串,所以要把 (实例, 模型) 编码成一个。
 * **按第一个冒号切** —— 实例 id 保证不含冒号(解析时消毒),而模型名可以含
 * (ollama 的 `qwen:7b`)。
 */
export function encodeModelViewId(providerId: string, model: string): string {
  return `${providerId}${VIEW_ID_SEP}${model}`;
}

export function decodeModelViewId(
  id: string
): { providerId: string; model: string } | null {
  const i = id.indexOf(VIEW_ID_SEP);
  if (i <= 0 || i === id.length - 1) return null;
  return { providerId: id.slice(0, i), model: id.slice(i + 1) };
}

function parseModelRefs(x: unknown): LlmChatModelRef[] {
  if (!Array.isArray(x)) return [];
  const out: LlmChatModelRef[] = [];
  const seen = new Set<string>();
  for (const item of x) {
    // 字符串形式也收 —— 手改配置时最容易写成 ["m1","m2"]。
    const model =
      typeof item === "string"
        ? optionalTrimmedString(item)
        : isRecord(item)
          ? optionalTrimmedString(item.model)
          : undefined;
    // 一条坏模型只跳过它自己。整条实例作废会让它的密钥一起没,而 parse 的输出
    // 会被写回库 —— 严格失败在这条管道上是破坏装置,不是保护。
    if (!model || seen.has(model)) continue;
    seen.add(model);
    const label = isRecord(item) ? optionalTrimmedString(item.label) : undefined;
    out.push({ model, label: label ?? model });
  }
  return out;
}

/** 实例 id 不能含冒号(否则视图 id 不可逆)。消毒而不是拒绝 —— 拒绝会丢密钥。 */
function sanitizeInstanceId(raw: string, taken: Set<string>): string {
  const base = raw.split(VIEW_ID_SEP).join("_").trim() || "provider";
  if (!taken.has(base)) return base;
  for (let i = 2; ; i += 1) {
    const candidate = `${base}-${i}`;
    if (!taken.has(candidate)) return candidate;
  }
}

function emptyDocument(): LlmChatDocument {
  return { defaultModel: null, providers: {} };
}

/**
 * 默认项必须指向真实存在的模型,否则置 null。
 * **不因为它失效就让整份文档作废** —— 见 parseModelRefs 上面那段。
 */
function validateDefault(
  doc: LlmChatDocument,
  want: { providerId: string; model: string } | null
): LlmChatDocument["defaultModel"] {
  if (!want) return null;
  const inst = doc.providers[want.providerId];
  if (!inst) return null;
  return inst.models.some((m) => m.model === want.model) ? want : null;
}

function parseProvidersShape(data: Record<string, unknown>): LlmChatDocument {
  const doc = emptyDocument();
  const taken = new Set<string>();
  const rename = new Map<string, string>();
  const raw = isRecord(data.providers) ? data.providers : {};
  for (const [rawId, val] of Object.entries(raw)) {
    if (!isRecord(val)) continue;
    // provider 不合法就跳过这个实例(它的密钥也跟着走);保留其余,别让一条坏的清库。
    if (!isLlmChatProvider(val.provider)) continue;
    const id = sanitizeInstanceId(rawId, taken);
    taken.add(id);
    if (id !== rawId) rename.set(rawId, id);
    doc.providers[id] = {
      provider: val.provider,
      label: optionalTrimmedString(val.label) ?? val.provider,
      baseURL: optionalTrimmedString(val.baseURL) ?? LLM_CHAT_DEFAULT_BASE_URLS[val.provider],
      apiKey: optionalTrimmedString(val.apiKey),
      enabled: val.enabled !== false,
      models: parseModelRefs(val.models),
    };
  }
  const wantRaw = isRecord(data.defaultModel) ? data.defaultModel : null;
  const wantId = wantRaw ? optionalTrimmedString(wantRaw.providerId) : undefined;
  const wantModel = wantRaw ? optionalTrimmedString(wantRaw.model) : undefined;
  doc.defaultModel = validateDefault(
    doc,
    wantId && wantModel ? { providerId: rename.get(wantId) ?? wantId, model: wantModel } : null
  );
  return doc;
}

/** 迁移前的扁平条目。只在迁移路径出现。 */
type FlatEntry = {
  id: string;
  label: string;
  provider: LlmChatProvider;
  model: string;
  baseURL: string;
  keyRef: string;
};

function parseFlatEntry(x: unknown): FlatEntry | null {
  if (!isRecord(x)) return null;
  const id = optionalTrimmedString(x.id);
  const model = optionalTrimmedString(x.model);
  const keyRef = optionalTrimmedString(x.keyRef);
  if (!id || !model || !keyRef) return null;
  if (!isLlmChatProvider(x.provider)) return null;
  const baseURL = optionalTrimmedString(x.baseURL) ?? LLM_CHAT_DEFAULT_BASE_URLS[x.provider];
  return { id, label: optionalTrimmedString(x.label) ?? model, provider: x.provider, model, baseURL, keyRef };
}

/**
 * 扁平 `models[]` + `keys{}` → providers{}。
 *
 * **分组基准是 (keyRef, baseURL) 而不是 keyRef**:同一把 key 打两个地址
 * (官方 + 代理)是合法配置,只按 keyRef 分组会把它们静默合成一个、丢掉一个地址。
 *
 * **孤儿 key 单独补实例**:`keys` 里有、却没有任何模型引用的那些,以 models[] 为
 * 基准就会整把丢掉 —— 而现有 parse 明确支持「只填了 key 还没建条目」这个中间态。
 */
function migrateFlat(data: Record<string, unknown>): LlmChatDocument {
  const keys: Record<string, string> = {};
  if (isRecord(data.keys)) {
    for (const [k, v] of Object.entries(data.keys)) {
      if (typeof v === "string" && v.trim()) keys[k] = v.trim();
    }
  }
  // 旧单模型的顶层 apiKey 也可能被 mergePatch 带进来,归到 legacy 槽位。
  const topLevelKey = optionalTrimmedString(data.apiKey);
  if (topLevelKey && !keys.legacy) keys.legacy = topLevelKey;

  const doc = emptyDocument();
  const taken = new Set<string>();
  /** (keyRef + baseURL) → 实例 id */
  const groupToId = new Map<string, string>();
  /** 扁平条目 id → (实例 id, 模型名),用来翻译 defaultModelId */
  const entryToTarget = new Map<string, { providerId: string; model: string }>();

  for (const rawEntry of Array.isArray(data.models) ? data.models : []) {
    const e = parseFlatEntry(rawEntry);
    if (!e) continue;
    const groupKey = `${e.keyRef} ${e.baseURL}`;
    let id = groupToId.get(groupKey);
    if (!id) {
      id = sanitizeInstanceId(e.keyRef, taken);
      taken.add(id);
      groupToId.set(groupKey, id);
      doc.providers[id] = {
        provider: e.provider,
        // **标签用 provider 而不是 keyRef。** 老库里的槽位可能叫 `legacy`
        // (旧单模型迁移时的占位名),直接拿它当显示名,左栏就会出现一个
        // 名叫「legacy」的服务商 —— 没人知道那是哪家。provider 前端认得,
        // 会映射成中文;实例 id 仍保留 keyRef,内部引用不受影响。
        label: e.provider,
        baseURL: e.baseURL,
        apiKey: keys[e.keyRef],
        enabled: true,
        models: [],
      };
    }
    const inst = doc.providers[id];
    if (!inst.models.some((m) => m.model === e.model)) {
      inst.models.push({ model: e.model, label: e.label });
    }
    entryToTarget.set(e.id, { providerId: id, model: e.model });
  }

  // 孤儿 key:没有任何模型引用它。provider 猜不出来时落 openai-compatible ——
  // 界面上会显示成一个待修的实例,但密钥一把都不丢。
  for (const [keyRef, secret] of Object.entries(keys)) {
    const referenced = [...groupToId.keys()].some((g) => g.split(" ")[0] === keyRef);
    if (referenced) continue;
    const provider: LlmChatProvider = isLlmChatProvider(keyRef) ? keyRef : "openai-compatible";
    const id = sanitizeInstanceId(keyRef, taken);
    taken.add(id);
    doc.providers[id] = {
      provider,
      label: provider,
      baseURL: LLM_CHAT_DEFAULT_BASE_URLS[provider],
      apiKey: secret,
      enabled: true,
      models: [],
    };
  }

  const oldDefault = optionalTrimmedString(data.defaultModelId);
  doc.defaultModel = validateDefault(doc, oldDefault ? (entryToTarget.get(oldDefault) ?? null) : null);
  return doc;
}

function migrateLegacy(cfg: LlmChatConfig): LlmChatDocument {
  const doc = emptyDocument();
  const id = sanitizeInstanceId(cfg.provider, new Set());
  doc.providers[id] = {
    provider: cfg.provider,
    label: cfg.provider,
    baseURL: cfg.baseURL,
    apiKey: cfg.apiKey,
    enabled: true,
    models: [{ model: cfg.model, label: cfg.model }],
  };
  doc.defaultModel = { providerId: id, model: cfg.model };
  return doc;
}

/**
 * **始终归一到新形状。** 三种历史形状进来,一种形状出去 —— 而这一份就是
 * `patchCredential` 写回库的字节。
 *
 * 为什么迁移必须在这里、不能交给前端:`redactLlmChat` 只回 presence 布尔,
 * 前端手上根本没有密钥原文,搬不动它;让前端发 `keys:null` 清旧字段,
 * 等于第一次保存就把用户没当场重输的每一把 key 删掉,不可逆。
 *
 * **只有结构性不可解析才返回 null。** 内容问题一律降级(跳过坏条目、置空默认项)——
 * 返回 null 会让 `credentialApi.ts` 的 `mergePatch(null, patch)` 退化成空对象,
 * 下一次保存把库里其余厂商连密钥一起清掉。严格失败在这条管道上是破坏装置。
 */
export function parseLlmChatDocument(raw: string): LlmChatDocument | null {
  let data: unknown;
  try {
    data = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
  if (!isRecord(data)) return null;

  if (isRecord(data.providers)) return parseProvidersShape(data);
  if (Array.isArray(data.models) || isRecord(data.keys)) return migrateFlat(data);

  const legacy = parseLlmChatConfigJson(raw);
  if (legacy) return migrateLegacy(legacy);

  // 认不出来但结构完好(比如 `{}`):给一份空文档,不给 null。
  return emptyDocument();
}

/** 文档里有没有任何可用的东西。空文档与「未配置」同义。 */
export function isEmptyDocument(doc: LlmChatDocument): boolean {
  return Object.keys(doc.providers).length === 0;
}
