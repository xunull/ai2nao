import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Hono } from "hono";
import type Database from "better-sqlite3";
import { createApp } from "../src/serve/app.js";
import { openDatabase } from "../src/store/open.js";
import { resetSettingsForTest, setCredentialRaw } from "../src/settings/store.js";
import { __setProviderProbeForTest } from "../src/llmChat/providerRoutes.js";
import { writeCachedCatalog } from "../src/cost/modelCatalog.js";

/**
 * 这两个 POST 路由会拿**库里的 key** 去打某个地址,而 serve 层这些路由无鉴权
 * (`app.ts` 只有 CORS)。所以安全约束不是附加项,是这组测试的主题。
 */

let base: string;
let db: Database.Database;
let app: Hono;
let savedConfigDb: string | undefined;
/** 探测被打到哪个 URL、带了什么头 —— 安全断言全靠它。 */
let probes: { url: string; apiKey?: string }[];

const STORED = {
  providers: {
    deepseek: {
      provider: "deepseek",
      label: "DeepSeek",
      baseURL: "https://api.deepseek.com",
      apiKey: "sk-库里存的",
      enabled: true,
      models: [{ model: "deepseek-chat", label: "DeepSeek Chat" }],
    },
    nokey: {
      // 用 deepseek 而不是 openai-compatible:后者无 key 时会落到 placeholder
      // ("local-no-key"),那是本地端点的正常状态,不算缺 key。
      provider: "deepseek",
      label: "没配 key 的",
      baseURL: "https://api.deepseek.com",
      enabled: true,
      models: [],
    },
    local: {
      provider: "openai-compatible",
      label: "本地 LM Studio",
      baseURL: "http://127.0.0.1:1234/v1",
      enabled: true,
      models: [],
    },
  },
};

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "ai2nao-prov-"));
  db = openDatabase(join(base, "idx.db"));
  savedConfigDb = process.env.AI2NAO_CONFIG_DB;
  process.env.AI2NAO_CONFIG_DB = join(base, "config.db");
  process.env.AI2NAO_HOME = base;
  resetSettingsForTest();
  setCredentialRaw("llm-chat", JSON.stringify(STORED));
  app = createApp({ db });
  probes = [];
  __setProviderProbeForTest(async (url, apiKey) => {
    probes.push({ url, apiKey });
    return { ok: true, status: 200, models: ["deepseek-chat", "deepseek-reasoner"] };
  });
});
afterEach(() => {
  __setProviderProbeForTest(null);
  db.close();
  resetSettingsForTest();
  rmSync(base, { recursive: true, force: true });
  delete process.env.AI2NAO_HOME;
  if (savedConfigDb === undefined) delete process.env.AI2NAO_CONFIG_DB;
  else process.env.AI2NAO_CONFIG_DB = savedConfigDb;
});

const post = (path: string, body: unknown, contentType = "application/json") =>
  app.request(`http://x${path}`, {
    method: "POST",
    headers: { "content-type": contentType },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

describe("安全约束 —— 这两个路由是带凭据的转发器", () => {
  it("★ 请求体里的 baseURL 被忽略,实际打的是库里存的那个", async () => {
    // 否则任何能连上本机端口的进程都能用它把密钥送到任意主机。
    const res = await post("/api/llm-chat/providers/deepseek/refresh-models", {
      baseURL: "https://attacker.invalid/v1",
    });
    expect(res.status).toBe(200);
    expect(probes).toHaveLength(1);
    expect(probes[0].url).toBe("https://api.deepseek.com/models");
    expect(probes[0].url).not.toContain("attacker");
  });

  it("★ 非 JSON Content-Type → 400,不发任何请求", async () => {
    // CORS 只放 5173,PATCH 会被预检挡住 —— 但 POST 是**不预检**的方法:
    // 任意站点能用简单请求触发副作用(读不到响应,但请求照发)。
    // text/plain 与 form 都是简单请求能用的类型,必须挡在动手之前。
    for (const ct of ["text/plain", "application/x-www-form-urlencoded", "multipart/form-data"]) {
      const res = await post("/api/llm-chat/providers/deepseek/refresh-models", {}, ct);
      expect(res.status, ct).toBe(400);
    }
    expect(probes).toHaveLength(0);
  });

  it("★ test 路由同样挡非 JSON", async () => {
    const res = await post("/api/llm-chat/providers/deepseek/test", {}, "text/plain");
    expect(res.status).toBe(400);
    expect(probes).toHaveLength(0);
  });

  it("★ 响应里绝不出现密钥原文", async () => {
    const a = await post("/api/llm-chat/providers/deepseek/refresh-models", {});
    const b = await post("/api/llm-chat/providers/deepseek/test", {});
    expect(await a.text()).not.toContain("sk-库里存的");
    expect(await b.text()).not.toContain("sk-库里存的");
  });

  it("★ 只打 /models,不打 /chat/completions —— 检测不该产生计费请求", async () => {
    await post("/api/llm-chat/providers/deepseek/test", {});
    expect(probes[0].url).toMatch(/\/models$/);
    expect(probes.some((p) => p.url.includes("chat/completions"))).toBe(false);
  });
});

describe("refresh-models", () => {
  it("拿库里的 key 打 /models,返回模型 id 列表", async () => {
    const res = await post("/api/llm-chat/providers/deepseek/refresh-models", {});
    expect(res.status).toBe(200);
    const body = (await res.json()) as { models: string[] };
    expect(body.models).toEqual(["deepseek-chat", "deepseek-reasoner"]);
    expect(probes[0].apiKey).toBe("sk-库里存的");
  });

  it("未知实例 → 404,不发请求", async () => {
    const res = await post("/api/llm-chat/providers/根本没有这个/refresh-models", {});
    expect(res.status).toBe(404);
    expect(probes).toHaveLength(0);
  });

  it("实例没有 key → 400 且不发请求 —— 无 key 打过去只会拿到 401,白跑一趟", async () => {
    const res = await post("/api/llm-chat/providers/nokey/refresh-models", {});
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("API key");
    expect(probes).toHaveLength(0);
  });

  it("★ 本地 openai-compatible 没 key 也照探 —— 那是它的正常状态,拦掉就是误禁", () => {
    // 判据是 resolveApiKeySource 的 source === "missing",不是 !apiKey;
    // openai-compatible 无约定环境变量,会落到 placeholder。
    return post("/api/llm-chat/providers/local/refresh-models", {}).then(async (res) => {
      expect(res.status).toBe(200);
      expect(probes[0].url).toBe("http://127.0.0.1:1234/v1/models");
    });
  });

  it("baseURL 为空的实例 → 400 —— openai-compatible 默认地址是空串,没有起点", async () => {
    setCredentialRaw(
      "llm-chat",
      JSON.stringify({
        providers: {
          empty: { provider: "openai-compatible", label: "空地址", baseURL: "", apiKey: "sk-x", enabled: true, models: [] },
        },
      })
    );
    const res = await post("/api/llm-chat/providers/empty/refresh-models", {});
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("Base URL");
    expect(probes).toHaveLength(0);
  });
});

describe("test —— 结果要如实分类,不能给一个只会绿的按钮", () => {
  it("200 → ok", async () => {
    const res = await post("/api/llm-chat/providers/deepseek/test", {});
    const body = (await res.json()) as { ok: boolean; reason: string; url: string };
    expect(body.ok).toBe(true);
    expect(body.reason).toBe("ok");
    // ★ 成功文案必须自带限定:/models 回 200 而账户 402 时对话照样失败,
    // 只说「连接正常」就是又造一个只会绿的按钮。
    expect((body as unknown as { message: string }).message).toContain("未验证余额");
    // 显示**实际发出的** URL —— 而不是另造一个「地址预览」去猜。
    expect(body.url).toBe("https://api.deepseek.com/models");
  });

  it("401 → 说 key 不对,而不是含糊的失败", async () => {
    __setProviderProbeForTest(async () => ({ ok: false, status: 401 }));
    const body = (await (await post("/api/llm-chat/providers/deepseek/test", {})).json()) as {
      ok: boolean; reason: string; message: string;
    };
    expect(body.ok).toBe(false);
    expect(body.reason).toBe("bad-key");
    expect(body.message).toContain("API key");
  });

  it("★ 404/405 → 说这家没有 /models 端点,请手填", async () => {
    // 实测:moonshotai / alibaba / minimax 的 /models 确实存在(伪路径回 404),
    // 但 deepseek 与火山对**任何**路径都回 401,不带凭据无法判定。
    // 所以不硬编码一张判不出来的能力表,而是如实报告真实结果。
    for (const status of [404, 405]) {
      __setProviderProbeForTest(async () => ({ ok: false, status }));
      const body = (await (await post("/api/llm-chat/providers/deepseek/test", {})).json()) as {
        reason: string; message: string;
      };
      expect(body.reason, String(status)).toBe("no-models-endpoint");
      expect(body.message).toContain("手填");
    }
  });

  it("网络层失败 → 可读错误,不抛也不泄漏 key", async () => {
    __setProviderProbeForTest(async () => {
      throw new Error("ECONNREFUSED sk-库里存的");
    });
    const res = await post("/api/llm-chat/providers/deepseek/test", {});
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("unreachable");
    // 上游错误信息里可能带上我们发出去的东西,原样透出就是泄漏。
    expect(text).not.toContain("sk-库里存的");
  });
});

describe("GET /api/llm-chat/model-catalog", () => {
  it("有缓存时直接返回,不发网络请求", async () => {
    writeCachedCatalog({
      fetchedAt: new Date().toISOString(),
      providers: { deepseek: ["deepseek-chat"] },
    });
    const res = await app.request("http://x/api/llm-chat/model-catalog");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { source: string; providers: Record<string, string[]> };
    expect(body.source).toBe("cache");
    expect(body.providers.deepseek).toEqual(["deepseek-chat"]);
  });

  it("★ 火山带一条提示 —— 它的对话标识是接入点 id(ep-…),目录选不出来", async () => {
    writeCachedCatalog({ fetchedAt: new Date().toISOString(), providers: {} });
    const res = await app.request("http://x/api/llm-chat/model-catalog");
    const body = (await res.json()) as { notes: Record<string, string> };
    expect(body.notes.volcengine).toContain("接入点");
  });
});
