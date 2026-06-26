---
title: Token Usage Pipeline (Claude Code & Codex)
category: Token 与成本
order: 10
---
# Token Usage Pipeline (Claude Code & Codex)

> 本文档详细记录 ai2nao 当前是如何从本机 Claude Code、Codex 的 session
> 文件中计算 token 数量的：原始字段含义、累加规则、增量刷新、自愈机制、
> DB 表结构、上层聚合，以及历史踩过的坑。
>
> 适用范围：`CLAUDE_TOKEN_USAGE_RULE_VERSION = 2`（含 prompt-cache 字段）、
> `CODEX_TOKEN_USAGE_RULE_VERSION = 1`。
>
> 更新时间：2026-06-12。本文取代旧的 `codex-session-token-usage.md` 中关于
> Claude 部分的描述（那份文档写于 v1，没有 cache 字段）。

---

## 0. 三条不可妥协的原则

1. **只从真实 usage 字段读取**，绝不根据消息条数、字符数、模型名、文件大小
   去"估算"。如果一条 session 拿不到 usage 字段，它被记为 `token_status='unknown'`
   而不是被填上一个猜测值。
2. **总量只把 `token_status='full'` 的 row 计入**，`unknown` / `error` / `missing`
   都从总量里排除（但会单独计数，便于在 UI 上呈现"有 N 个 session 没拿到 token"）。
3. **incremental refresh 是默认路径**，全量重算只在三种情况触发：(a) 手动指定
   `full=true`，(b) `rule_version` 自愈（见 §6），(c) 文件 mtime / size 变化。

---

## 1. 数据来源

| Source       | 默认根路径                       | 单条 session 文件                                | env 覆盖              |
|--------------|----------------------------------|--------------------------------------------------|-----------------------|
| Claude Code  | `~/.claude/projects/`            | `<projectId>/<sessionId>.jsonl`                  | `CLAUDE_CODE_PROJECTS_ROOT` |
| Codex (SQLite 主路径) | `~/.codex/state_5.sqlite`        | 由 state DB 查询 `rollout_path` 字段定位          | `CODEX_HOME`            |
| Codex (Fallback)     | `~/.codex/sessions/YYYY/MM/DD/`  | `rollout-<uuid>.jsonl`                          | 同上                    |

每个 jsonl 一行一条 JSON 记录（NDJSON），失败行会被收集到 `parse.errors[]`
而不会影响其它行。

代码入口：
- `src/claudeCodeHistory/paths.ts:resolveClaudeProjectsRoot()`
- `src/codexHistory/paths.ts:resolveCodexRoot()` / `codexSessionsRoot()` / `codexStateDbPath()`

---

## 2. Claude Code Token 计算

### 2.1 关心的字段

只关注 `type === "assistant"` 且 `message.role === "assistant"` 的行，其中
`message.usage` 是 Anthropic API 返回的四元组：

```json
{
  "type": "assistant",
  "message": {
    "role": "assistant",
    "model": "claude-opus-4-7",
    "content": [...],
    "usage": {
      "input_tokens": 6,
      "cache_creation_input_tokens": 47655,
      "cache_read_input_tokens": 22924,
      "output_tokens": 252
    }
  }
}
```

四个字段含义（Anthropic 官方语义）：

| 字段                          | 含义                                                                 |
|-------------------------------|----------------------------------------------------------------------|
| `input_tokens`                | **本轮新增**、未命中 cache、未被 cache 收录的 prompt tokens          |
| `cache_creation_input_tokens` | 本轮 prompt 中**新写入 cache**的 tokens（首次出现的可缓存前缀）       |
| `cache_read_input_tokens`     | 本轮 prompt 中**从 cache 回放**的 tokens（之前回合已经写入的缓存）   |
| `output_tokens`               | 本轮 assistant 实际产出的 tokens                                     |

> 🔑 **三者都按 Anthropic 计费**，比例不同但绝对值都计入 input 侧账单。
> 长会话里 `input_tokens` 往往只有 ~10–100，而 `cache_*` 加起来可达数万到数十万。
> 只读 `input_tokens` 会少算 100×–1000× 的真实用量。

### 2.2 单轮折算公式

`src/claudeCodeHistory/normalize.ts:mapTokenUsage()`：

```ts
function mapTokenUsage(u: unknown): TokenUsage | undefined {
  // ... 类型守卫省略
  const cacheCreation = typeof o.cache_creation_input_tokens === "number"
    ? o.cache_creation_input_tokens : 0;
  const cacheRead = typeof o.cache_read_input_tokens === "number"
    ? o.cache_read_input_tokens : 0;
  return {
    inputTokens: input + cacheCreation + cacheRead,  // 三者求和
    outputTokens: output,
  };
}
```

### 2.3 多轮累加

`extractClaudeSessionUsage(parse)` 遍历该 jsonl 的所有 assistant 行，把
每一轮的 `(inputTokens, outputTokens)` 直接相加：

```ts
for (const { record } of parse.okLines) {
  if (!isAssistantShape(record)) continue;
  const tokenUsage = mapTokenUsage(record.message.usage);
  if (!tokenUsage) continue;
  totalInputTokens += tokenUsage.inputTokens;
  totalOutputTokens += tokenUsage.outputTokens;
}
```

> ⚠️ **`cache_read_input_tokens` 跨轮重复读会被多次计入**——这是有意为之。
> 因为每次回放都按 cache-read 费率计费，所以即便底层是同一段 prompt，
> 多次读取确实对应多次账单事件。
>
> 这意味着 ai2nao 计算的"session 总 input"略大于"session 唯一 prompt 大小"，
> 但接近"session 总账单 token"——这是想要的语义。

### 2.4 session-level 输出

`buildClaudeSession()` 最终产出 `ChatSession.usage`：

```ts
{
  totalInputTokens: <∑ 三段 input>,
  totalOutputTokens: <∑ output>,
}
```

若一条 session 完全没有 assistant 行或所有 usage 都缺字段，`usage` 为 `undefined`，
后续会被打上 `token_status='unknown'`。

---

## 3. Codex Token 计算

### 3.1 关心的字段

Codex rollout jsonl 里关键的事件类型是 `event_msg` 且 `payload.type === 'token_count'`：

```json
{
  "type": "event_msg",
  "timestamp": "2026-06-12T03:00:00.000Z",
  "payload": {
    "type": "token_count",
    "info": {
      "last_token_usage":  { "input_tokens": 1200, "output_tokens": 80, "reasoning_output_tokens": 32 },
      "total_token_usage": { "input_tokens": 9800, "output_tokens": 730 }
    }
  }
}
```

Codex 客户端在不同版本里会以两种"姿势"上报：

| 模式        | 给出的字段                                | 含义                                |
|-------------|-------------------------------------------|-------------------------------------|
| `increment` | `last_token_usage` (或 `lastTokenUsage`)  | **本轮新增**的 input + output       |
| `total`     | 仅有 `total_token_usage`                  | **会话开始至此累计**的 input + output |

同一会话内两种模式可能交错出现，我们必须分别处理。

### 3.2 单轮归一化：`usageFromObject()`

为了兼容 Codex 客户端在不同字段命名下的写法，逐一尝试以下别名：

- input: `input_tokens` → `inputTokens` → `prompt_tokens` → `promptTokens`
        → `total_input_tokens` → `totalInputTokens`
- output: `output_tokens` → `outputTokens` → `completion_tokens` → `completionTokens`
        → `total_output_tokens` → `totalOutputTokens`
- reasoning（**折叠进 output**）: `reasoning_output_tokens` → `reasoningOutputTokens`
        → `total_reasoning_output_tokens` → `totalReasoningOutputTokens`

```ts
return {
  inputTokens: input,
  outputTokens: output + (reasoningOutput ?? 0),  // reasoning 计入 output
};
```

> 🔑 **`reasoning_output_tokens` 全部折叠进 `outputTokens`**。
> 因为 OpenAI 把 reasoning 算作输出账单的一部分（与 GPT-4o reasoning、
> o1/o3 reasoning 计费一致），所以前端单一的"output"字段就足够表达账单语义。

### 3.3 双模式累加：`extractCodexSessionUsage()`

逐行扫描 `token_count` 事件，根据探测到的模式做对应处理：

```ts
let usage: SessionUsage | undefined;
let previousTotalUsage: CodexTokenUsage | undefined;

for (const { record } of parse.okLines) {
  if (record.type !== "event_msg") continue;
  if (record.payload.type !== "token_count") continue;
  const tokenCount = usageFromTokenCountPayload(record.payload);

  if (tokenCount?.kind === "increment") {
    // 直接把 increment 加进总和
    usage = mergeUsage(usage, tokenCount.usage);
    if (tokenCount.totalUsage) previousTotalUsage = tokenCount.totalUsage;
  } else if (tokenCount?.kind === "total") {
    // 把 total 减去上一次 total，得到本轮 delta，再加进总和
    usage = mergeUsage(usage, deltaUsage(tokenCount.usage, previousTotalUsage));
    previousTotalUsage = tokenCount.usage;
  }
}
```

`deltaUsage()` 有一道安全门：当本次 total **小于**上次 total（理论上不会发生，
但客户端 bug 时可能出现），返回 `undefined` 丢弃该样本，而不是产生负数。

### 3.4 探测顺序

`usageFromTokenCountPayload()` 按以下顺序找 usage 对象：

1. `payload.last_token_usage` / `lastTokenUsage` → **increment**
2. `payload.info.last_token_usage` / `info.lastTokenUsage` → **increment**
3. `payload.total_token_usage` / `totalTokenUsage` → **total**
4. `payload.info.total_token_usage` / `info.totalTokenUsage` → **total**
5. 兜底：`payload.usage` / `payload.token_usage` / `payload.tokens` /
   `payload.counts`（取到就当 increment）

一旦命中 last → 优先 increment；命中 total → 转 delta 模式。

### 3.5 cached_input_tokens 的处理

Codex 一些版本会在 usage 里写 `cached_input_tokens`。当前实现 **不单独
展示**，也 **不从 input_tokens 中扣除**。理由：当下游账单是按"有效请求
tokens（已折扣 cached）"还是"原始请求 tokens"统计的，OpenAI 文档在不同
模型上语义不一致；ai2nao 选择把 `input_tokens` 视作账单 token，保留观察。
若未来需要做 cache discount 展示，应该新增独立字段，不应改 `inputTokens`
公式（会破坏 rule_version 兼容性）。

---

## 4. session-level → row 的物化

两边的入口分别是 `refreshClaudeTokenUsage()` 与 `refreshCodexTokenUsage()`，
逻辑同构：

```text
1. 列出 source session（Claude=jsonl, Codex=state DB / fallback 扫描）
2. for each session:
   a. stat 当前 jsonl 文件 → 取 mtimeMs / sizeBytes
   b. 查 DB 看是否已有对应 row
   c. 若 !options.full && row 与 (path, mtime, size) 完全一致：skip
   d. 否则 readFile → parseJsonlText → extract*SessionUsage → upsert row
3. 没有被任何 session "认领"的旧 row 标记 missing_since
4. 写入 state row：rule_version、各类计数、duration
```

skip 路径只比较 **三元组 (file_path, file_mtime_ms, file_size_bytes)**，
不读文件内容、不重新 parse。绝大多数 finalize 后的历史 session 在这里
跳过，使 refresh 在数千个 session 上仍能在 < 2 秒内完成。

### 4.1 token_status 枚举

| 值        | 触发                                          | 计入总量? |
|-----------|-----------------------------------------------|-----------|
| `full`    | parse 成功 + 抽到了 usage                     | ✅        |
| `unknown` | parse 成功 + 没抽到 usage（无 assistant / 字段缺失） | ❌        |
| `error`   | parse 时报错（JSONL 行无法解析等）             | ❌        |
| `missing` | row 存在但本轮 source 列表里找不到对应 session（用 `missing_since IS NOT NULL` 表达） | ❌        |

---

## 5. DB 表结构

### 5.1 行表：`claude_session_token_usage` / `codex_session_token_usage`

字段几乎对称（命名前缀不同：claude 用 `file_*`，codex 用 `rollout_*`）：

| 列                       | 类型     | 说明                                            |
|--------------------------|----------|-------------------------------------------------|
| `session_id`             | TEXT PK  | claude=`<projectId>:<fileId>`，codex=thread id  |
| `file_path` / `rollout_path` | TEXT  | 绝对路径                                        |
| `file_mtime_ms` / `rollout_mtime_ms` | INT | 用于增量 skip                              |
| `file_size_bytes` / `rollout_size_bytes` | INT | 用于增量 skip                          |
| `cwd`                    | TEXT     | session 启动时的工作目录                        |
| `project_key`            | TEXT     | 用于跨 source 的项目归一化（见 §7）              |
| `project_path`           | TEXT     | 同上                                            |
| `identity_confidence`    | TEXT     | `high` / `low`                                  |
| `title`                  | TEXT     | 首条 user 消息或 thread name                     |
| `created_at`             | TEXT ISO | session 第一条 record 的时间戳                  |
| `last_updated_at`        | TEXT ISO | session 最后一条 record 的时间戳（用于 day bucket） |
| `input_tokens`           | INT      | session 总 input                                |
| `output_tokens`          | INT      | session 总 output                               |
| `total_tokens`           | INT      | input + output                                  |
| `token_status`           | TEXT     | full / unknown / error                          |
| `parse_error`            | TEXT     | 摘要错误（nullable）                            |
| `missing_since`          | TEXT ISO | 源文件消失时间（nullable，用于过滤）              |
| `source_seen_at`         | TEXT ISO | 本次 refresh 看到这条 row 的时间                 |
| `updated_at`             | TEXT ISO | 本次 upsert 的时间                              |

Codex 行表额外字段：`model`、`git_branch`。

### 5.2 状态表：`claude_session_token_usage_state` / `codex_token_usage_state`

每张表只有一行（`id=1` 单例），记录最近一次 refresh 的总览：

| 列                            | 说明 |
|-------------------------------|------|
| `rule_version`                | 本次 refresh 用的 parser 规则版本号 |
| `last_rebuilt_at`             | 最近一次成功完成的时间戳 |
| `last_error`                  | 第一条错误摘要 |
| `source_session_count`        | 源列表里有多少 session |
| `indexed_session_count`       | 本次 upsert 的 row 数 |
| `token_known_session_count`   | `token_status='full'` 的数量 |
| `token_unknown_session_count` | `token_status='unknown'` 的数量 |
| `error_session_count`         | `token_status='error'` 的数量 |
| `skipped_unchanged_count`     | 命中 incremental skip 的数量 |
| `duration_ms`                 | 本次 refresh 耗时 |
| `updated_at`                  | 本次 upsert 的时间 |

---

## 6. rule_version 自愈机制

### 6.1 为什么需要

increment skip 只比较 `(path, mtime, size)`。当 parser 公式变化（例如
v1 → v2 加上 cache 字段）但文件没动时，所有历史 row 都会被永远跳过，
DB 留下用旧公式算出来的错误数字。

### 6.2 解决方案

`src/claudeTokenUsage/types.ts` 中导出一个常量：

```ts
export const CLAUDE_TOKEN_USAGE_RULE_VERSION = 2;
```

任何会改变 row 数值含义的 parser 改动都必须 **同步 bump 这个常量**。

`src/claudeTokenUsage/refresh.ts:172-192` 在 refresh 入口加自愈：

```ts
const storedState = getClaudeTokenUsageState(db);
const ruleVersionStale =
  storedState != null &&
  storedState.rule_version !== CLAUDE_TOKEN_USAGE_RULE_VERSION;
const effectiveOptions = ruleVersionStale ? { ...options, full: true } : options;
```

效果：当本机 DB 里存的 `rule_version` 与代码里当前 `RULE_VERSION` 不一致时，
**本轮 refresh 强制 `full=true`**，跳过 skip 路径、按新规则全量重算。
重算完成后 state 写入新版本号，后续 tick 回到增量模式。

### 6.3 Codex 的 rule_version

`CODEX_TOKEN_USAGE_RULE_VERSION = 1`，目前没有触发过自愈。
若未来要改 Codex parser（例如开始单独展示 cached_input_tokens），
同样应该 bump 这个常量；refresh 入口 **暂未** 加自愈检查，得补上才生效。

> TODO：把同样的 self-heal 加到 `refreshCodexTokenUsage` 入口。

### 6.4 v1 → v2 已知一致性 gap

**关键陷阱**：如果常量在某次提交里 bump 了，但 refresh 入口的自愈逻辑在
**后续提交**里才加上，中间存在窗口期。窗口期内任何一次 tick 都会用旧公式
算 row、用新版本号写 state，导致 self-heal 永远不会再触发。

历史已踩坑：见 commit history。补救方案是 `scripts/healClaudeTokensOnce.ts`：
- 先把 state `rule_version` 倒回到 1
- 立即调用 `refreshClaudeTokenUsage()`，触发自愈 force full
- 整批重算完成后 state 自动写回当前 RULE_VERSION

只需在 binary 升到含 self-heal 的版本后跑一次。

---

## 7. 上层聚合

### 7.1 项目维度排行

`buildWorkTokenRanking()`（`src/workToken/build.ts`）从两张 row 表读：

```sql
SELECT project_key, SUM(total_tokens) FROM <table>
WHERE token_status = 'full' AND missing_since IS NULL
GROUP BY project_key
```

跨 source 通过 `project_key` 归一化（`normalizeWorkProjectIdentity()`），
保证同一 `cwd` 的 Claude session 与 Codex session 落到同一行。

### 7.2 时间序列趋势

`src/workTokensTrend/queries.ts:queryBucketsBySource()`：

```sql
SELECT
  <bucket_expr> AS bucket_key,
  COALESCE(SUM(CASE WHEN token_status='full' THEN total_tokens ELSE 0 END), 0) AS total_tokens,
  COUNT(*) AS session_count,
  ...
FROM <table>
WHERE last_updated_at >= ?  AND last_updated_at < ?
  AND missing_since IS NULL
GROUP BY bucket_key
ORDER BY bucket_key ASC
```

`bucket_expr` 按粒度（day / week / month）使用 `strftime(..., 'localtime')`
做本地时区桶化。两端零填充后合成最终的 `WorkTokensTrendBucket[]`。

> 📌 一条 session 只贡献到它的 `last_updated_at` 所在桶（不是按时间戳拆分到
> 多个桶）。这是个简化但通常足够的近似——绝大多数 session 都在同一天内完成。

---

## 8. 边界与降级

| 场景                                | 行为                                            |
|-------------------------------------|-------------------------------------------------|
| jsonl 完全为空                       | parse 成功但没有 assistant 行 → `unknown`        |
| 某行 JSON 解析失败                   | 该行进 `parse.errors[]`，其余照常                 |
| `parse.errors.length > 0`           | `parse_error` 字段写入 `"N JSONL line(s) failed to parse"`，但仍然尝试抽 usage |
| 整文件 read 失败（FS 错误）           | 该 session row 状态变 `error`，错误摘要写 `parse_error`  |
| 源文件被删除 / 移动                  | 下次 refresh 在 `markUnseenClaudeTokenRowsMissing` 阶段被打 `missing_since`；row 不删除 |
| Codex 同时存在 last 与 total         | 优先 last（increment 模式），但记录 total 作为下次 delta 起点 |
| Codex total 单调递减                 | `deltaUsage()` 返回 undefined，丢弃该样本不计入   |
| Codex 缺 state_5.sqlite             | refresh 自动降级 fallback 扫描 `~/.codex/sessions/YYYY/MM/DD/*.jsonl`，最多 5000 个 |

---

## 9. 历史踩坑

### 9.1 Claude cache 字段漏读（FIXED）

- **症状**：dashboard 显示 Codex >> Claude，即使用户实际 Claude 用得更多。
- **根因**：`mapTokenUsage()` 只读 `input_tokens` + `output_tokens`，长会话
  里实际 99% 的 input token 在 `cache_creation_input_tokens` +
  `cache_read_input_tokens` 里被丢掉，少算 100×–1000×。
- **修复**：commit / files `src/claudeCodeHistory/normalize.ts` v2 公式。
- **回归测试**：`test/claudeCodeHistory.tokenCache.test.ts`。

### 9.2 历史数据未自愈（FIXED）

- **症状**：cache 字段修了之后 6/9–6/11 的 Claude tokens 仍然只有 ~4M。
- **根因**：常量 bump 与 self-heal 逻辑不是同一笔提交，中间窗口 refresh
  把 state 写到 v2 但 row 仍是 v1 数值，self-heal 看到 v2==v2 永不触发。
- **修复**：`src/claudeTokenUsage/refresh.ts` 入口加 self-heal 检查；
  `scripts/healClaudeTokensOnce.ts` 一次性修补脚本（手动倒退 state 触发
  self-heal）。
- **回归测试**：`test/claudeTokenUsage.selfHeal.test.ts`。

### 9.3 Codex total 与 increment 混用导致重复计数（已防御）

历史上某些 Codex 版本同一个 token_count 事件同时给出 last + total，
而且 total 是从 session 开头累计的。如果直接对 total 累加会重复计数。
现在的代码逻辑（§3.3）确保两种模式不会同时累加：发现 increment 直接
入账，发现纯 total 走 delta。

---

## 10. 关键文件索引

| 文件                                                | 作用                              |
|-----------------------------------------------------|-----------------------------------|
| `src/claudeCodeHistory/normalize.ts`                | Claude jsonl → session usage      |
| `src/claudeCodeHistory/paths.ts`                    | `~/.claude/projects` 解析         |
| `src/claudeCodeHistory/discover.ts`                 | 列出 project + jsonl              |
| `src/claudeTokenUsage/refresh.ts`                   | Claude refresh 入口 + self-heal   |
| `src/claudeTokenUsage/types.ts`                     | `CLAUDE_TOKEN_USAGE_RULE_VERSION` |
| `src/claudeTokenUsage/queries.ts`                   | 行表 / state 表 CRUD              |
| `src/codexHistory/normalize.ts`                     | Codex jsonl → session usage       |
| `src/codexHistory/paths.ts`                         | `~/.codex` 解析                   |
| `src/codexHistory/stateDb.ts`                       | 从 Codex state_5.sqlite 列 thread |
| `src/codexHistory/discover.ts`                      | fallback 扫描 jsonl                |
| `src/codexTokenUsage/refresh.ts`                    | Codex refresh 入口                |
| `src/codexTokenUsage/types.ts`                      | `CODEX_TOKEN_USAGE_RULE_VERSION`  |
| `src/codexTokenUsage/queries.ts`                    | 行表 / state 表 CRUD              |
| `src/workToken/build.ts`                            | 项目维度排行（跨 source）          |
| `src/workTokensTrend/queries.ts`                    | 时间序列桶化                      |
| `src/scheduler/taskDefinitions.ts`                  | `work.tokens.refresh` 任务定义     |
| `scripts/healClaudeTokensOnce.ts`                   | rule_version 错位时的一次性修补    |
| `test/claudeCodeHistory.tokenCache.test.ts`         | cache 公式回归测试                 |
| `test/claudeTokenUsage.selfHeal.test.ts`            | self-heal 回归测试                 |
