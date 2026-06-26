---
title: 成本计费：每段 token 怎么计价
category: Token 与成本
order: 30
---
# 成本计费：每段 token 怎么计价

> tokens-trend 的「显示 USD 成本」开关给出的是**等价 API 成本（估算）**——同样的
> 用量如果走 API 要花多少钱,**不是实际订阅扣费**。本文讲这个数字到底怎么算出来的:
> input 按三段、各用不同单价,output 单独算;不漏不重。
>
> 实现:`src/cost/pricing.ts`（`computeCost`）。价格来源见 §5。

---

## 1. 核心:input 不是一个单价,是三段

一个 token 是「输入」不代表它只有一个价。Anthropic / OpenAI 的提示缓存把输入拆成
三种,**单价差最多 10 倍**。成本必须按段乘:

```
成本 = 真实新增   × input 单价
     + 写 cache   × cache_creation 单价
     + 命中 cache × cache_read 单价
     + 输出       × output 单价

其中  真实新增 = input_tokens − 命中cache − 写cache
```

### 各段单价差多少（以 claude-sonnet-4-6 为例，$/1M token）

| 段 | 字段 | 单价 | 相对 input |
|---|---|---|---|
| 真实新增 input | `input − cache_read − cache_creation` | $3 | 1× |
| 写 cache（creation） | `cache_creation_input_tokens` | $3.75 | 1.25×（更贵） |
| 命中 cache（read） | `cache_read_input_tokens` | $0.3 | **0.1×（便宜 10 倍）** |
| 输出 output | `output_tokens` | $15 | 5× |

> ⚠️ 偷懒用「总 input × input 单价」会把占大头的命中 cache **高估约 10 倍**——长
> session 里 input 的 ~95% 都是命中 cache。所以分段是必须的,不是优化。

## 2. 计费完整性：不漏、不重

- **不漏**:`input_tokens`（融合值）= 真实新增 + 命中cache + 写cache。三段加起来
  正好是全部 input,一段不少。
- **不重**:真实新增 = input − 两段 cache,所以同一个 token **不会被算两次**。
- **output 算一次**:reasoning（Codex 的思考 token）是 output 的子集,已含在
  `output_tokens` 里,按 output 单价计一次,**不另外加价**。

代码（`computeCost`，单位 USD/token）:

```ts
const usd =
    components.fresh        * p.input          // 真实新增
  + components.cacheCreation * p.cacheCreation // 写 cache
  + components.cacheHit      * p.cacheRead     // 命中 cache
  + components.output        * p.output;       // 输出
```

## 3. Claude vs Codex 的差别

| | 输入分段 | 输出 |
|---|---|---|
| **Claude** | 真实新增 / 写cache / 命中cache（三段） | output |
| **Codex** | 真实新增 / 命中cache（**两段**,无「写cache」概念） | output |

- Codex 没有 cache-creation,所以 `cacheCreation = 0`,只有 `真实新增 = input − cached`
  和 `命中cache = cached`。
- 两边的 `total_tokens` 都是 `input + output`（cache、reasoning 都是各自的子集,不
  额外加总）。详见 [`docs/session-token-fields.md`](session-token-fields.md)。

## 4. 各段 token 从哪来

成本所需的分段在之前几次修复里已经全部拆好、入库:

| 段 | 来源 |
|---|---|
| Claude 命中/写 cache | `claude_session_token_usage.cache_read/creation_input_tokens`（v3） |
| Codex 命中 cache | `codex_session_token_usage.cached_input_tokens` / 事件表（v5） |
| 真实新增 | `input − 上面两段`（查询时算） |
| output | 各自 `output_tokens` |
| 模型（决定用哪套单价） | Claude `model` 列（主模型,v5）/ Codex `model` 列 |

成本查询按 `(bucket, model)` 聚合这些分段,再在 TS 侧乘单价（`priceCostByBucket` →
`computeCost`）。单价从不进 SQL。

## 5. 单价从哪来

`priceFor(model, priceMap)` 解析模型 → 单价。`priceMap` 是**内置静态快照 ← models.dev
同步覆盖**的合并表:

- **内置快照**:`src/cost/pricing.ts` 的 `MODEL_PRICES`（种子 + 离线兜底）。
- **同步**:`model.prices.sync` scheduler 任务从 models.dev 拉 Anthropic/OpenAI 价格
  入 `model_prices` 表,**同步价覆盖内置**（更新鲜）。详见
  [`docs/price-sync-design.md`](price-sync-design.md)。
- 单位换算:models.dev 给 $/1M token,入库 ÷1e6 转 $/token;`cache_write → cacheCreation`。
- UI「价格快照日期」= `MAX(synced_at)`,没同步过显示内置 `PRICE_SNAPSHOT_DATE`。

### 名字归一化

模型名带后缀（`claude-haiku-4-5-20251001`、`anthropic.…`、bedrock `-v1:0`），
`priceFor` 按「精确 → 剥前缀 → 剥 `-YYYYMMDD`/`-vN` → 最长前缀」匹配价格表 key。

## 6. 诚实边界

- **未知模型不猜**:匹配不到单价的模型**不计成本**,其 token 计入「未计价」并在页面标
  出（绝不按 $0 当已计价,也不瞎估）。
- **是估算,不是账单**:重度用户多为 Max / ChatGPT Pro **订阅**（月付封顶），按 token
  计费是 API 口径。这个数字的意义是「$200 订阅薅出了 $X 的等价 API 价值」,页面明确标注
  「等价 API 成本（非实际订阅扣费）· 价格快照 <日期>」。
- **cache_creation 5m/1h**:LiteLLM/models.dev 的 `cache_write` 是 5 分钟缓存价;我们
  不区分 1 小时缓存,统一按它算（对 1h 缓存略低估,估算可接受）。

## 7. 真实数据印证（6 月窗口，models.dev 同步后）

```
总成本   $8838  等价 API 成本
  Claude $4195
  Codex  $4643   （gpt-5.5 单价 $5/$30，cache_read $0.5/1M）
未计价   10.9M token（MiniMax / glm 等 models.dev 未收录的模型）
```

Claude 的 $4195 里绝大部分输入是命中 cache（按 $0.3/1M 而非 $3/1M 计）——这正是分段
计价的价值:同样 5.8B token,按真实分段算出来的成本,远低于「全按 input 单价」的虚高。

## 8. 相关文件

- `src/cost/pricing.ts` — `computeCost` / `priceFor` / 内置价格表（本文主角）
- `src/cost/priceStore.ts` — `loadPriceMap`（内置 ← DB 合并）
- `src/cost/modelsDevSync.ts` — models.dev 同步
- `src/workTokensTrend/queries.ts` — `priceCostByBucket`（按 bucket+model 聚合 → 计价）
- [`docs/cost-estimation-design.md`](cost-estimation-design.md) — 成本功能设计
- [`docs/price-sync-design.md`](price-sync-design.md) — 价格同步设计
- [`docs/session-token-fields.md`](session-token-fields.md) — token 字段（cache/reasoning 子集关系）
- [`docs/claude-token-double-count.md`](claude-token-double-count.md) — token 去重（计费前提：数对了才能算对钱）
