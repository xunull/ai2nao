import { afterEach, describe, expect, it, vi } from "vitest";
import type { Message } from "@ag-ui/client";
import { streamText } from "ai";
import { agUiMessagesToModelMessages } from "../src/llmChat/copilotRuntime.js";
import {
  LLM_CHAT_DEFAULT_BASE_URLS,
  LLM_CHAT_PROVIDERS,
  PROVIDER_ADAPTER_CAPABILITIES,
  type LlmChatProvider,
} from "../src/llmChat/document.js";
import { createChatLanguageModel } from "../src/llmChat/model.js";

/**
 * **适配器表必须与已装适配器的真实行为一致。**
 *
 * `PROVIDER_ADAPTER_CAPABILITIES[p].sendsImages` 描述的是「我们装的 AI SDK 适配器发不发得出图」,
 * 这是依赖版本的属性,不是厂商能力:`@ai-sdk/deepseek` 2.0.35 把图静默丢掉
 * (请求照发、费用照扣),2.0.64 就发得出去。以前这张表只靠注释提醒「升级时重验」,
 * 其余测试只看表里填的值 —— 2026-09-14 升级后表已经过期,那些测试照样全绿。
 *
 * 这里走生产路径 `agUiMessagesToModelMessages` → `createChatLanguageModel` →
 * `streamText`,只把全局 fetch 换成假的,截下适配器真正要发出去的请求体,
 * 看图的字节在不在里面。不联网、不花钱;表与行为对不上就红。
 */

// 1×1 PNG。必须是真实文件头:我们交给 AI SDK 的 image part 不带 mediaType,
// 由它按字节签名识别类型。
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
// 适配器会把字节重新编码;用规范化后的编码去比,不依赖上面那串恰好规范。
const PNG_IN_REQUEST = Buffer.from(PNG_BASE64, "base64").toString("base64");
const USER_TEXT = "图里是什么";

afterEach(() => {
  vi.unstubAllGlobals();
});

/** 默认那条带图的用户消息 —— 原有 7 个用例用的就是它,参数化之后行为不变。 */
function defaultHistory(): Message[] {
  return [
    {
      id: "m1",
      role: "user",
      content: [
        { type: "text", text: USER_TEXT },
        { type: "image", source: { type: "data", value: PNG_BASE64, mimeType: "image/png" } },
      ],
    } as unknown as Message,
  ];
}

async function captureRequestBodies(
  provider: LlmChatProvider,
  history: Message[] = defaultHistory(),
  // 模型 id 会改变适配器行为,不只是个占位符:`@ai-sdk/deepseek` 只对 V4 系列
  // (`deepseek-v4*` / `deepseek-flash*` / `deepseek-pro*`)回传历史里的
  // reasoning_content,其余一律裁掉。默认值保持 stub-model,原有 7 个用例不受影响。
  model = "stub-model"
): Promise<string[]> {
  const bodies: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: unknown, init?: RequestInit) => {
      bodies.push(typeof init?.body === "string" ? init.body : "");
      // 400 不可重试:适配器拿到就结束,不会发第二次。
      return new Response(JSON.stringify({ error: { message: "stubbed" } }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    })
  );

  // **必须把 provider 传进去** —— 不传就走 `none` 档,三档回传一行都不会执行,
  // 而请求体照样发得出去、断言照样能写,只是测了个寂寞。
  const messages = agUiMessagesToModelMessages(history, provider);

  const result = streamText({
    model: createChatLanguageModel({
      provider,
      // openai-compatible 没有默认地址;给一个不会被真正访问的本地地址。
      baseURL: LLM_CHAT_DEFAULT_BASE_URLS[provider] || "http://127.0.0.1:9/v1",
      model,
      apiKey: "test-key",
    }),
    messages,
    maxRetries: 0,
    onError: () => {},
  });
  for await (const _part of result.fullStream) {
    // 只为把流跑完;请求体已经在假 fetch 里截下了。
  }
  return bodies;
}

describe("流式请求都要厂商报用量", () => {
  it.each(LLM_CHAT_PROVIDERS)("★ %s:请求体带 stream_options.include_usage —— 否则这一家的账全是「未知」", async (provider) => {
    const bodies = await captureRequestBodies(provider);
    expect(bodies).toHaveLength(1);
    const body = JSON.parse(bodies[0]!) as { stream?: boolean; stream_options?: { include_usage?: boolean } };
    expect(body.stream).toBe(true);
    expect(body.stream_options?.include_usage).toBe(true);
  });
});

describe("适配器表与已装适配器的真实行为一致", () => {
  it.each(LLM_CHAT_PROVIDERS)("%s", async (provider) => {
    const bodies = await captureRequestBodies(provider);
    // 先证明截到的就是这一轮的真实请求,否则下面的比较是空转。
    expect(bodies, `${provider}: 应恰好发出一次请求`).toHaveLength(1);
    expect(bodies[0]).toContain(USER_TEXT);
    expect(bodies[0]!.includes(PNG_IN_REQUEST), `${provider}: 请求体里有没有图`).toBe(
      PROVIDER_ADAPTER_CAPABILITIES[provider].sendsImages
    );
  });
});

/**
 * 思考回传的三档,按**真实请求体**核对 —— 与上面那条测试共用同一套假 fetch 手法。
 *
 * 为什么必须看请求体而不是看函数返回值:回传的最终形态是适配器转出来的
 * (`reasoning-part` → `reasoning_content`),中间隔着一层转换。只断言
 * `agUiMessagesToModelMessages` 的输出,等于假定那层转换如我所想 ——
 * 而这一整天里,"如我所想"的形状已经错过三次。
 */
const THINKING = "我先拆一下题目";
const VISIBLE = "答案在这";
/** MiniMax 的形状:思考写在正文里,回传时 content 必须原样。 */
const MINIMAX_RAW = `<think>\n${THINKING}\n</think>\n\n${VISIBLE}`;

function historyWithReasoning(reasoningProvider: LlmChatProvider): Message[] {
  return [
    { id: "u1", role: "user", content: "问题" },
    {
      id: "r:run-1:answer:0",
      role: "reasoning",
      content: THINKING,
      ai2naoReasoning: {
        v: 1,
        runId: "run-1",
        assistantMessageId: "a:run-1:answer:0",
        callId: "c:run-1:answer:0:0",
        provider: reasoningProvider,
        source: "reasoning-stream",
        durationMs: 1,
      },
    },
    {
      id: "a:run-1:answer:0",
      role: "assistant",
      content: VISIBLE,
      ai2naoProtocol: { v: 1, content: MINIMAX_RAW },
    },
    { id: "u2", role: "user", content: "追问" },
  ] as unknown as Message[];
}

describe("思考回传三档 —— 按真实请求体核对", () => {
  it("deepseek V4:思考还原成 reasoning part,适配器转成 reasoning_content", async () => {
    // **必须用 V4 的模型 id。** 适配器里 `isDeepSeekV4Model` 认的是
    // `deepseek-v4*` / `deepseek-flash*` / `deepseek-pro*`;非 V4 会把
    // 最后一条 user 之前的 assistant 上的 reasoning_content 整个裁掉
    // (`if (index <= lastUserMessageIndex && !isDeepSeekV4)`)。
    // 这不是 bug,是 DeepSeek 协议本身只让 V4 收历史思考。
    const bodies = await captureRequestBodies(
      "deepseek",
      historyWithReasoning("deepseek"),
      "deepseek-v4-flash"
    );
    expect(bodies).toHaveLength(1);
    const body = bodies[0]!;
    // 非空转:思考文本确实出现在发出去的请求里。
    expect(body).toContain(THINKING);
    // 而且是走 reasoning_content 这条道,不是被当成正文塞进 content。
    expect(body).toContain("reasoning_content");
  });

  it("deepseek 非 V4:我们照发,适配器按协议裁掉 —— 别误判成我们没发", async () => {
    const bodies = await captureRequestBodies(
      "deepseek",
      historyWithReasoning("deepseek"),
      "deepseek-chat"
    );
    expect(bodies).toHaveLength(1);
    // 请求体里没有 reasoning_content,**但这不等于我们没生成 reasoning part** ——
    // 中间产物里是有的,是适配器按 DeepSeek 协议裁的。这条测试的用意就是把
    // 「看到请求体里没有就以为实现坏了」这个误判钉死:我排查这个 bug 时正是
    // 先误判成「适配器不支持,该把表改成 none」,查了 dist 才发现它明明支持。
    expect(bodies[0]!).not.toContain("reasoning_content");
    // 正文照常发,别把整条 assistant 弄丢了。
    expect(bodies[0]!).toContain(VISIBLE);
  });

  it("minimax:content 是含 <think> 的厂商原样，逐字节相同", async () => {
    const bodies = await captureRequestBodies("minimax", historyWithReasoning("minimax"));
    expect(bodies).toHaveLength(1);
    const body = bodies[0]!;
    // 逐字节:把原文按 JSON 字符串编码后,必须原样出现在请求体里。
    // 这是设计里「与原始流拼接结果逐字节相同」那条验收的落点。
    const encoded = JSON.stringify(MINIMAX_RAW).slice(1, -1);
    expect(body).toContain(encoded);
    // 反向钉住:**不能**是剥离后的展示文本单独出现而原文丢失。
    expect(body).toContain("<think>");
  });

  it("其他厂商:思考一个字都不回传", async () => {
    const bodies = await captureRequestBodies("openai", historyWithReasoning("openai"));
    expect(bodies).toHaveLength(1);
    const body = bodies[0]!;
    expect(body).not.toContain(THINKING);
    expect(body).not.toContain("reasoning_content");
    // 正文照常发,别把整条 assistant 也弄丢了。
    expect(body).toContain(VISIBLE);
  });

  it("换了厂商：上一家的思考不能捎过去", async () => {
    // 思考行是 deepseek 产生的,这一轮却发给 deepseek 之外的档位组合:
    // 用 deepseek 当前 provider、但思考行标着 minimax,配对必须失败。
    const bodies = await captureRequestBodies("deepseek", historyWithReasoning("minimax"));
    expect(bodies).toHaveLength(1);
    // **这条最隐蔽** —— 带错的思考在请求体里看不出异常,只会让对面收到
    // 一段它从没说过的推理,而账单照付。
    expect(bodies[0]!).not.toContain(THINKING);
  });

  it("protocol-content 档原文缺失：整条不回传，不退回展示文本", async () => {
    const history = historyWithReasoning("minimax");
    // 模拟 blob 被手工删掉:只留引用,取不回来。
    (history[2] as unknown as { ai2naoProtocol: unknown }).ai2naoProtocol = {
      v: 1,
      blobSha256: "0".repeat(64),
    };
    const bodies = await captureRequestBodies("minimax", history);
    expect(bodies).toHaveLength(1);
    const body = bodies[0]!;
    // 退化成用展示文本顶替的话,这里会是 VISIBLE —— 那等于把剥离后的文本
    // 当原文发出去,官方要求 content 不得修改,差一个字节都不算数。
    expect(body).not.toContain("<think>");
    expect(body).toContain(VISIBLE);
  });
});
