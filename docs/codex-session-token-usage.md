# Local AI Session Token Usage

本文说明 ai2nao 如何从本机 Codex 与 Claude Code session 文件中计算 token 消耗，以及
如何把全量 session token 聚合到项目维度。

## 结论

Codex token 只从 `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` 里的真实
`token_count` 事件读取。Claude Code token 只从 `~/.claude/projects/*/*.jsonl` 中
assistant message 的 `message.usage.input_tokens/output_tokens` 读取。

ai2nao 不根据文本长度、消息数量、模型名或文件大小估算 token。

单个 session 的详情结果写入：

```ts
ChatSession.usage = {
  totalInputTokens: number,
  totalOutputTokens: number,
}
```

项目维度的全量结果写入派生索引表：

```text
codex_session_token_usage
claude_session_token_usage
```

`/dashboard/tokens` 只读取这两张索引表做 SQL 聚合和排序，不在页面请求里解析 transcript
或加载 session detail。索引没构建时，页面会少显示对应来源的数据并通过诊断暴露问题；
正确修复方式是跑 scheduler 刷新索引，而不是在 API 里临时慢扫。

## 数据来源

Codex 本地数据分两层：

```text
~/.codex/state_5.sqlite
  -> threads 表
  -> 提供 id、rollout_path、cwd、updated_at、title、model、git_branch
  -> 用来快速列 session 和定位 JSONL 文件

~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl
  -> session transcript
  -> 包含 event_msg / response_item 等事件
  -> token_count 事件是 token 计算的唯一真源
```

单 session 详情正常路径：

```text
loadCodexSessionDetail(sessionId)
  -> 从 state_5.sqlite 找 thread
  -> 读取 thread.rollout_path 指向的 rollout-*.jsonl
  -> 逐行解析 JSONL
  -> 遇到 event_msg + payload.type === "token_count"
  -> 聚合为 ChatSession.usage
```

当 SQLite 不可用时，ai2nao 会降级扫描
`~/.codex/sessions/**/rollout-*.jsonl`。这个 fallback 是为了找 session 文件，
不是因为 token 存在 SQLite 中。

Claude Code 本地数据：

```text
~/.claude/projects/<project-id>/*.jsonl
  -> session transcript
  -> user/assistant records
  -> assistant record 的 message.usage 是 token 计算真源
```

Claude Code 的项目身份优先来自 project directory slug 解码后的真实路径；如果 slug 解码
不完整，则 fallback 到 transcript record 里的 `cwd`。

## 项目级全量索引

项目级 token 不能靠列表页的有限分页或详情懒加载计算，否则只能得到“最近 N 条”的近似值。
ai2nao 现在维护两张 session 级 token 派生表：

```text
codex_session_token_usage
  session_id
  rollout_path
  rollout_mtime_ms
  rollout_size_bytes
  cwd
  project_key
  project_path
  identity_confidence
  input_tokens
  output_tokens
  total_tokens
  token_status
  missing_since

claude_session_token_usage
  session_id
  project_id
  file_path
  file_mtime_ms
  file_size_bytes
  cwd
  project_key
  project_path
  identity_confidence
  input_tokens
  output_tokens
  total_tokens
  token_status
  missing_since
```

刷新任务会读取 Codex 的全量 session 来源：

```text
1. 优先读取 ~/.codex/state_5.sqlite 的 threads 全表
2. 用每条 thread 的 rollout_path 定位 transcript JSONL
3. 校验真实路径必须仍在 ~/.codex/sessions 内
4. 从 JSONL token_count 事件提取真实 usage
5. 根据 cwd 归一化 project_key
6. upsert 到 codex_session_token_usage
```

如果 `state_5.sqlite` 不可用，会 fallback 扫描
`~/.codex/sessions/**/rollout-*.jsonl`。fallback 仍然只从 JSONL 读取 token，并会尽量
从 transcript 中提取 `cwd`、标题和时间。

Claude 刷新任务会读取 Claude 的全量 session 来源：

```text
1. 扫描 ~/.claude/projects 下所有 project directory
2. 扫描每个 project directory 中的 *.jsonl session transcript
3. 从 assistant message.usage 提取真实 input/output token
4. 根据 decoded project path / cwd 归一化 project_key
5. upsert 到 claude_session_token_usage
```

### 增量刷新

刷新时使用以下字段判断某个 session 是否需要重算：

```text
session_id
Codex:
  session_id
  rollout_path
  rollout_mtime_ms
  rollout_size_bytes

Claude:
  session_id
  file_path
  file_mtime_ms
  file_size_bytes
```

当 path + mtime + size 与派生表中的旧值一致，且不是 full rebuild，本轮只更新
`source_seen_at` 和 `missing_since`，不重新读取 JSONL。这样每小时刷新可以覆盖全量 session，
同时避免每次都解析全部历史文件。

如果 source 中不再出现某个历史 session，ai2nao 不删除旧行，而是写入
`missing_since`。聚合项目 token 时默认排除 `missing_since IS NOT NULL` 的行。

### 覆盖状态

每个 session 的 token 状态是三选一：

```text
full     找到了可识别的 token_count usage
unknown  JSONL 可读，但没有可识别 token_count usage
error    JSONL 读取、解析或路径校验失败
```

项目聚合时：

```text
full     该项目全部有效 session 都是 full
partial  该项目部分 session 有 token，部分 unknown/error
unknown  该项目没有任何 full session
```

更精确地说，`partial` 表示：

```text
coveredSessions > 0
且
  coveredSessions < totalSessions
  或 errorSessions > 0
```

也就是这个项目至少有一部分 session 已经拿到了真实 token，但仍有 session 没有可靠
token。显示的 token 数字只包含可确认的真实 token；`unknown` 和 `error` 不会估算，
计入 0，并通过覆盖状态暴露风险。

常见导致 `partial` 的情况：

- 旧 Codex session 没有 `token_count` 事件，JSONL 可读但 token 状态是 `unknown`。
- JSONL 有 `token_count`，但格式不是当前支持的 input/output 结构，例如只有
  `total: 123`，无法可靠拆分 input/output。
- JSONL 中有坏行或格式损坏，解析后该 session 标记为 `error`。
- `rollout_path` 指向的 transcript 文件不可读、不存在，或真实路径不在
  `~/.codex/sessions` 内。
- 同一项目中既有新 session 能读到 token，也有历史 session 因上述原因无法确认 token。

因此 `partial` 不是“估算了一部分”，而是“只统计了已确认真实 token 的那部分”。

### 刷新入口

派生索引有两个入口：

```text
POST /api/codex-token-usage/refresh
POST /api/codex-token-usage/refresh?full=true
GET  /api/codex-token-usage/status
```

调度任务：

```text
codex.tokens.refresh
work.tokens.refresh
```

`work.tokens.refresh` 会同时刷新 Claude Code 与 Codex token 索引，是 `/dashboard/tokens`
页面的推荐刷新入口。默认每小时增量刷新一次。`full=true` 用于强制全量重建，例如 token
解析规则升级后。

## 支持的 token_count 形状

### 1. 新格式：last_token_usage

优先支持 Codex JSONL 中常见的新格式：

```json
{
  "type": "event_msg",
  "payload": {
    "type": "token_count",
    "info": {
      "last_token_usage": {
        "input_tokens": 100,
        "cached_input_tokens": 20,
        "output_tokens": 30,
        "reasoning_output_tokens": 7,
        "total_tokens": 137
      },
      "total_token_usage": {
        "input_tokens": 100,
        "cached_input_tokens": 20,
        "output_tokens": 30,
        "reasoning_output_tokens": 7,
        "total_tokens": 137
      }
    }
  }
}
```

`last_token_usage` 表示本次 token 增量。ai2nao 直接把它加到 session 总量：

```text
totalInputTokens  += input_tokens
totalOutputTokens += output_tokens + reasoning_output_tokens
```

`cached_input_tokens` 暂不单独展示，也不从 `input_tokens` 中扣除。原因是当前
`SessionUsage` DTO 只有 input/output 两个聚合字段；成本/缓存命中统计属于后续更细
的 usage 模型。

如果同一个事件同时带 `last_token_usage` 和 `total_token_usage`，ai2nao 用
`last_token_usage` 计入增量，同时记录 `total_token_usage` 作为下一次累计差分的
baseline。

### 2. 新格式：total_token_usage

有些 `token_count` 事件只有累计总量：

```json
{
  "type": "event_msg",
  "payload": {
    "type": "token_count",
    "info": {
      "total_token_usage": {
        "input_tokens": 25,
        "output_tokens": 8,
        "reasoning_output_tokens": 4
      }
    }
  }
}
```

`total_token_usage` 是到当前事件为止的 session 累计值，不能把每条 total 直接相加。
ai2nao 按差分计算增量：

```text
first total_token_usage:
  add current total

next total_token_usage:
  add current total - previous total
```

例子：

```text
event 1 total: input=10, output=3, reasoning=2
event 2 total: input=25, output=8, reasoning=4

session usage:
  input  = 10 + (25 - 10) = 25
  output = (3 + 2) + ((8 + 4) - (3 + 2)) = 12
```

如果累计值倒退，例如当前 total 小于 previous total，ai2nao 会忽略这一条差分，避免
产生负 token 或污染 session 总量。

### 3. 旧格式：payload 顶层 input/output

ai2nao 仍支持较早或简化的 token_count 形状：

```json
{
  "type": "event_msg",
  "payload": {
    "type": "token_count",
    "input_tokens": 11,
    "output_tokens": 7
  }
}
```

这类事件被当作增量：

```text
totalInputTokens  += input_tokens
totalOutputTokens += output_tokens
```

同样支持常见别名：

```text
input:
  input_tokens
  inputTokens
  prompt_tokens
  promptTokens
  total_input_tokens
  totalInputTokens

output:
  output_tokens
  outputTokens
  completion_tokens
  completionTokens
  total_output_tokens
  totalOutputTokens

reasoning output:
  reasoning_output_tokens
  reasoningOutputTokens
  total_reasoning_output_tokens
  totalReasoningOutputTokens
```

## 不统计的情况

以下情况不会产生 `ChatSession.usage`：

```json
{
  "type": "event_msg",
  "payload": {
    "type": "token_count",
    "total": 123
  }
}
```

原因：只有一个 `total` 无法可靠区分 input/output，也无法知道 reasoning output 或缓存
语义。ai2nao 宁愿显示 token unknown，也不做猜测。

同理，以下信息也不会用于估算 token：

- message 文本长度
- assistant/user message 数量
- JSONL 文件大小
- command 输出长度
- model 名称
- SQLite thread 字段

## 算法伪代码

```text
usage = undefined
previousTotalUsage = undefined

for each JSONL record:
  if record.type != "event_msg":
    continue

  payload = record.payload
  if payload.type != "token_count":
    continue

  if payload.info.last_token_usage exists:
    last = parse input/output/reasoning from last_token_usage
    usage += last

    if payload.info.total_token_usage exists:
      previousTotalUsage = parse total_token_usage

    continue

  if payload.info.total_token_usage exists:
    currentTotal = parse total_token_usage

    if previousTotalUsage is missing:
      usage += currentTotal
    else:
      delta = currentTotal - previousTotalUsage
      if delta is non-negative:
        usage += delta

    previousTotalUsage = currentTotal
    continue

  if payload has recognizable input/output fields:
    usage += parsed payload as increment
    continue

  ignore event
```

## Dashboard fallback 行为

Work Dashboard 主路径会读取 `codex_session_token_usage` 派生索引，所以 Codex 项目
token 可以覆盖全量已发现 session。

如果派生索引尚未构建、规则版本过期或刷新失败，Dashboard 会退回旧的有限实时扫描：

```text
项目 token = 最近被扫描到的 session detail usage 之和
```

这个 fallback 默认只读取每个项目最近 `tokenSessionsPerProject=5` 个 session detail，
最大 20。此时 Dashboard 会显示诊断，提示 Codex token 索引不可用或过期。fallback
路径里的 token 仍然只来自真实 `token_count`，不会估算，但它不代表该项目全量历史。

## 代码位置

当前实现位置：

- `src/codexHistory/normalize.ts`
  - `usageFromTokenCountPayload()`
  - `deltaUsage()`
  - `buildCodexSession()`

测试位置：

- `test/codexHistory.test.ts`
  - 旧格式 `input_tokens/output_tokens`
  - 不识别 `total` 时不估算
  - `info.last_token_usage`
  - `info.total_token_usage` 累计差分
