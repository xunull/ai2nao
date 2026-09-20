/**
 * models.dev 的**模型目录**缓存。让设置页从下拉里选模型,而不是手敲一个
 * 可能已经退役的名字(`deepseek-reasoner` 就是这么坏掉的)。
 *
 * **与 model_prices 彻底分开,这不是洁癖:**
 * - `priceStore.loadPriceMap` 只按 `model_id` 建键、丢掉 provider。今天只有
 *   anthropic+openai 撞不上,加五家之后同名模型会互相覆盖单价 —— 静默改掉成本核算。
 * - 那张表在 index.db,落盘会碰 `SCHEMA_VERSION`(改了会让已装的打包版打不开库)。
 * - `priceStore.bareModelId` 会剥掉 `provider/` 前缀,那是给价格匹配做的归一;
 *   当目录用会给出厂商 API 不认的 id。
 *
 * 所以目录住在 config.db 的 `config_meta` 里 —— 自由键值,不涉及任何 schema 版本。
 */
import { getConfigMeta, setConfigMeta } from "../settings/store.js";
// 单价换算的唯一真相源 —— 见该常量的注释:两边各写一个同值常量,分叉出来
// 就是单价差一百万倍且不报错。
import { PER_MILLION } from "./modelsDevSync.js";

export type ModelCatalog = {
  /** ISO 时间戳。解析不出来时按「陈旧」处理。 */
  fetchedAt: string;
  /** provider id → 该家的模型 id 列表(原样,不做任何归一)。 */
  providers: Record<string, string[]>;
  /**
   * provider id → 该家**能收图**的模型 id 列表(models.dev 的 `modalities.input`
   * 含 "image")。
   *
   * **可选,且「缺失」≠「不支持」。** 升级当天盘上还是旧缓存,里面没有这个字段;
   * 把缺失当成不支持会让所有模型被误拦。缺失一律按「未知」处理 ——
   * 见 `modelVisionSupport`。
   */
  visionModels?: Record<string, string[]>;
  /**
   * provider id → 模型 id → 分段价。**单位是每 token 美元**(解析时已除以百万),
   * 与 `model_prices` 表、`ModelPrice` 的口径一致。
   *
   * **为什么放目录缓存而不是 `model_prices` 表:** 那张表是「一模型一行、一组单价」
   * (主键 `(provider, model_id)`),没有位置放档位;而加列要迁移,`SCHEMA_VERSION`
   * 钉死在 60 动不了。目录缓存走的是 `config_meta` 的一个 JSON blob,加字段零迁移。
   *
   * **可选,且「缺失」≠「没有分段价」。** 升级当天盘上还是旧缓存,里面没有这个字段。
   * 读取侧缺失时退回基础价、上下文窗口按「未知」处理;而 `catalogIsStale` 把缺这个
   * 字段的缓存一律判为陈旧 —— 与 `visionModels` 同一套处置。否则窗口与分段价会一直
   * 哑火到缓存按时间过期(最长 7 天):占用条只能显示「窗口未知」,预算闸一律放行。
   */
  pricing?: Record<string, Record<string, ModelTieredPrice>>;
};

/** 一个模型的基础价与按上下文分的档位价。单位均为**每 token 美元**。 */
export type ModelTieredPrice = {
  base: TierRate;
  /**
   * **按 `size` 升序**。选档规则:取 `size` 小于当前上下文长度的**最大**那一档;
   * 都不小于就用 `base`。
   *
   * **这条规则是推断,不是 models.dev 的文档。** 依据是实测形状:volcengine 的
   * `doubao-seed-2-0-lite` 基础价 0.089 < 32k 档 0.134 < 128k 档 0.267,价格随
   * 档位递增;MiniMax-M3 基础 0.3、512k 档 0.6 同理。两种读法(`>` 还是 `>=`)
   * 只在上下文恰好等于 size 时差一个 token,影响极小。
   */
  tiers: (TierRate & { size: number })[];
  /** models.dev 的 `limit`(模型根下,与 `cost` 并列)。7818/7818 全都有。 */
  limit?: { context: number; output: number };
};

/**
 * 一档的四个单价。**`cacheWrite` 常常缺失** —— volcengine 与 minimax 的 cost 里
 * 根本没有 `cache_write` 这个键,沿用 `modelsDevSync` 的处置:缺了按 0。
 */
export type TierRate = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
};

/** models.dev 对某个模型的图像输入是怎么说的。「没说」与「说不行」必须分开。 */
export type VisionSupport = "yes" | "no" | "unknown";

/**
 * 目录对这个模型的图像输入怎么说。
 *
 * 三态而不是布尔:目录可能整体拉不到(离线)、可能是升级前的旧缓存(没有该字段)、
 * 也可能这家根本不在目录里。这些都是「不知道」,不是「不支持」——
 * 前者应该放行加提示,后者才该置灰。
 */
export function modelVisionSupport(
  catalog: ModelCatalog | null,
  provider: string,
  model: string
): VisionSupport {
  if (!catalog?.visionModels) return "unknown"; // 旧缓存或没拉到
  const vision = catalog.visionModels[provider];
  if (!vision) return "unknown"; // 目录里没有这家
  if (vision.includes(model)) return "yes";
  // 这家在目录里、也列了能收图的模型,但不含它 —— 这才是「说不行」。
  return catalog.providers[provider]?.includes(model) ? "no" : "unknown";
}

export const CATALOG_META_KEY = "model-catalog";
export const CATALOG_URL = "https://models.dev/api.json";
/** 与 `scheduler` 里价格同步的 7 天一致 —— 目录的变动频率不比价格高。 */
export const CATALOG_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 8_000;

function asObj(v: unknown): Record<string, unknown> | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  return v as Record<string, unknown>;
}

/**
 * 与 `modelsDevSync` 里那个同名函数实现一致。
 *
 * **这里本地补一份,与 `PER_MILLION` 的处置刻意相反。** 那个是**口径**
 * (每百万 token),两处分叉会让单价差一百万倍且不报错,所以必须单一真相源;
 * 而这个只是无状态的类型守卫,不承载任何口径,本地一份不会分叉出语义差异 ——
 * 为它再拉一条跨文件依赖反而更不划算。`asObj` 同理,本来就是各自本地的。
 */
function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * 从 models.dev 的响应里抽出目录。
 *
 * 与 `modelsDevSync` 的两处**刻意分叉**:
 * 1. **无 `cost` 的模型照收。** 那边跳过是为了不把模型误标成免费;目录只关心
 *    「这个 id 能不能用」,与价格无关。跟着跳会让下拉少掉一半模型。
 * 2. **不剥 `provider/` 前缀。** 那是价格匹配的归一,剥完就是厂商不认的 id。
 */
export function parseModelsDevCatalog(
  root: unknown,
  wanted: string[]
): {
  providers: Record<string, string[]>;
  visionModels: Record<string, string[]>;
  pricing: Record<string, Record<string, ModelTieredPrice>>;
} {
  const obj = asObj(root);
  if (!obj) return { providers: {}, visionModels: {}, pricing: {} };
  const providers: Record<string, string[]> = {};
  const visionModels: Record<string, string[]> = {};
  const pricing: Record<string, Record<string, ModelTieredPrice>> = {};
  for (const provider of wanted) {
    const models = asObj(asObj(obj[provider])?.models);
    if (!models) continue;
    const ids: string[] = [];
    const vision: string[] = [];
    for (const [key, raw] of Object.entries(models)) {
      const m = asObj(raw);
      const id = typeof m?.id === "string" && m.id.trim() ? m.id.trim() : key.trim();
      if (!id || ids.includes(id)) continue;
      ids.push(id);
      // `modalities.input` 是个字符串数组,含 "image" 才算能收图。
      const input = asObj(m?.modalities)?.input;
      if (Array.isArray(input) && input.includes("image")) vision.push(id);

      // 分段价。**没有 cost 的模型照样留在 providers 里**(见文件头那条刻意分叉),
      // 只是不进 pricing —— 跟着跳会让下拉少掉一半模型。
      const tiered = tieredPriceOf(m);
      if (tiered) {
        pricing[provider] ??= {};
        pricing[provider]![id] = tiered;
      }
    }
    if (ids.length > 0) providers[provider] = ids;
    // 空数组也要写:「这家一个能收图的都没有」与「这家不在目录里」是两回事,
    // `modelVisionSupport` 靠这个区分 "no" 与 "unknown"。
    if (ids.length > 0) visionModels[provider] = vision;
  }
  return { providers, visionModels, pricing };
}

/** 一档四价。`cache_write` 常常整个不存在(volcengine / minimax 都没有),缺了按 0。 */
function rateOf(o: Record<string, unknown>): TierRate | null {
  const input = num(o.input);
  const output = num(o.output);
  if (input == null || output == null) return null;
  return {
    input: input / PER_MILLION,
    output: output / PER_MILLION,
    cacheRead: (num(o.cache_read) ?? 0) / PER_MILLION,
    cacheWrite: (num(o.cache_write) ?? 0) / PER_MILLION,
  };
}

/**
 * 从一个模型条目里抽出基础价 + 档位价 + limit。
 *
 * **读 `tiers` 而不是 `context_over_200k`。** 两者在 models.dev 里并列且内容重复,
 * 但覆盖不同:452 个模型有 `tiers`、只有 396 个有 `context_over_200k`,差的 56 个
 * 档位阈值是 32k / 128k / 256k —— 一个 200k 都没有。而且那个字段名与语义不符:
 * MiniMax-M3 的档位 size 是 512000,照样导出了 `context_over_200k`。
 * 只读扁平字段会把低阈值的档位静默漏掉,后果是高用量按基础价算、少算钱。
 */
function tieredPriceOf(m: Record<string, unknown> | null): ModelTieredPrice | null {
  if (!m) return null;
  const cost = asObj(m.cost);
  if (!cost) return null;
  const base = rateOf(cost);
  if (!base) return null;

  const tiers: (TierRate & { size: number })[] = [];
  const raw = cost.tiers;
  if (Array.isArray(raw)) {
    for (const t of raw) {
      const to = asObj(t);
      const meta = to ? asObj(to.tier) : null;
      // 实测 479 处 `tier.type` 全是 "context",没有第二种。**未知类型直接忽略**,
      // 不猜它的含义 —— 猜错就是按错的档位计价。
      if (!to || !meta || meta.type !== "context") continue;
      const size = num(meta.size);
      const rate = rateOf(to);
      if (size == null || !rate) continue;
      tiers.push({ ...rate, size });
    }
  }
  // **升序存**,选档时取 size 小于当前上下文的最大那一档。
  tiers.sort((a, b) => a.size - b.size);

  const limitObj = asObj(m.limit);
  const ctx = limitObj ? num(limitObj.context) : null;
  const out = limitObj ? num(limitObj.output) : null;

  return {
    base,
    tiers,
    ...(ctx != null && out != null ? { limit: { context: ctx, output: out } } : {}),
  };
}

export function readCachedCatalog(): ModelCatalog | null {
  const raw = getConfigMeta(CATALOG_META_KEY);
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as unknown;
    const o = asObj(v);
    if (!o || typeof o.fetchedAt !== "string") return null;
    const providers = asObj(o.providers);
    if (!providers) return null;
    const clean: Record<string, string[]> = {};
    for (const [k, list] of Object.entries(providers)) {
      if (Array.isArray(list)) clean[k] = list.filter((x): x is string => typeof x === "string");
    }
    // visionModels 缺失时**不要**补空对象 —— undefined 表示「旧缓存/不知道」,
    // 空对象会被 modelVisionSupport 当成「查过了,这家没有」。
    const rawVision = asObj(o.visionModels);
    let vision: Record<string, string[]> | undefined;
    if (rawVision) {
      vision = {};
      for (const [k, list] of Object.entries(rawVision)) {
        if (Array.isArray(list)) vision[k] = list.filter((x): x is string => typeof x === "string");
      }
    }
    // 分段价照 visionModels 的范式:缺失就**根本不写这个键**,而不是补空对象。
    // `undefined` = 旧缓存、不知道 → 退回基础价;`{}` = 拉过了、确实没有。
    // 校验只做形状、坏的那条跳过 —— 缓存是可丢的,不值得为它引入更严的解析。
    const rawPricing = asObj(o.pricing);
    let pricing: Record<string, Record<string, ModelTieredPrice>> | undefined;
    if (rawPricing) {
      pricing = {};
      for (const [pid, models] of Object.entries(rawPricing)) {
        const byModel = asObj(models);
        if (!byModel) continue;
        const kept: Record<string, ModelTieredPrice> = {};
        for (const [mid, entry] of Object.entries(byModel)) {
          const e = asObj(entry);
          // 至少要有 base 与 tiers 数组才算一条可用的分段价。
          if (!e || !asObj(e.base) || !Array.isArray(e.tiers)) continue;
          kept[mid] = e as unknown as ModelTieredPrice;
        }
        if (Object.keys(kept).length > 0) pricing[pid] = kept;
      }
    }
    return {
      fetchedAt: o.fetchedAt,
      providers: clean,
      ...(vision ? { visionModels: vision } : {}),
      ...(pricing ? { pricing } : {}),
    };
  } catch {
    // 手改坏了或半截写入 —— 当没有,重新拉一次即可。缓存是可丢的。
    return null;
  }
}

export function writeCachedCatalog(catalog: ModelCatalog): void {
  setConfigMeta(CATALOG_META_KEY, JSON.stringify(catalog));
}

export function catalogIsStale(catalog: ModelCatalog, nowMs: number): boolean {
  // **旧格式缓存一律算陈旧。** 升级前写下的缓存没有 visionModels —— 它可能才拉了
  // 一天、按时间还新鲜,但留着它的代价是所有模型的读图能力都判成「未知」,
  // 最长要熬满 7 天。按陈旧处理,下一次有人要目录时就顺手换成新格式。
  if (!catalog.visionModels) return true;
  // **同理,没有 `pricing` 的旧格式缓存也算陈旧。** 上下文窗口(`limit.context`)与分段价
  // 都挂在它上面 —— 留着它,占用条对所有模型都只能显示「窗口未知」,预算闸按「窗口未知
  // 就放行」一律不拦,自动压缩永远不触发,同样要熬满 7 天。新版落盘时总会写这个键,
  // 所以「缺这个键」只可能是旧格式。
  if (!catalog.pricing) return true;
  const t = Date.parse(catalog.fetchedAt);
  // 时间戳解析不出来就当陈旧:宁可多拉一次,也不要永远用一份坏缓存。
  if (!Number.isFinite(t)) return true;
  return nowMs - t > CATALOG_MAX_AGE_MS;
}

/** 注入点故意只有 (url, signal) —— 没有传 header 的位置,拉目录不带任何凭据。 */
export type CatalogFetchJson = (url: string, signal: AbortSignal) => Promise<unknown>;

async function defaultFetchJson(url: string, signal: AbortSignal): Promise<unknown> {
  const r = await fetch(url, { signal, headers: { accept: "application/json" } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

export type EnsureCatalogOptions = {
  providers: string[];
  fetchJson?: CatalogFetchJson;
  timeoutMs?: number;
  nowMs?: number;
  /** 用户按了「刷新」:忽略新鲜度,真去拉一次。 */
  force?: boolean;
};

export type EnsureCatalogResult = {
  catalog: ModelCatalog;
  /** cache=新鲜直接用 / network=拉到了 / stale-cache=拉失败但有旧的 / empty=拉失败且没有 */
  source: "cache" | "network" | "stale-cache" | "empty";
  error?: string;
};

/**
 * 拿到目录。**失败一律降级,不抛。**
 *
 * 拉不到时:有旧缓存就给旧的(清空等于把用户的下拉变成空的,而他上一秒还能选),
 * 没有就给空目录 + 可读错误,前端降级成手填 —— 不阻塞页面。
 */
export async function ensureModelCatalog(
  opts: EnsureCatalogOptions
): Promise<EnsureCatalogResult> {
  const nowMs = opts.nowMs ?? Date.now();
  const cached = readCachedCatalog();
  if (cached && !opts.force && !catalogIsStale(cached, nowMs)) {
    return { catalog: cached, source: "cache" };
  }

  const fetchJson = opts.fetchJson ?? defaultFetchJson;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const root = await fetchJson(CATALOG_URL, ac.signal);
    const parsed = parseModelsDevCatalog(root, opts.providers);
    const catalog: ModelCatalog = {
      fetchedAt: new Date(nowMs).toISOString(),
      providers: parsed.providers,
      visionModels: parsed.visionModels,
      // 空对象也照写:「这次拉到了、但一家分段价都没有」与「旧缓存没这个字段」
      // 是两回事,后者要退回基础价,前者不必再期待。
      pricing: parsed.pricing,
    };
    writeCachedCatalog(catalog);
    return { catalog, source: "network" };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    // **不覆盖盘上那份。** 拉失败时写入等于用空目录把能用的旧目录冲掉。
    if (cached) return { catalog: cached, source: "stale-cache", error };
    return { catalog: { fetchedAt: new Date(nowMs).toISOString(), providers: {} }, source: "empty", error };
  } finally {
    clearTimeout(timer);
  }
}
