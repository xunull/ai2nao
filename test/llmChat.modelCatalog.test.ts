import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CATALOG_MAX_AGE_MS,
  catalogIsStale,
  ensureModelCatalog,
  parseModelsDevCatalog,
  readCachedCatalog,
  writeCachedCatalog,
} from "../src/cost/modelCatalog.js";
import { resetSettingsForTest, setConfigMeta } from "../src/settings/store.js";

/**
 * 模型目录:让用户从下拉里选模型,而不是手敲一个可能已经退役的名字。
 *
 * **不能复用 model_prices。** `priceStore.loadPriceMap` 只按 model_id 建键、丢掉
 * provider —— 今天只有 anthropic+openai 撞不上,加五家后同名模型会互相覆盖单价,
 * 静默改掉成本核算。而且那张表在 index.db,落盘会碰 SCHEMA_VERSION。
 * 所以目录走 config.db 的 config_meta,与价格表彻底分开。
 */

/** models.dev 的真实形状:顶层按 provider id 索引,每家有个 .models 对象。 */
const MODELS_DEV = {
  deepseek: {
    models: {
      "deepseek-chat": { id: "deepseek-chat", cost: { input: 0.27, output: 1.1 } },
      // 没有 cost —— 同步价格那条路会跳过它,目录这条路**必须收**。
      "deepseek-reasoner": { id: "deepseek-reasoner" },
    },
  },
  minimax: {
    models: {
      // id 带 `provider/` 前缀。价格路径会剥掉它做匹配归一,
      // 目录路径不能剥 —— 剥完就是厂商 API 不认的 id。
      "MiniMax-M2": { id: "minimax/MiniMax-M2", cost: { input: 0.3, output: 1.2 } },
    },
  },
  anthropic: { models: { "claude-opus-5": { id: "claude-opus-5" } } },
};

const WANTED = ["deepseek", "minimax", "moonshotai"];

beforeEach(() => {
  process.env.AI2NAO_HOME = mkdtempSync(join(tmpdir(), "ai2nao-catalog-"));
  resetSettingsForTest();
});
afterEach(() => {
  delete process.env.AI2NAO_HOME;
  resetSettingsForTest();
});

describe("parseModelsDevCatalog", () => {
  it("按 provider 收模型 id,只要点名的那几家", () => {
    const out = parseModelsDevCatalog(MODELS_DEV, WANTED);
    expect(Object.keys(out).sort()).toEqual(["deepseek", "minimax"]);
    // 没点名的 anthropic 不进来;点名了但对面没有的 moonshotai 也不凭空造。
    expect(out.anthropic).toBeUndefined();
    expect(out.moonshotai).toBeUndefined();
  });

  it("★ 无价格的模型也要收 —— 同步价格那条路跳过它,目录这条路不能跟着跳", () => {
    // modelsDevSync.ts 对没有 cost 的模型 skippedNoCost++,那是为了不把模型
    // 误标成免费。目录只关心「这个 id 能不能用」,跟价格无关。
    expect(parseModelsDevCatalog(MODELS_DEV, ["deepseek"]).deepseek).toEqual([
      "deepseek-chat",
      "deepseek-reasoner",
    ]);
  });

  it("★ 不剥 `provider/` 前缀 —— bareModelId 是给价格匹配用的,当目录用会给出厂商不认的 id", () => {
    expect(parseModelsDevCatalog(MODELS_DEV, ["minimax"]).minimax).toEqual([
      "minimax/MiniMax-M2",
    ]);
  });

  it("形状不对时给空目录,不抛 —— 上游随时可能改结构,不该炸设置页", () => {
    expect(parseModelsDevCatalog(null, WANTED)).toEqual({});
    expect(parseModelsDevCatalog("字符串", WANTED)).toEqual({});
    expect(parseModelsDevCatalog({ deepseek: { models: "不是对象" } }, ["deepseek"])).toEqual({});
  });
});

describe("缓存(config.db 的 config_meta,不碰 model_prices)", () => {
  it("写进去读得回来", () => {
    const c = { fetchedAt: "2026-09-03T00:00:00.000Z", providers: { deepseek: ["m1"] } };
    writeCachedCatalog(c);
    expect(readCachedCatalog()).toEqual(c);
  });

  it("没写过时是 null,不是空对象 —— 「没拉过」与「拉到了空的」要分得开", () => {
    expect(readCachedCatalog()).toBeNull();
  });

  it("存的内容坏掉时当没有,不抛", () => {
    writeCachedCatalog({ fetchedAt: "x", providers: { a: ["m"] } });
    // 手工塞一份坏的进去(模拟手改或半截写入)。
    setConfigMeta("model-catalog", "{不是 JSON");
    expect(readCachedCatalog()).toBeNull();
  });

  it("7 天是新鲜与陈旧的分界", () => {
    const t0 = Date.parse("2026-09-03T00:00:00.000Z");
    const c = { fetchedAt: "2026-09-03T00:00:00.000Z", providers: {} };
    expect(catalogIsStale(c, t0 + CATALOG_MAX_AGE_MS - 1)).toBe(false);
    expect(catalogIsStale(c, t0 + CATALOG_MAX_AGE_MS + 1)).toBe(true);
    // 时间戳解析不出来 → 当陈旧,宁可多拉一次也不要永远用一份坏缓存。
    expect(catalogIsStale({ fetchedAt: "垃圾", providers: {} }, t0)).toBe(true);
  });
});

describe("ensureModelCatalog", () => {
  const ok = async () => MODELS_DEV;
  const boom = async () => {
    throw new Error("网络炸了");
  };

  it("缓存新鲜 → 直接用,一个网络请求都不发", async () => {
    let called = 0;
    writeCachedCatalog({ fetchedAt: new Date().toISOString(), providers: { deepseek: ["缓存里的"] } });
    const r = await ensureModelCatalog({
      providers: WANTED,
      fetchJson: async () => {
        called += 1;
        return MODELS_DEV;
      },
    });
    expect(called).toBe(0);
    expect(r.source).toBe("cache");
    expect(r.catalog.providers.deepseek).toEqual(["缓存里的"]);
  });

  it("缓存陈旧 → 拉一次并更新", async () => {
    const old = new Date(Date.now() - CATALOG_MAX_AGE_MS - 1000).toISOString();
    writeCachedCatalog({ fetchedAt: old, providers: { deepseek: ["旧的"] } });
    const r = await ensureModelCatalog({ providers: WANTED, fetchJson: ok });
    expect(r.source).toBe("network");
    expect(r.catalog.providers.deepseek).toEqual(["deepseek-chat", "deepseek-reasoner"]);
    // 落了盘,下次不用再拉。
    expect(readCachedCatalog()?.providers.deepseek).toEqual(["deepseek-chat", "deepseek-reasoner"]);
  });

  it("没有缓存 → 拉一次", async () => {
    const r = await ensureModelCatalog({ providers: WANTED, fetchJson: ok });
    expect(r.source).toBe("network");
    expect(r.catalog.providers.minimax).toEqual(["minimax/MiniMax-M2"]);
  });

  it("★ 网络失败但有旧缓存 → 给旧的 + 错误,**不清空**", async () => {
    // 清空等于把用户的下拉变成空的,而他上一秒还能选。降级要保留能用的东西。
    const old = new Date(Date.now() - CATALOG_MAX_AGE_MS - 1000).toISOString();
    writeCachedCatalog({ fetchedAt: old, providers: { deepseek: ["旧的但能用"] } });
    const r = await ensureModelCatalog({ providers: WANTED, fetchJson: boom });
    expect(r.source).toBe("stale-cache");
    expect(r.catalog.providers.deepseek).toEqual(["旧的但能用"]);
    expect(r.error).toContain("网络炸了");
    // 盘上那份也不能被覆盖成空。
    expect(readCachedCatalog()?.providers.deepseek).toEqual(["旧的但能用"]);
  });

  it("网络失败且没有缓存 → 空目录 + 可读错误,不抛(降级成手填,不阻塞页面)", async () => {
    const r = await ensureModelCatalog({ providers: WANTED, fetchJson: boom });
    expect(r.source).toBe("empty");
    expect(r.catalog.providers).toEqual({});
    expect(r.error).toContain("网络炸了");
  });

  it("★ 拉目录不带任何凭据 —— 它不属于「带凭据的转发器」那类风险", async () => {
    let seenInit: RequestInit | undefined;
    await ensureModelCatalog({
      providers: WANTED,
      fetchJson: async (url, signal) => {
        seenInit = { signal };
        expect(url).toBe("https://models.dev/api.json");
        return MODELS_DEV;
      },
    });
    // fetchJson 的签名里根本没有传 header 的位置 —— 这条断言守的是「别加」。
    expect(Object.keys(seenInit ?? {})).toEqual(["signal"]);
  });

  it("force 时忽略新鲜的缓存 —— 用户按「刷新」就得真去拉", async () => {
    writeCachedCatalog({ fetchedAt: new Date().toISOString(), providers: { deepseek: ["旧的"] } });
    const r = await ensureModelCatalog({ providers: WANTED, fetchJson: ok, force: true });
    expect(r.source).toBe("network");
    expect(r.catalog.providers.deepseek).toEqual(["deepseek-chat", "deepseek-reasoner"]);
  });
});
