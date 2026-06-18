# Token 统计开源生态对照：ai2nao vs ccusage 等

> 调研其他开源项目怎么统计 Claude Code / Codex 的 token 消耗,和 ai2nao 做对照。
> 结论:我们这几天独立排查出的三个核心 bug(Claude message 去重、Codex delta、
> 跨天分桶),全都对得上主流项目 ccusage 的公开 issue,而且我们的修法正好是它们
> 推荐的正解。
>
> 调研时间:2026-06-18。

---

## 1. 生态全景

| 项目 | 形态 | 架构 | 成本 |
|---|---|---|---|
| [ccusage](https://github.com/ryoppippi/ccusage)（最主流） | CLI `npx ccusage` | 无持久库,每次读 JSONL 现算日/周/月/session 报表 | **算 USD** |
| [toktrack](https://github.com/mag123c/toktrack) | Rust CLI/看板 | **持久 cache**（Claude 删文件也不丢历史） | 算 |
| [codex-usage-tracker](https://github.com/CasperKristiansson/codex-usage-tracker) | 本地看板 | **SQLite** 存 token+元数据（架构跟 ai2nao 最像） | 算 |
| [tokscale](https://github.com/junhoyeo/tokscale) | CLI + 排行榜 | 多源,2D/3D 贡献图 | — |
| ai-token-monitor / codex-trace / [ccost](https://github.com/carlosarraes/ccost) | 菜单栏 / 查看器 / 成本 | 各有侧重 | ccost 算 |

架构上 ai2nao（SQLite 索引 + scheduler + web 看板 + **不估算成本**）最接近
codex-usage-tracker / toktrack。

数据来源所有项目一致:本机 `~/.claude/projects/**/*.jsonl`（Claude Code）+
`~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`（Codex），不上传、不需要 API key。

---

## 2. 关键对照:我们修的 bug 正是它们踩过的坑

ai2nao 这几天的每个修复都对得上主流项目的已知 issue,而且落在了它们推荐的正解上。

### 2.1 Claude 同一 message 重复计数 — ai2nao `f6c03ae`

ccusage [issue #888](https://github.com/ryoppippi/ccusage/issues/888) +
[gille.ai 分析](https://gille.ai/en/blog/claude-code-jsonl-logs-undercount-tokens/)
描述的现象和我们一模一样:

> Claude Code 流式写入,一次请求产生 **2–10 条**相同 `message.id` / `requestId`
> 的 JSONL 行;**51–55% 是重复行**,**75% 的行 `input_tokens` = 0 或 1**（流式
> 占位符,请求完成后不回填）。

- **推荐解法**:按 `message.id` 去重、**取最大/最终值**（"Use the highest value"）。
- **ai2nao 的做法**:`f6c03ae` —— 按 `message.id` 去重、**每字段取 max**。✅ 一致。

**有意思的是方向相反**:
- ccusage 的 bug 是「只取第一条占位符 → **少算**」（input 偏差 100–174x）。
- ai2nao 的 bug 是「逐行累加 → **多算 ~2x**」。

两个都错,但**正解一样**（max per `message.id`）。ai2nao 还更稳一点:我们用
**融合 input**（`input + cache_creation + cache_read`），而 cache 字段是准的
（博客确认 cache「~1x 准确」），所以绕开了它们头疼的「raw `input_tokens` 占位符
100x 偏差」。取 max 同时避开了**多算**（逐行求和）和**少算**（取第一条占位符）。

> 详见 [`docs/claude-token-double-count.md`](claude-token-double-count.md)。

### 2.2 Codex 累计 total_token_usage 重复计数 — ai2nao 的 delta 处理

ccusage [issue #884](https://github.com/ryoppippi/ccusage/issues/884) 的复现用例:

```json
"total_token_usage":{"input_tokens":100,"cached_input_tokens":20,
                     "output_tokens":30,"reasoning_output_tokens":5,"total_tokens":130}
```

- **它的 bug**:无脑取 `last_token_usage`,累计没变也重复计 → 翻倍（260）。
- **推荐解法**:用 `total_token_usage` 的**差值（delta）**,累计没动就贡献 0,
  只在缺失时回退 `last_token_usage`。实测 delta 法 **100% 准**,naive 法只 **18%**
  （131/732 sessions）。
- **ai2nao 的做法**:`usageFromTokenCountPayload` 的 increment/total 分支 +
  `deltaUsage`（累计差值，非单调时 clamp）。✅ 一直就是这么做的。

### 2.3 Codex `cached_input_tokens` — ai2nao `ff1af8a`

上面那个字段里就有 `cached_input_tokens` —— ccusage 早就读了。ai2nao 之前没采
（input 已含它,总数不受影响,直到 cache toggle 才需要拆分），`ff1af8a` 补齐后对齐。

> 详见 [`docs/session-token-fields.md`](session-token-fields.md)。

### 2.4 跨天 session 折叠 — ai2nao `0522c01`

ccusage 天生**按每条 `token_count` 事件的时间戳**分桶（逐行读），所以**不会**有
「跨天 resume 折叠到一天」的问题。ai2nao 原来是「每 session 一行 + `last_updated_at`」
才中招,用**逐事件表**（`codex_token_usage_event`）修好后,现在和它们的事件级粒度
对齐了。

> 详见 [`docs/codex-token-daily-bucketing.md`](codex-token-daily-bucketing.md)。

---

## 3. ai2nao 和它们的主要差异

### 3.1 成本估算（它们有、我们没有）

ccusage / ccost / toktrack 等都算 **USD 成本**（靠 LiteLLM / Anthropic 定价表）。
ai2nao **刻意不估算**（页面注明「不估算成本,不猜测缺失值」）。这是取舍——真实
token 可信,USD 需要外部定价表且随模型/折扣变动。

**可选改进**:加一个**可选**的成本视图（定价表是现成的，cache_read 通常按更低
价率计费，正好我们已经把 cache 拆出来了）。

### 3.2 cache 命中开关（我们有、少见）

大多数工具只把 cache **分列展示**（ccusage 单独列 cache creation / read）。
ai2nao 的「一键把 cache 命中从总量里剔除」toggle（Claude + Codex 两边对等）比较
少见,算我们的特色。

### 3.3 「真实计费 vs 真实工作量」双口径

由于 cache 命中占 input 的 ~95%（Claude 和 Codex 都是），「总 token」这个数字
绝大部分是缓存重放。ai2nao 的 cache toggle 让用户在「真实计费量」和「真实新增
工作量」之间切换——这正是上面那些重复计数 bug 的根源（cache 太大,任何重复都被
放大几个数量级）看清楚后才有意义的设计。

---

## 4. 潜在缺口（待查）

ccusage [issue #988](https://github.com/ryoppippi/ccusage/issues/988):**Codex
Desktop 分支（branched）对话会双重计数**。ai2nao 目前按 `session_id` 去重,但若
Codex 把一个对话分支成多个共享前缀的 rollout,可能也会重复。**待验证**。

---

## 5. 一句话总结

ai2nao 这几天独立排查出的三个核心 bug(Claude message 去重、Codex delta、跨天
分桶),全都对得上主流项目 ccusage 的公开 issue,修法正好是它们推荐的正解。最大
差异是**不估算 USD 成本**——这是唯一一个「它们有、我们没有」的常见功能。

## 6. 相关文件

- [`docs/claude-token-double-count.md`](claude-token-double-count.md) — Claude message 去重
- [`docs/codex-token-daily-bucketing.md`](codex-token-daily-bucketing.md) — Codex 跨天分桶
- [`docs/codex-state-db-relocation.md`](codex-state-db-relocation.md) — Codex state DB 迁移
- [`docs/session-token-fields.md`](session-token-fields.md) — Claude/Codex token 字段参考
- [`docs/token-usage-pipeline.md`](token-usage-pipeline.md) — token 计算管线

### 外部来源

- ccusage：<https://github.com/ryoppippi/ccusage>
  - #888 Claude 重复计数：<https://github.com/ryoppippi/ccusage/issues/888>
  - #884 Codex delta 重复计数：<https://github.com/ryoppippi/ccusage/issues/884>
  - #988 分支对话双算：<https://github.com/ryoppippi/ccusage/issues/988>
- gille.ai「Claude JSONL 少算 100x」：<https://gille.ai/en/blog/claude-code-jsonl-logs-undercount-tokens/>
- toktrack：<https://github.com/mag123c/toktrack>
- codex-usage-tracker：<https://github.com/CasperKristiansson/codex-usage-tracker>
- tokscale：<https://github.com/junhoyeo/tokscale>
- ccost：<https://github.com/carlosarraes/ccost>
