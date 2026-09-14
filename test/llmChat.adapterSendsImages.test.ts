import { afterEach, describe, expect, it, vi } from "vitest";
import type { Message } from "@ag-ui/client";
import { streamText } from "ai";
import { agUiMessagesToModelMessages } from "../src/llmChat/copilotRuntime.js";
import {
  LLM_CHAT_DEFAULT_BASE_URLS,
  LLM_CHAT_PROVIDERS,
  PROVIDER_ADAPTER_SENDS_IMAGES,
  type LlmChatProvider,
} from "../src/llmChat/document.js";
import { createChatLanguageModel } from "../src/llmChat/model.js";

/**
 * **适配器表必须与已装适配器的真实行为一致。**
 *
 * `PROVIDER_ADAPTER_SENDS_IMAGES` 描述的是「我们装的 AI SDK 适配器发不发得出图」,
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

async function captureRequestBodies(provider: LlmChatProvider): Promise<string[]> {
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

  const messages = agUiMessagesToModelMessages([
    {
      id: "m1",
      role: "user",
      content: [
        { type: "text", text: USER_TEXT },
        { type: "image", source: { type: "data", value: PNG_BASE64, mimeType: "image/png" } },
      ],
    } as unknown as Message,
  ]);

  const result = streamText({
    model: createChatLanguageModel({
      provider,
      // openai-compatible 没有默认地址;给一个不会被真正访问的本地地址。
      baseURL: LLM_CHAT_DEFAULT_BASE_URLS[provider] || "http://127.0.0.1:9/v1",
      model: "stub-model",
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

describe("适配器表与已装适配器的真实行为一致", () => {
  it.each(LLM_CHAT_PROVIDERS)("%s", async (provider) => {
    const bodies = await captureRequestBodies(provider);
    // 先证明截到的就是这一轮的真实请求,否则下面的比较是空转。
    expect(bodies, `${provider}: 应恰好发出一次请求`).toHaveLength(1);
    expect(bodies[0]).toContain(USER_TEXT);
    expect(bodies[0]!.includes(PNG_IN_REQUEST), `${provider}: 请求体里有没有图`).toBe(
      PROVIDER_ADAPTER_SENDS_IMAGES[provider]
    );
  });
});
