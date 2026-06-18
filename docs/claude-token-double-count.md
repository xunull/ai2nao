# Claude token 按行累加导致 ~2x 重复计数

> Claude 的 token 在仪表盘上偏大约一倍。根因:Claude Code 把一条 assistant 消息
> 写成多行,每行重复同一份 `message.usage`,而 ai2nao 按行累加。修复:按
> `message.id` 去重,每字段取 max。
>
> 排查时间:2026-06-18(/investigate)。修复:`src/claudeCodeHistory/normalize.ts`。

---

## 1. 症状

用户反馈 Claude 的 token 值"太大了,像是统计有问题"。实测全语料:

```
input(fused) 按行累加: 11,610,837,016
output       按行累加:     47,710,279
总 token:             11,658,547,295   ← 显示值
```

直觉上偏大约一倍。

## 2. 根因:同一条消息被写成多行,usage 逐行重复

Claude Code 的 session jsonl 把**一条 assistant 消息按 content block 拆成多行**
(一个回合里 16 个 `tool_use` → 16 行),流式生成期间还会多写几行。**每一行都
带同一份 `message.usage`**,`message.id` 和 `requestId` 也完全相同。

一次 API 请求 = 一个 `message.id` = **计费一次**。但
`extractClaudeSessionUsage` 当时按**行**累加 `message.usage`,于是同一次调用的
token 被算了 N 遍。

### 决定性证据

最大的一个 session(25M)里,同一个 `message.id` 重复出现、usage 完全一样:

```
id=msg_015RX63qXh9kBJYxtwyYb32B  出现16次  cache_read=[249340 ×16]  distinct_requestId=1
id=msg_01Ry884mT9UGaFDnFjnsf5Fu  出现14次  cache_read=[273743 ×14]  distinct_requestId=1
id=msg_01GRYCZbkycSN2uXSBFvAQJ7  出现13次  cache_read=[812724 ×13]  distinct_requestId=1
```

`distinct_requestId=1` 说明这些行来自**同一次 API 调用**。该 session 单独算:

```
cache_read 按行累加      : 1,737,122,430
cache_read 按 message.id : 770,080,812
重复放大                 : 2.26x
```

### 一个细节:流式行只有 output 在涨

401 个 `message.id` 的多行 usage **不完全相同**,但差异**只在 `output_tokens`**
(流式写入时 1 → 503 递增),`input` / `cache_creation` / `cache_read` 恒定。

```
(input=6, cc=26530, cr=0, output=1)
(input=6, cc=26530, cr=0, output=503)   ← 同一条消息,output 在涨
```

所以去重不能简单取"第一条"(会把 output 当成部分值 1),要**每字段取 max**:
input/cache 恒定 → max 即该值;output 流式递增 → max 即最终计费值。

## 3. 修复

`extractClaudeSessionUsage` 改为**按 `message.id` 去重、每字段取 max**:

```ts
const byMessageId = new Map<string, Acc>();
for (const { record } of parse.okLines) {
  if (!isAssistantShape(record)) continue;
  const tokenUsage = mapTokenUsage(record.message.usage);
  if (!tokenUsage) continue;
  const key = msg.id ?? `__noid_${synthetic++}`;   // 无 id 的行各算一次
  const prev = byMessageId.get(key);
  byMessageId.set(key, {
    input:  Math.max(prev?.input ?? 0, tokenUsage.inputTokens),
    output: Math.max(prev?.output ?? 0, tokenUsage.outputTokens),  // 流式取最终值
    cacheRead:     Math.max(prev?.cacheRead ?? 0, tokenUsage.cacheReadInputTokens ?? 0),
    cacheCreation: Math.max(prev?.cacheCreation ?? 0, tokenUsage.cacheCreationInputTokens ?? 0),
  });
}
// 再把每个 message.id 的值相加
```

- `buildClaudeSession` 的 `session.usage` 也改用这个去重口径(原来的
  `sessionUsageFromMessages` 有同样的 bug,已删除)。
- `CLAUDE_TOKEN_USAGE_RULE_VERSION` 3→4 自愈:下个 refresh tick 自动强制全量
  重解析,旧行就地修正。
- 全语料每条 assistant 行都有 `message.id`(0 缺失),去重干净彻底。

## 4. 验证

真实库强制全量重算后:

```
                修复前             修复后
总量      11,542,224,950  →   5,715,895,261   (↓50.5%)
output        46,700,000  →      16,585,616   (↓2.8x)
```

全语料预测去重后 5.78B,与 DB 5.72B(仅 full / 非 missing 子集)一致。

回归测试 `test/claudeCodeHistory.tokenCache.test.ts`(v4):
- 同一 `message.id` 跨多 content-block 行 → 只算一次。
- 流式多行 → `output_tokens` 取 max(不是 1,也不是各行之和)。
- 不同 `message.id` → 仍正常求和。

全量 678 测试通过。

## 5. 不是 bug 的部分:cache_read 占比高

修复后 `cache_read` 仍占 input 约 97%。**这不是统计错误**:Claude 提示缓存机制
下,每一轮都会把整个上下文从缓存里重读一遍(`cache_read`),所以它天然远大于
"真实新增 input"。这是真实计费,只是之前被逐行累加**额外放大了约 2 倍**。

> 与 token 口径相关的两次修复方向相反:
> - **v2(2026-06-12)**:之前漏算 cache 字段 → **少算** 100–1000x。见
>   [`docs/token-usage-pipeline.md`](token-usage-pipeline.md)。
> - **v4(本次)**:逐行累加重复 → **多算** ~2x。
> 两个都修正后才等于 Anthropic 的真实计费量。

## 6. 排查复用

怀疑某来源 token 偏大时,先验"是不是同一逻辑单元被算了多次":

```bash
# 某 Claude session 里同一 message.id 是否重复、usage 是否一致
python3 - <<'PY'
import json,collections
ids=collections.Counter()
for line in open("<session>.jsonl"):
    o=json.loads(line)
    if o.get("type")!="assistant": continue
    u=o.get("message",{}).get("usage")
    if u: ids[o["message"]["id"]]+=1
print("重复>1次的 message.id:", sum(1 for v in ids.values() if v>1), "/", len(ids))
PY
```

**核心教训:解析 Claude Code jsonl 时,`message.usage` 属于整条消息(一次
请求),但会重复出现在该消息的每一行上。任何按行累加 usage 的代码都必须先按
`message.id` 去重。**

## 7. 相关文件

- `src/claudeCodeHistory/normalize.ts` — `extractClaudeSessionUsage`(本次修复)
- `src/claudeTokenUsage/types.ts` — `CLAUDE_TOKEN_USAGE_RULE_VERSION`(3→4)
- `src/claudeTokenUsage/refresh.ts` — 写 `claude_session_token_usage` 的入口
- `test/claudeCodeHistory.tokenCache.test.ts` — 回归测试
- [`docs/token-usage-pipeline.md`](token-usage-pipeline.md) — token 计算管线 / v2 修复
- [`docs/session-token-fields.md`](session-token-fields.md) — Claude/Codex token 字段参考
- [`docs/codex-token-daily-bucketing.md`](codex-token-daily-bucketing.md) — Codex 逐天分桶(同期排查)
