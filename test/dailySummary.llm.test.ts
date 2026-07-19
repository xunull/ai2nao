import { describe, expect, it } from "vitest";
import {
  DailySummaryLlmError,
  type DailySummaryLlmConfig,
  buildDailySummaryLlmConfig,
  generateDailySummaryText,
} from "../src/dailySummary/llm.js";
import type { DailySummaryFacts } from "../src/dailySummary/types.js";

const FACTS: DailySummaryFacts = {
  date: "2026-07-19",
  totalCommands: 3,
  distinctCwds: 1,
  repoMatches: 1,
  outsideIndexedRepos: 0,
  sparse: false,
  recap: "worked in proj",
  topRepoLabel: "proj",
  nextUpHint: null,
  repoFacts: [],
};

const okResponse = () =>
  new Response(
    JSON.stringify({
      choices: [
        {
          message: {
            content: JSON.stringify({
              summary: "s",
              nextUp: null,
              workMode: null,
              primaryRepoLabel: null,
            }),
          },
        },
      ],
    }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );

describe("buildDailySummaryLlmConfig — 每日摘要复用 llm-chat", () => {
  it("llm-chat 为 null(设置页没配)→ 什么都没有", () => {
    const cfg = buildDailySummaryLlmConfig(null, 1000);
    expect(cfg.baseUrl).toBeNull();
    expect(cfg.model).toBeNull();
    expect(cfg.apiKey).toBeNull();
    expect(cfg.timeoutMs).toBe(1000);
  });

  it("从 llm-chat 映射 provider/model/baseURL/apiKey", () => {
    const cfg = buildDailySummaryLlmConfig(
      {
        provider: "deepseek",
        model: "deepseek-chat",
        baseURL: "https://api.deepseek.com",
        apiKey: "sk-x",
      },
      5000
    );
    expect(cfg.baseUrl).toBe("https://api.deepseek.com");
    expect(cfg.model).toBe("deepseek-chat");
    expect(cfg.apiKey).toBe("sk-x");
  });

  it("openai-compatible 无 key → local-no-key(本地 runtime 本就无需 key)", () => {
    const cfg = buildDailySummaryLlmConfig(
      {
        provider: "openai-compatible",
        model: "m",
        baseURL: "http://127.0.0.1:1234/v1",
        apiKey: null,
      },
      5000
    );
    expect(cfg.apiKey).toBe("local-no-key");
  });
});

describe("generateDailySummaryText — Bearer 头 + provider 感知 URL(本次修复)", () => {
  it("带 key 时发 Authorization Bearer,并给缺 /v1 的 base(如 DeepSeek)补上 /v1", async () => {
    let seenUrl = "";
    let seenAuth: string | null = null;
    const cfg = buildDailySummaryLlmConfig(
      {
        provider: "deepseek",
        model: "deepseek-chat",
        baseURL: "https://api.deepseek.com",
        apiKey: "sk-secret",
      },
      1000,
      async (url, init) => {
        seenUrl = String(url);
        seenAuth = new Headers(init?.headers).get("authorization");
        return okResponse();
      }
    );

    const out = await generateDailySummaryText("2026-07-19", FACTS, cfg);
    expect(out.summary).toBe("s");
    expect(seenUrl).toBe("https://api.deepseek.com/v1/chat/completions");
    expect(seenAuth).toBe("Bearer sk-secret");
  });

  it("apiKey 为 null 时不发 Authorization 头(此前它根本从不带 —— 正是本次修复)", async () => {
    let seenAuth: string | null = "sentinel";
    const cfg: DailySummaryLlmConfig = {
      baseUrl: "http://127.0.0.1:1234/v1",
      model: "m",
      apiKey: null,
      timeoutMs: 1000,
      fetchImpl: async (_url, init) => {
        seenAuth = new Headers(init?.headers).get("authorization");
        return okResponse();
      },
    };

    await generateDailySummaryText("2026-07-19", FACTS, cfg);
    expect(seenAuth).toBeNull();
  });

  it("llm-chat 未配置 → 抛 DailySummaryLlmError(降级到事实版 recap)", async () => {
    const cfg = buildDailySummaryLlmConfig(null, 1000);
    await expect(
      generateDailySummaryText("2026-07-19", FACTS, cfg)
    ).rejects.toBeInstanceOf(DailySummaryLlmError);
  });
});
