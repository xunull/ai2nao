# 设计：tokens-trend 可选 USD 成本估算

> 状态：**设计已锁定，待实现**（office-hours 2026-06-19）。下一步 `/plan-eng-review`。
>
> 在 `/dashboard/tokens-trend` 上加一个**可选、默认关**的「等价 API 成本」估算，
> 复用已经拆好的 token 分段（真实新增 / 写cache / 命中cache / output）按模型单价算。

---

## 1. 为什么 / 诚实性框架（已达成共识的前提）

本项目明确写了「不估算成本」。这个功能是**明确地反转**这条原则，所以加的方式必须
守住诚实底线:

1. **opt-in、默认关、清楚标注「估算」**——不污染现有「真实 token」口径。和 cache
   toggle 并列一个「显示 USD 成本」开关。
2. **数字是「等价 API 成本」，不是账单**。重度用户（本机 Claude 5.5B + Codex
   5.5B token）是 **Max + ChatGPT Pro 订阅**（月付封顶），不是按量付费。按 API 单价
   这是每月几千美元，但实际只付 ~$200。所以这个数字的**真正价值**是:
   > 「我用 $200 的订阅，薅出了 $X 的 API 等价价值。」
   页面必须标注「**等价 API 成本（非实际订阅扣费）· 价格快照 YYYY-MM-DD**」。
3. **未知一律「—」不猜**。匹配不到价格的模型显示「—」，不按 0、不瞎估（延续项目
   的「不猜测缺失值」原则）。

## 2. 准确度决策：逐 session 主模型（B）

真实数据（309 个有 model 的 Claude session）:
- **96% 单模型**，只有 **4% 混用**；混用的是超大 session 但占比小。
- 模型权重:Opus 4.7 = 69%、Opus 4.8 = 20%、Sonnet 4.6 = 10%（Opus 共 ~89%）。

决策:**给每个 session 记一个「主模型」，按它的单价计价**。
- 96% 的 session 分毫不差；剩 4% 混用的把次模型按主模型算，偏差落在「这数字本就是
  估算」的噪声以内。
- 放弃「逐模型拆 token」（会给整条 token 管线加一个 model 维度，~12-15 文件），因为
  它换来的精度提升**小于估算自身的误差棒**（订阅 vs API 的本质差异远大于这点）。

## 3. 数据流

```
Claude jsonl  message.model（每条）          Codex: 表里已有 model（基本就 gpt-5.5）
   │  解析时取「主模型」= 该 session output_tokens 最多的 model
   ▼
claude_session_token_usage.model（新列，migration + rule_version 冲 + 重解析）
   │
   ▼  定价模块 pricing.ts（仓库内置静态快照）
   model → { input, output, cache_read, cache_creation } 每 token 单价
   │
   ▼  成本公式（按 session 的 model 单价）
   cost = 真实新增  × input_rate
        + 写cache   × cache_creation_rate
        + 命中cache × cache_read_rate          ← 命中 cache 便宜 ~10x，这步是关键
        + output    × output_rate
   （Claude: 真实新增 = input − cache_read − cache_creation；
     Codex: 真实新增 = input − cached，无 cache_creation；reasoning 已含在 output）
   │
   ▼  聚合 + 前端
   按 (bucket, model) 汇总成本 → 总成本卡 / 柱状图按成本 / 每来源成本
```

## 4. 价格表:仓库内置静态快照

不运行时拉 LiteLLM。理由:本地优先要离线、我们只见 ~5 个模型、内置带快照日期正好
满足诚实标注。

`src/cost/pricing.ts`（示意，单位 USD / token，来源 LiteLLM
`model_prices_and_context_window.json`，标注快照日期）:

```ts
export const PRICE_SNAPSHOT_DATE = "2026-06-19";
export const MODEL_PRICES: Record<string, ModelPrice> = {
  "claude-opus-4-8":   { input: 5e-6, output: 25e-6, cacheRead: 5e-7, cacheCreation: 6.25e-6 },
  "claude-opus-4-7":   { /* ... */ },
  "claude-sonnet-4-6": { input: 3e-6, output: 15e-6, cacheRead: 3e-7, cacheCreation: 3.75e-6 },
  "claude-haiku-4-5":  { /* ... */ },
  "gpt-5.5":           { input: ..., output: ..., cacheRead: ... }, // Codex 无 cacheCreation
};
// 匹配不到 → 返回 null → 前端显示「—」，不计入总成本
```

> ⚠️ 上面的具体数值是占位，实现时从 LiteLLM 当天快照填真值。字段名对齐 LiteLLM:
> `input_cost_per_token` / `output_cost_per_token` / `cache_read_input_token_cost` /
> `cache_creation_input_token_cost`。

## 5. 留给 /plan-eng-review 的点

1. **成本聚合的查询形状**：trend 按 bucket 聚合 token，但定价要 model。需要 bucket
   查询 `GROUP BY model`（或按 session 算好成本再分桶）。Codex 走事件表，事件不带
   model，要 JOIN 回 session 表拿 model。这是本功能最需要 eng-review 拍的地方。
2. **主模型口径**：用 output_tokens 最多的 model 作主模型（已定）；确认极端混用
   session 的取值不会突变。
3. **migration / rule_version**：Claude `model` 列 + `CLAUDE_TOKEN_USAGE_RULE_VERSION`
   冲一版自愈重解析（同 codex cached 的路子）。
4. **成本与 cache toggle 的关系**：成本是从**原始分段**算的（各段不同单价），**不**受
   cache toggle 影响——cache toggle 只改 token 显示。两个开关独立。
5. **快照过期提示**：价格快照超过 N 天时，前端在成本旁标注「价格可能已过期」。

## 6. 范围边界（明确不做）

- 不做「逐模型拆 token」（已否决，过度精确）。
- 不做运行时拉 LiteLLM（用内置快照）。
- 不做订阅额度/真实账单对账（我们只能看 token，看不到 Anthropic/OpenAI 的真实扣费）。
- 不做历史价格回溯（某条 3 个月前的 token 用当时价）——统一用当前快照,并标注。

## 7. 相关文件（实现时会碰）

- `src/store/migrations.ts` — Claude `model` 列（vNN）
- `src/claudeCodeHistory/normalize.ts` — 解析主模型
- `src/claudeTokenUsage/{types,refresh,queries}.ts` — 存 model + rule_version 冲
- `src/cost/pricing.ts` — 新：内置价格表 + 成本公式
- `src/workTokensTrend/{queries,types,service}.ts` — 成本聚合
- `web/src/pages/WorkTokensTrend.tsx` — 「显示 USD 成本」开关 + 成本展示
- [`docs/token-tracking-ecosystem-comparison.md`](token-tracking-ecosystem-comparison.md) — 成本是「它们有、我们没有」的唯一常见功能
- [`docs/session-token-fields.md`](session-token-fields.md) — token 字段 / model 字段来源
