---
title: 设计：从 models.dev 同步模型价格（scheduler 任务）
category: 数据源与同步
order: 90
---
# 设计：从 models.dev 同步模型价格（scheduler 任务）

> 状态：**设计已锁定，待实现**（office-hours 2026-06-19）。下一步 `/plan-eng-review`。
>
> 加一个 scheduler 任务，从 [models.dev](https://models.dev) 同步 Anthropic + OpenAI
> 的模型价格到本地表，让成本估算的价格**自动保持最新、自动覆盖新模型**（包括
> gpt-5.5 → 修掉当前 Codex 成本 $0 的缺口）。

---

## 1. 背景 / 前提更正

成本估算（`docs/cost-estimation-design.md`）目前用**仓库内置静态价格表**。两个痛点:
- `gpt-5.5`（Codex 主模型）当时手填留空 → Codex 成本全 $0 / 未计价。
- 价格要手动更新,会过期。

**前提更正（office-hours 中纠正）**:一度以为 models.dev 没有 gpt-5.5。错了——
models.dev 的 OpenAI 页明确有 `gpt-5.5`（**$5 / $30** input/output 每 1M），还有
5.1/5.2/5.3/5.4 全系。（我用 WebFetch 抓 `api.json` 时,快速摘要对几 MB 的 JSON
会截断、漏看深层 key;真正的同步代码在 Node 里完整 `fetch`+`JSON.parse`,不会漏。）

所以 models.dev 同步**能**填上 gpt-5.5，前提成立。

## 2. models.dev 数据结构（已核实）

`https://models.dev/api.json` 顶层按 provider id 分;每个 provider 有 `.models`;
每个 model 有:

```json
"cost": { "input": 5, "output": 30, "cache_read": 0.5, "cache_write": 6.25 }
```

- 单位 **$ / 1M token** → 入库前 **÷ 1e6** 转成 $/token。
- 字段映射:`cache_write` → 我们的 `cacheCreation`,`cache_read` → `cacheRead`。
- 某些模型可能缺 `cache_read`/`cache_write` → 当 0(无 cache 成本,仍可计价)。

## 3. 架构

```
scheduler 任务 "model-price-sync"
  category=model_cache · sensitivity=low · 默认周更 · 支持手动触发
   │  fetch https://models.dev/api.json   （失败→status=failed,保留上次,不崩）
   │  for provider in {anthropic, openai}:
   │    for model in provider.models:
   │      upsert(provider, model_id, input/1e6, output/1e6,
   │             cache_read/1e6, cache_write/1e6, synced_at=now)
   ▼
新表 model_prices(
  provider TEXT, model_id TEXT,
  input REAL, output REAL, cache_read REAL, cache_creation REAL,
  source TEXT DEFAULT 'models.dev', synced_at TEXT,
  PRIMARY KEY(provider, model_id))
   │
   ▼  pricing.ts 改为 DB 优先:
   loadPriceMap(db) = 内置静态表 ← 被 model_prices 覆盖（同 key 同步价更新）
   priceFor(model, priceMap)：归一化模型名后查 priceMap → null
   UI「价格快照日期」= MAX(synced_at)，从没同步过就显示「内置 <PRICE_SNAPSHOT_DATE>」
```

**内置静态表保留**:作为 (a) 首次/离线未同步时的种子,(b) models.dev 没有的模型的
兜底。同步价覆盖内置(更新鲜)。

## 4. 关键决策

- **解析顺序:DB 同步优先,内置兜底**。同步是为了新鲜,所以同 key 时同步价赢;内置
  补 models.dev 缺的。（若将来要手动钉死某个价,再加一个 source='manual' 优先级,本期不做。）
- **只同步 anthropic + openai 两个 provider、只取 4 个 cost 字段**。不抓 context window
  等其它元数据（超范围）。
- **网络**:出站到 models.dev。本项目已有出站先例（DashScope embedding）。低敏感、
  opt-in 的 scheduler 任务。离线/失败时保留上次同步 + 内置兜底,任务 status=failed 不崩。
- **诚实**:同步价带 `synced_at`;UI 显示同步日期;匹配不到的模型仍「—」。

## 5. 留给 /plan-eng-review 的点

1. **`computeCost` 签名**:现在是 `computeCost(components, model)` 内部调 `priceFor`
   读静态表。要改成接受一个**已合并的 price map**（DB 覆盖内置），在成本查询层用 `db`
   构一次 map 传进去。这是主要改动点。
2. **models.dev 的 model key 形状**:`id` 是 `anthropic/claude-opus-4-5`（带前缀）还是
   `.models` 的 key 是裸 id?入库用裸 id;我们的 `priceFor` 已做前缀/日期归一化,两种都能配。
3. **缺 cache 字段**:`cache_read`/`cache_write` 缺失时入库 0。
4. **fetch 失败/超时**:超时上限 + 失败保留上次 + status=failed,不影响成本展示（用旧值/内置）。
5. **migration + 是否需要 rule_version**:只是新表 + 读取改造,**不动 token 解析**,无需
   token rule_version 冲;只要一个建表 migration。

## 6. 范围边界（明确不做）

- 不抓 anthropic/openai 以外的 provider。
- 不抓价格以外的元数据（context window、modalities 等）。
- 不做手动改价 UI（本期靠内置静态表手填兜底）。
- 不做历史价格版本（只存最新一次同步）。

## 7. 相关文件（实现时会碰）

- `src/scheduler/taskDefinitions.ts` — 注册 `model-price-sync` 任务
- `src/cost/modelsDevSync.ts`（新）— fetch + 解析 + upsert
- `src/cost/pricing.ts` — `loadPriceMap(db)` + `priceFor(model, map)`（DB 优先）
- `src/cost/priceStore.ts`（新）— model_prices 读写
- `src/store/migrations.ts` — `model_prices` 建表
- `src/workTokensTrend/{queries,service}.ts` — 成本查询用合并 price map
- `web/src/pages/WorkTokensTrend.tsx` — 快照日期改读 synced_at
- [`docs/cost-estimation-design.md`](cost-estimation-design.md) — 上游成本功能
- [`docs/token-tracking-ecosystem-comparison.md`](token-tracking-ecosystem-comparison.md) — 成本是「它们有」的功能
