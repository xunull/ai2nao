---
title: Token 趋势页柱图口径（claude / codex 各含什么）
category: Token 与成本
order: 100
---
# Token 趋势页柱图口径（claude / codex 各含什么）

> tokens-trend（Token 趋势）页底部的堆叠柱图，每根 claude / codex 柱子里到底加了哪些 token？
>
> 结论：柱图是**全量口径（默认含 cache、含推理）**，由顶部「计入缓存命中」开关调节。它跟
> 工作看板 headline 那个「只 input+output」的口径**刻意不同** —— 柱图看「吞吐总量 + 缓存占比」，
> 看板看「真实工作量」。两页数字别直接对。
>
> 落地：`web/src/pages/WorkTokensTrend.tsx`（`chartData` map + `<Bar dataKey>`）、`src/workTokensTrend/types.ts`。

---

## 1. 柱子画的是哪个字段

柱图 `dataKey` 是 `claudeFullTokens` / `codexFullTokens`（成本模式下切成
`claudeCostUsd` / `codexCostUsd`）。它们基于每个 bucket 的 `claudeTokens` / `codexTokens`
再按缓存开关扣减：

```
claudeFullTokens = includeCache ? claudeTokens
                                : max(0, claudeTokens - claudeCacheReadInputTokens)
codexFullTokens  = includeCache ? codexTokens
                                : max(0, codexTokens  - codexCachedInputTokens)
```

`claudeTokens = claudeInputTokens + claudeOutputTokens`，其中 **claudeInputTokens 是 FUSED
三合一**（fresh + cache_creation + cache_read）。`codexTokens = codexInputTokens + codexOutputTokens`。

## 2. Claude 柱 = `claudeTokens`

claude 的「输入」是 FUSED，所以柱子里含：

| 成分 | 字段 | 默认（计入缓存 ON） | 开关 OFF |
|---|---|---|---|
| 真实新增输入 | fresh input | ✅ | ✅ |
| **写入 cache** | cache_creation | ✅ | ✅ **仍在** |
| **命中 cache** | cache_read | ✅ | ❌ 减掉 |
| 输出 | output | ✅ | ✅ |

## 3. Codex 柱 = `codexTokens`

| 成分 | 字段 | 默认 ON | 开关 OFF |
|---|---|---|---|
| 真实新增输入 | fresh input | ✅ | ✅ |
| **命中 cache** | codexCachedInputTokens | ✅ | ❌ 减掉 |
| 输出（**含推理 reasoning**） | output | ✅ | ✅ |

## 4. 三个容易踩的点

1. **默认是「全量含 cache」。** 顶部「计入缓存命中」开关默认 ON，柱图默认把 cache_read /
   cached 也画进去。这跟工作看板 token 数（input+output，不含 cache，见
   `docs/opencode-token-accounting.md`）口径不同，两页数字不能直接对。
2. **开关 OFF 只减「命中读」，不减「写入」。** claude 关掉后 `cache_creation（写入 cache）`
   仍在柱子里，只减 `cache_read（命中回放）`。所以 claude「不含命中 cache」≠「不含所有 cache」。
   codex 没有写入 cache 概念，OFF 就把它的 cache 全减了。
3. **codex 输出恒含推理**；且柱图**只统计 `token_status='full'` 的 session**（partial /
   unknown / error 不进柱，走覆盖率 UI，柱图区标题写着「仅统计完整 token 的 session」）。

## 5. 为什么和工作看板口径不同（有意为之）

- **趋势页柱图**：全量含 cache（可用开关扣命中）→ 回答「这段时间吞吐了多少、缓存占比多高」。
- **工作看板 headline**：只 input+output → 回答「模型实际产出了多少真实新内容」（工作量口径）。
- **成本视图**：柱图切 `*CostUsd`（按价加权，cache 便宜 10 倍、cache_creation 反而更贵都摆平）
  → 回答「花了多少钱」。

业界本就没有单一「total」标准，而是按问题拆口径（见
`~/.gstack/projects/xunull-ai2nao/20260701-design-token-caliber.md`）。趋势柱图故意选「全量 +
可扣缓存」，因为趋势页的价值正是让缓存占比这件事可见。

## 6. 相关

- 代码：`web/src/pages/WorkTokensTrend.tsx`（`chartData` map、`deriveTotals`、`CacheToggle`、
  `<Bar dataKey>`）、`src/workTokensTrend/types.ts`（Bucket 字段 + claudeInputTokens FUSED 注释）。
- 口径对照：`docs/opencode-token-accounting.md`（看板 = input+output）、`docs/session-token-fields.md`、
  `docs/token-usage-pipeline.md`。
