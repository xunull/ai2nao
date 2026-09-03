/**
 * 两个**带凭据的转发器**:拿库里存的 key 去打某个厂商的 `/models`。
 *
 * - `POST /api/llm-chat/providers/:id/refresh-models` —— 拉这家的模型列表
 * - `POST /api/llm-chat/providers/:id/test` —— 检测这家通不通
 * - `GET  /api/llm-chat/model-catalog` —— models.dev 目录(不带凭据,风险等级不同)
 *
 * serve 层这些路由**无鉴权**(`app.ts` 只有 CORS),所以两条约束不是附加项:
 *
 * **一、baseURL 只取该实例已保存的值,不接受请求体里的。** 否则任何能连上本机
 * 端口的进程都能用它把密钥送到任意主机。
 *
 * **二、非 JSON Content-Type 直接 400。** CORS 只放 5173,PATCH 会被预检挡住,
 * 但 **POST 是不预检的方法** —— 任意站点能用简单请求(text/plain、form)触发副作用:
 * 它读不到响应,但请求照发、密钥照送。所以必须挡在动手之前。
 */
import type { Hono } from "hono";
import { readLlmChatDocument, LLM_CHAT_PROVIDERS } from "./config.js";
import { resolveApiKeySource } from "./apiKeySource.js";
import { ensureModelCatalog } from "../cost/modelCatalog.js";
import { llmChatLog } from "./log.js";

export type ProbeResult = {
  ok: boolean;
  status: number;
  models?: string[];
};

export type ProviderProbe = (url: string, apiKey?: string) => Promise<ProbeResult>;

/**
 * 只打 `/models`。**绝不打 `/chat/completions`** —— 检测不该产生计费请求
 * (代价是它验不出余额:`/models` 200 而真对话 402 是已知未覆盖的情况)。
 */
async function defaultProbe(url: string, apiKey?: string): Promise<ProbeResult> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 8_000);
  try {
    const r = await fetch(url, {
      signal: ac.signal,
      headers: {
        accept: "application/json",
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
      },
    });
    if (!r.ok) return { ok: false, status: r.status };
    const body = (await r.json()) as unknown;
    return { ok: true, status: r.status, models: extractModelIds(body) };
  } finally {
    clearTimeout(timer);
  }
}

/** OpenAI 兼容的形状是 `{data:[{id}]}`;各家偶有出入,取不到就当空列表。 */
function extractModelIds(body: unknown): string[] {
  const data = (body as { data?: unknown })?.data;
  if (!Array.isArray(data)) return [];
  return data
    .map((m) => (m && typeof (m as { id?: unknown }).id === "string" ? (m as { id: string }).id : null))
    .filter((x): x is string => Boolean(x));
}

let probeImpl: ProviderProbe | null = null;
/** 测试注入点。传 null 恢复真实实现。 */
export function __setProviderProbeForTest(p: ProviderProbe | null): void {
  probeImpl = p;
}
function probe(): ProviderProbe {
  return probeImpl ?? defaultProbe;
}

/** 拼 `<baseURL>/models`,容忍尾部斜杠。 */
function modelsUrl(baseURL: string): string {
  return `${baseURL.replace(/\/+$/, "")}/models`;
}

/**
 * 上游错误信息里可能回显我们发出去的东西(URL、header)。原样透出就是泄漏,
 * 所以只放行分类和一句我们自己写的话。
 */
function safeMessage(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  return raw.length > 200 ? `${raw.slice(0, 200)}…` : raw;
}

type Resolved =
  | { ok: true; baseURL: string; apiKey: string; url: string }
  | { ok: false; status: 400 | 404; error: string };

/** 从**库里**取这个实例,并把 key/地址备齐。请求体一个字段都不参与。 */
function resolveInstance(id: string): Resolved {
  const doc = readLlmChatDocument();
  const inst = doc?.providers[id];
  if (!inst) return { ok: false, status: 404, error: `没有这个服务商实例：${id}` };

  const baseURL = inst.baseURL.trim();
  if (!baseURL) {
    // openai-compatible 的默认地址是空串(config.ts),没有起点就无从打起。
    return { ok: false, status: 400, error: "这个服务商还没有填 Base URL，先填上再试。" };
  }
  const { apiKey, source } = resolveApiKeySource(
    { provider: inst.provider, apiKey: inst.apiKey },
    process.env
  );
  // 判「选不了」的唯一真值是 source === "missing",**不是 !apiKey** ——
  // openai-compatible 无 key 时会落到 `placeholder`("local-no-key"),
  // 那是 LM Studio / Ollama 这类本地端点的正常状态,拦掉它就是误禁。
  // 这与 credentialSourceOf 把 missing 映射成 "none" 是同一条口径。
  if (source === "missing") {
    // 真缺 key 时打过去只会拿到 401,白跑一趟还多送一次请求。
    return { ok: false, status: 400, error: "这个服务商还没有配 API key。" };
  }
  return { ok: true, baseURL, apiKey: apiKey ?? "", url: modelsUrl(baseURL) };
}

/** 简单请求能用的 Content-Type 全部拒绝 —— 见文件头「约束二」。 */
function rejectNonJson(c: { req: { header: (n: string) => string | undefined } }): boolean {
  const ct = (c.req.header("content-type") ?? "").split(";")[0].trim().toLowerCase();
  return ct !== "application/json";
}

/** 把探测结果翻译成用户看得懂的分类。绝不给一个只会绿的按钮。 */
function classify(r: ProbeResult): { ok: boolean; reason: string; message: string } {
  if (r.ok) {
    // **限定必须写进成功文案本身。** 按钮旁边那句免责会被结果覆盖掉,
    // 只说「连接正常」就又造出一个「只会绿的按钮」:/models 回 200 而账户
    // 余额不足(402)时,真发对话照样失败 —— 这正是本仓库当下 DeepSeek 的状态。
    return { ok: true, reason: "ok", message: "模型列表可访问（未验证余额与对话权限）。" };
  }
  if (r.status === 401 || r.status === 403) {
    return { ok: false, reason: "bad-key", message: "API key 被拒绝（401/403）。检查 key 是否正确、是否过期。" };
  }
  if (r.status === 404 || r.status === 405) {
    // 实测:moonshotai / alibaba / minimax 的 /models 确实存在(伪路径回 404),
    // 但 deepseek 与火山对**任何**路径都回 401 —— 不带凭据判不出来。
    // 所以不硬编码能力表,而是拿到什么说什么。
    return {
      ok: false,
      reason: "no-models-endpoint",
      message: "这家不支持 /models 列表接口，模型名请手填。",
    };
  }
  return { ok: false, reason: "upstream-error", message: `上游返回 ${r.status}。` };
}

/** 火山的对话标识是推理接入点 id(`ep-…`),不是模型名 —— 目录列不出来。 */
const CATALOG_NOTES: Record<string, string> = {
  volcengine: "火山方舟的对话标识是推理接入点 id（ep-… ），不是模型名，需要手填。",
};

export function registerLlmChatProviderRoutes(app: Hono): void {
  app.post("/api/llm-chat/providers/:id/refresh-models", async (c) => {
    if (rejectNonJson(c)) return c.json({ error: "Content-Type 必须是 application/json" }, 400);
    const r = resolveInstance(c.req.param("id"));
    if (!r.ok) return c.json({ error: r.error }, r.status);
    try {
      const probed = await probe()(r.url, r.apiKey);
      if (!probed.ok) {
        const { message, reason } = classify(probed);
        return c.json({ error: message, reason, url: r.url }, 200);
      }
      return c.json({ models: probed.models ?? [], url: r.url });
    } catch (e) {
      llmChatLog.warn("refresh-models failed", c.req.param("id"));
      return c.json({ error: "无法连接到该服务商。", reason: "unreachable", detail: safeMessage(e) }, 200);
    }
  });

  app.post("/api/llm-chat/providers/:id/test", async (c) => {
    if (rejectNonJson(c)) return c.json({ error: "Content-Type 必须是 application/json" }, 400);
    const r = resolveInstance(c.req.param("id"));
    if (!r.ok) return c.json({ error: r.error }, r.status);
    try {
      const probed = await probe()(r.url, r.apiKey);
      // 显示**实际发出的** URL,而不是另造一个「地址预览」去猜 ——
      // chatCompletionsUrl 并不服务 /ai-chat,显示它就是新造一个谎。
      return c.json({ ...classify(probed), url: r.url });
    } catch (e) {
      return c.json({
        ok: false,
        reason: "unreachable",
        message: "无法连接到该服务商。",
        url: r.url,
      });
    }
  });

  app.get("/api/llm-chat/model-catalog", async (c) => {
    const force = c.req.query("force") === "1";
    const r = await ensureModelCatalog({ providers: LLM_CHAT_PROVIDERS, force });
    return c.json({
      providers: r.catalog.providers,
      fetchedAt: r.catalog.fetchedAt,
      source: r.source,
      notes: CATALOG_NOTES,
      ...(r.error ? { error: r.error } : {}),
    });
  });
}
