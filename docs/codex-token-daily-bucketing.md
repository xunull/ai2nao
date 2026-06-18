# Codex 跨天 session 的 token 逐天归属

> 续用一个 Codex session 好几天,趋势页却只在最后一天显示 token,前面几天空白。
> 根因:每个 session 只记一行、一个日期。修复:按 `token_count` 事件时间戳逐天
> 归属 token(新表 `codex_token_usage_event`)。
>
> 排查时间:2026-06-18(/investigate)。这是
> [`codex-state-db-relocation.md`](codex-state-db-relocation.md) 之后的**第二个
> 独立 bug**。

---

## 1. 症状

state-DB 修复(让 ai2nao 读对了活的 state 库)之后,`/dashboard/tokens-trend`
**仍然**只有 6/18 一天有 Codex,而用户 6/11–6/18 每天都在重度使用 Codex。

## 2. 根因

`codex_session_token_usage` 是**每 session 一行**,只有一个 `last_updated_at` 和
一份累计 token 总和。趋势页按这个日期分桶。

Codex 的用法是**反复 resume 同一个 rollout 文件**:用户"最近几天"的用量其实全在
一个 6/11 起、续用到 6/18 的 session 里。它一周积累的 2 亿 token 整块挂在
`last_updated_at`(6/18),于是 6/11–6/17 全空。

Claude 不暴露这个问题,只是因为它每次对话开**新 session 文件**,天然按天散开。
本质上是同一个数据模型局限,只是 Codex 的长 session 把它放大了。

逐天数据其实**在 rollout 里完整存在**——每个 `token_count` 事件都有时间戳和当时
的累计 `total_tokens`。同一个长 session 按事件日看:

```
6/11 →24.3M   6/13 →53.5M   6/15 →118.3M   6/17 →196.9M
6/12 →39.5M   6/14 →79.5M   6/16 →152.3M   6/18 →203.6M   (累计)
```

每天 100–330 个 token 事件,只是被压成了一行。

## 3. 修复

### 新表:逐事件 token 时间线

`codex_token_usage_event(session_id, event_at, input_tokens, output_tokens,
reasoning_output_tokens)`(migration v30)。每个 `token_count` 事件的**当次 delta**
按它**自己的时间戳**入库。

### 口径保证:逐事件之和 == session 总数

`extractCodexUsageEvents()` 是**唯一**的记账遍历,`extractCodexSessionUsage()`
就是它的求和。所以"逐天分桶"永远和 session 总数精确对账——increment 事件贡献
`last_token_usage`,total 事件贡献与上一份累计的差值,规则与 session 总数完全一致。

真实库回填后对账:

```
event_total = 5,522,401,545
session_total = 5,522,401,545     diff = 0
```

### 趋势查询:Codex token 走事件表

`queryBucketsBySource`:
- **token 总和/输入/输出/reasoning** ← 事件表,按 `event_at` 分桶(`bucketExpr`
  现支持自定义列名,hour/3hour/day/week 全粒度复用,时区逻辑与 Claude 一致)。
- **session 数 / coverage** ← 仍走 session 表,按 `last_updated_at`(不变)。

这意味着某天可能"有 token 但 session_count=0"(一个还在续用的 session 当天消耗了
token,但它最后一次"更新"是在更晚的某天)。这是诚实的,且 per-bucket 的 session
数只在 coverage 不完整时才在 tooltip 里出现,常见全 full 场景不显示。

`computePreviousWindowTotal` 的 Codex 部分也改成事件表,保证 delta% 口径一致。

## 4. 验证

回填后 Codex 逐【事件日】分布(之前全压 6/18):

```
6/18  9.9M    6/16  35.6M    6/14  26.4M    6/12  14.6M
6/17  44.7M   6/15  38.9M    6/13  14.9M    6/11  26.5M
```

回归测试 `test/codexTokenUsage.dailyEvents.test.ts`:
- `extractCodexUsageEvents` 逐事件之和 == `extractCodexSessionUsage`。
- 一个 last_updated=6/18 的 session,token 正确散到 6/15/6/16/6/18,**不**全压 6/18。
- missing/非 full 的 session 事件被 JOIN 过滤掉(贡献 0)。

全量 675 测试通过。前端无改动(响应结构不变,bars 自动变正确)。

## 5. 回填 / 复用

```bash
npx tsx scripts/healCodexDailyEventsOnce.ts
```

强制全量重解析(rule_version 3→4 自愈),填充事件表并打印对账 + 逐天分布。
日常 refresh 会自动维护:每次 session 重解析时 delete+insert 它的事件行。

## 6. 相关文件

- `src/store/migrations.ts` — `applyV30`(事件表)
- `src/codexHistory/normalize.ts` — `extractCodexUsageEvents`(唯一记账遍历)
- `src/codexTokenUsage/queries.ts` — `replaceCodexTokenUsageEvents`
- `src/codexTokenUsage/refresh.ts` — 重解析时写事件行
- `src/workTokensTrend/queries.ts` — `queryCodexBuckets` / `queryCodexTokenSumsByBucket`
- `src/workTokensTrend/bucket.ts` — `bucketExpr` 支持自定义时间列
- `test/codexTokenUsage.dailyEvents.test.ts` — 回归测试
- [`docs/codex-state-db-relocation.md`](codex-state-db-relocation.md) — 第一个(state DB)bug
- [`docs/session-token-fields.md`](session-token-fields.md) — Codex token 字段参考
