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

export type ModelCatalog = {
  /** ISO 时间戳。解析不出来时按「陈旧」处理。 */
  fetchedAt: string;
  /** provider id → 该家的模型 id 列表(原样,不做任何归一)。 */
  providers: Record<string, string[]>;
};

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
): Record<string, string[]> {
  const obj = asObj(root);
  if (!obj) return {};
  const out: Record<string, string[]> = {};
  for (const provider of wanted) {
    const models = asObj(asObj(obj[provider])?.models);
    if (!models) continue;
    const ids: string[] = [];
    for (const [key, raw] of Object.entries(models)) {
      const m = asObj(raw);
      const id = typeof m?.id === "string" && m.id.trim() ? m.id.trim() : key.trim();
      if (id && !ids.includes(id)) ids.push(id);
    }
    if (ids.length > 0) out[provider] = ids;
  }
  return out;
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
    return { fetchedAt: o.fetchedAt, providers: clean };
  } catch {
    // 手改坏了或半截写入 —— 当没有,重新拉一次即可。缓存是可丢的。
    return null;
  }
}

export function writeCachedCatalog(catalog: ModelCatalog): void {
  setConfigMeta(CATALOG_META_KEY, JSON.stringify(catalog));
}

export function catalogIsStale(catalog: ModelCatalog, nowMs: number): boolean {
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
    const catalog: ModelCatalog = {
      fetchedAt: new Date(nowMs).toISOString(),
      providers: parseModelsDevCatalog(root, opts.providers),
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
