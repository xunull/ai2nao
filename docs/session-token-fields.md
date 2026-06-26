---
title: Claude Code 与 Codex Session 文件的 Token 字段参考
category: Token 与成本
order: 20
---
# Claude Code 与 Codex Session 文件的 Token 字段参考

> 本文是**字段级参考**：穷举 Claude Code 和 Codex 的本地 session 文件里**能拿
> 到的所有 token 相关字段**，给出每个字段的位置、类型、含义和真实样本。
>
> 区别于另外两篇：
> - `docs/token-usage-pipeline.md` —— ai2nao **如何计算** token（解析 → 聚合 → 落库）
> - `docs/codex-session-token-usage.md` —— Codex/Claude token 的早期实现说明
>
> 本文只回答一个问题:**原始文件里到底写了哪些字段**。最后一节标注 ai2nao
> 当前实际读取了哪些、忽略了哪些。
>
> 字段集通过实地扫描真实文件得出(Claude 多个 session + Codex 全部 128 个
> rollout 交叉验证)。记录时间:2026-06-18。各字段以实际抓到的样本为准,不同
> 客户端版本可能增减字段。

---

## 1. Claude Code

### 1.1 文件位置

```
~/.claude/projects/<被编码的项目路径>/<sessionId>.jsonl
```

每个 `.jsonl` 是一条 session,**一行一条 JSON 记录**(NDJSON)。token 信息只出现
在 `type === "assistant"` 的记录里。

### 1.2 token 信息的位置

token 数据挂在 assistant 记录的 **`message.usage`** 对象下:

```
record (一行)
├── type: "assistant"
├── uuid, parentUuid, sessionId, timestamp, cwd, gitBranch, version, ...
└── message
    ├── id, role: "assistant", model, stop_reason, ...
    └── usage          ← token 字段都在这里
        ├── input_tokens
        ├── cache_creation_input_tokens
        ├── cache_read_input_tokens
        ├── output_tokens
        ├── cache_creation: { ... }
        ├── server_tool_use: { ... }
        ├── iterations: [ ... ]
        ├── service_tier, speed, inference_geo
```

另外,**自动压缩(compact)记录**里有一组独立的 token 计数(见 §1.5)。

### 1.3 `message.usage` 完整字段表

真实样本(来自一条 assistant 记录):

```json
{
  "input_tokens": 5,
  "cache_creation_input_tokens": 70766,
  "cache_read_input_tokens": 16087,
  "output_tokens": 917,
  "server_tool_use": { "web_search_requests": 0, "web_fetch_requests": 0 },
  "service_tier": "standard",
  "cache_creation": { "ephemeral_1h_input_tokens": 70766, "ephemeral_5m_input_tokens": 0 },
  "inference_geo": "",
  "iterations": [
    { "input_tokens": 5, "output_tokens": 917, "cache_read_input_tokens": 16087,
      "cache_creation_input_tokens": 70766,
      "cache_creation": { "ephemeral_5m_input_tokens": 0, "ephemeral_1h_input_tokens": 70766 },
      "type": "message" }
  ],
  "speed": "standard"
}
```

| 字段 | 类型 | 含义 |
|------|------|------|
| `input_tokens` | int | **本轮新增的、未命中 cache 的** prompt tokens(真正第一次喂给模型的新内容)。长会话里通常很小(<100)。 |
| `cache_read_input_tokens` | int | 本轮从 prompt cache **命中回放**的 tokens。长会话里往往是 input 的绝对大头。 |
| `cache_creation_input_tokens` | int | 本轮**首次写入** prompt cache 的 tokens(第一次出现的可缓存前缀)。 |
| `output_tokens` | int | 本轮模型产出的 tokens。 |
| `cache_creation` | object | `cache_creation_input_tokens` 的**生命周期细分**(下表)。两个子字段之和 == `cache_creation_input_tokens`。 |
| `server_tool_use` | object | 服务端工具调用次数(不是 token,是计费相关计数)。 |
| `iterations` | array | 本次 assistant 回合内部的**逐次推理细分**。每个元素重复上面四个 token 字段 + `cache_creation` + `type`。多数情况只有 1 个元素;模型多次内部迭代时会有多个。 |
| `service_tier` | string | 服务档位(如 `"standard"`)。非 token,影响计费费率。 |
| `speed` | string | 速度档位(如 `"standard"`)。非 token。 |
| `inference_geo` | string | 推理地理区域,常为空串。非 token。 |

#### `cache_creation` 子对象

| 字段 | 类型 | 含义 |
|------|------|------|
| `ephemeral_5m_input_tokens` | int | 写入 **5 分钟** TTL cache 的 tokens。 |
| `ephemeral_1h_input_tokens` | int | 写入 **1 小时** TTL cache 的 tokens。 |

> 不变式:`ephemeral_5m_input_tokens + ephemeral_1h_input_tokens == cache_creation_input_tokens`。

#### `server_tool_use` 子对象

| 字段 | 类型 | 含义 |
|------|------|------|
| `web_search_requests` | int | 本轮服务端 web 搜索次数。 |
| `web_fetch_requests` | int | 本轮服务端 web 抓取次数。 |

> 这两个是**请求计数**,不是 token;Anthropic 对内置 web 工具按次计费,所以放在
> usage 里。

### 1.4 关键关系:Claude 的 input 是"三块之和"

Anthropic 把"输入侧"账单拆成三块,**`input_tokens` 字段只是其中最小的一块**:

```
本轮账单 input 总量 = input_tokens          (真实新增)
                    + cache_creation_input_tokens  (写入 cache)
                    + cache_read_input_tokens      (命中 cache)
```

这三块在文件里是**分开写**的。如果只读 `input_tokens` 就会漏掉 cache 两块,长会
话会少算 100–1000 倍(ai2nao 早期踩过这个坑,见 `token-usage-pipeline.md` §9)。

### 1.5 压缩记录里的 token:`compactMetadata`

当 Claude Code **自动压缩**上下文时,会写一条带 `compactMetadata` 的记录(顶层
字段,不在 `message.usage` 下):

```json
{
  "trigger": "auto",
  "preTokens": 1028554,
  "postTokens": 100805,
  "durationMs": 133467,
  "preCompactDiscoveredTools": ["TaskCreate", "TaskUpdate"],
  "preservedSegment": { "...": "..." },
  "preservedMessages": { "...": "..." }
}
```

| 字段 | 类型 | 含义 |
|------|------|------|
| `preTokens` | int | 压缩**前**上下文的 token 数。 |
| `postTokens` | int | 压缩**后**上下文的 token 数。 |
| `trigger` | string | 触发方式(如 `"auto"`)。 |

> 这两个 token 数衡量的是"上下文窗口占用",**不是账单 token**,跟 `message.usage`
> 是两回事。ai2nao 当前不读它们。

---

## 2. Codex

### 2.1 文件位置

```
~/.codex/sessions/YYYY/MM/DD/rollout-<时间戳>-<uuid>.jsonl
```

同样是 NDJSON,一行一条记录。线程列表另有 `~/.codex/state_5.sqlite`,但 token
明细只在 rollout `.jsonl` 里。

### 2.2 token 信息的位置

token 数据出现在 `type === "event_msg"` 且 `payload.type === "token_count"` 的记录
里。**当前 Codex 版本把 usage 挂在 `payload.info` 下**(实测 128 个文件、82390 次
token_count 事件,usage 100% 在 `info` 下,没有直接挂 `payload` 的)。

```
record (一行)
├── type: "event_msg"
└── payload
    ├── type: "token_count"
    ├── info
    │   ├── total_token_usage: { ... }   ← 会话累计
    │   ├── last_token_usage:  { ... }   ← 本轮增量
    │   └── model_context_window
    └── rate_limits: { ... }             ← 速率限制,非 token
```

> **版本兼容**:历史上某些 Codex 版本把 `last_token_usage` / `total_token_usage`
> 直接挂在 `payload` 下(不经 `info`),字段名也可能是 camelCase。ai2nao 的解析器
> 对两种位置 + 多种别名都做了兼容(见 §4),但当前实测数据全部是 `info` + snake_case。

### 2.3 token usage 对象完整字段表

`total_token_usage` 和 `last_token_usage` **结构相同**,真实样本:

```json
{
  "input_tokens": 52447,
  "cached_input_tokens": 9600,
  "output_tokens": 1760,
  "reasoning_output_tokens": 132,
  "total_tokens": 54207
}
```

| 字段 | 类型 | 含义 |
|------|------|------|
| `input_tokens` | int | 输入(prompt)tokens。**已包含** cached 部分(见下方关系)。 |
| `cached_input_tokens` | int | 输入里命中 cache 的部分。**是 `input_tokens` 的子集**,不是额外量。 |
| `output_tokens` | int | 输出 tokens **总量**。**已包含** reasoning 部分(见下方关系)。 |
| `reasoning_output_tokens` | int | 推理(thinking)tokens。o1/o3 类模型的内部思考。**是 `output_tokens` 的子集**(实测 82390/82390 满足 `output_tokens ≥ reasoning_output_tokens`),不是额外量。 |
| `total_tokens` | int | Codex 自报的总量。实测 ≈99% 满足 `total_tokens == input_tokens + output_tokens`。**不**额外加 reasoning(它已在 output 内)、**不**减 cached(它已在 input 内)。 |

#### 两种 usage 的区别

| 对象 | 含义 |
|------|------|
| `last_token_usage` | **本轮增量**。这一次请求消耗的 token。 |
| `total_token_usage` | **会话累计**。从 session 开头到当前的总和。 |

> 同一会话里两者可能交错出现。要算"整个 session 用了多少",可以累加每个
> `last_token_usage`(增量模式),或对 `total_token_usage` 做相邻差分(total 模式)。
> ai2nao 两种都处理(见 §4)。

### 2.4 关键关系:Codex 的 cached / reasoning 都是子集

跟 Claude **相反**——Codex 的 `input_tokens`/`output_tokens` 已经是各自的总量,
`cached_input_tokens` 和 `reasoning_output_tokens` 只是其中的"分项标注",**不是
额外要加上去的量**:

```
input_tokens         = 全部输入(含命中 cache 的部分)
cached_input_tokens  ⊆ input_tokens          (输入里命中 cache 的部分)

output_tokens        = 全部输出(含推理部分)
reasoning_output_tokens ⊆ output_tokens      (输出里属于推理的部分)

total_tokens         = input_tokens + output_tokens
                       (≈99% 实测成立;不加 reasoning、不减 cached——都已在内)
```

所以 Codex 不需要像 Claude 那样把三块加起来——`input_tokens` 本身就是输入总量,
`output_tokens` 本身就是输出总量。两个子集字段只用来回答"其中多少是 cache /
多少是推理"。

### 2.5 `info` 的其它字段 + `rate_limits`

| 字段 | 位置 | 类型 | 含义 |
|------|------|------|------|
| `model_context_window` | `payload.info` | int | 当前模型的上下文窗口大小(如 258400)。非账单 token,是容量。 |
| `rate_limits` | `payload` | object | 速率限制信息(`primary` / `secondary` 窗口的 `used_percent`、`window_minutes`、`resets_at`,以及 `plan_type` 等)。完全跟 token 计数无关。 |

> `info` 本身可能为 `null`(某些 token_count 事件只带 `rate_limits`)。解析时要判空。

---

## 3. Claude vs Codex 对照

| 维度 | Claude Code | Codex |
|------|-------------|-------|
| token 字段位置 | `message.usage` | `payload.info.{last,total}_token_usage` |
| 触发记录 | `type: "assistant"` | `type: "event_msg"`, `payload.type: "token_count"` |
| 输入字段 | `input_tokens`(仅新增) | `input_tokens`(含 cache) |
| cache 命中 | `cache_read_input_tokens`(**额外**,需相加) | `cached_input_tokens`(**子集**,不相加) |
| cache 写入 | `cache_creation_input_tokens` + 生命周期细分 | 无对应概念 |
| 推理 token | 无单独字段 | `reasoning_output_tokens`(**output 的子集**) |
| 输出字段 | `output_tokens` | `output_tokens`(**含** reasoning) |
| 自报总量 | 无(需自己加) | `total_tokens` == input + output |
| 增量 vs 累计 | 每条 assistant 是增量,自己累加 | 显式给 `last`(增量)和 `total`(累计) |
| 上下文窗口 | `compactMetadata.preTokens/postTokens`(压缩时) | `model_context_window`(每次 token_count) |
| 服务端工具计数 | `server_tool_use.{web_search,web_fetch}_requests` | 无 |

**最容易踩的差异**:Claude 的 cache 是"输入之外要加上去"的,Codex 的 cache 是
"输入之内的一部分"。同一个词 cache,语义相反。

---

## 4. ai2nao 当前实际读取哪些

下面标注 ai2nao 解析器**当前**用了哪些字段。完整算法见 `docs/token-usage-pipeline.md`。

### Claude(`src/claudeCodeHistory/normalize.ts:mapTokenUsage`)

| 字段 | ai2nao 是否读 | 用途 |
|------|---------------|------|
| `input_tokens` | ✅ | 计入融合 input |
| `cache_creation_input_tokens` | ✅ | 计入融合 input + 单独存列(v3) |
| `cache_read_input_tokens` | ✅ | 计入融合 input + 单独存列(v3) |
| `output_tokens` | ✅ | 输出总量 |
| `cache_creation.ephemeral_*` | ❌ | 未细分 5m/1h |
| `server_tool_use.*` | ❌ | 未读 |
| `iterations[]` | ❌ | 未读(只读外层聚合值) |
| `service_tier` / `speed` / `inference_geo` | ❌ | 未读 |
| `compactMetadata.preTokens/postTokens` | ❌ | 未读 |

入库后:`input_tokens` 列 = 三块融合值;另存 `cache_read_input_tokens` /
`cache_creation_input_tokens` 两列;"真实新增"由 `融合 − read − creation` 推导。

### Codex(`src/codexHistory/normalize.ts:usageFromObject`)

| 字段 | ai2nao 是否读 | 用途 |
|------|---------------|------|
| `input_tokens`(及别名 `inputTokens`/`prompt_tokens`/...) | ✅ | 输入总量 |
| `output_tokens`(及别名) | ✅ | 输出总量(已含 reasoning) |
| `reasoning_output_tokens`(及别名) | ✅ | **单独存列**(`reasoning_output_tokens`)供「Codex 输出构成」展示;**不相加**进 output(它已在 output 内) |
| `cached_input_tokens` | ❌ | 未单独展示,也不从 input 扣减 |
| `total_tokens` | ❌ | 不直接用,自己用 input+output 重算 |
| `model_context_window` | ❌ | 未读 |
| `rate_limits` | ❌ | 未读 |
| `last_token_usage` vs `total_token_usage` | ✅ | 增量优先;纯 total 走差分 |

> ✅ **已修复的重复计数**(2026-06-18 /investigate):此前 ai2nao 算
> `output = output_tokens + reasoning_output_tokens`,但 §2.4 实测证明 reasoning
> 是 output 的**子集**(23202/23202 个 reasoning>0 样本满足 `total == input + output`,
> 不是 `input+output+reasoning`)。这个加法把推理算了两次,使 Codex 输出虚高
> **~22.6%**(真实库重算后 output 从 23.3M 降到 19.0M,降幅正好等于被重复加的
> reasoning 量)。现已改为 `output = output_tokens`,`reasoning_output_tokens`
> 不再相加。`CODEX_TOKEN_USAGE_RULE_VERSION` 升到 2,refresh 入口加了 self-heal
> 自动重算历史行。
>
> 🆕 **reasoning 现在单独展示**(2026-06-18,RULE_VERSION 3):`reasoning_output_tokens`
> 单独存进 `codex_session_token_usage.reasoning_output_tokens` 列(output 的子集,
> 不相加),tokens-trend 页新增「Codex 输出构成」小节展示「推理 vs 正常输出」+
> 推理占比。实测真实库 reasoning ≈ 4.3M / output 19M ≈ **22.6%**,所有 session
> 满足 `reasoning ≤ output`。这是跟 Claude「输入构成」(cache 拆分)镜像对称的
> 「输出构成」——cache 是 Claude-only,reasoning 是 Codex-only。

---

## 5. 相关文档

- [`docs/token-usage-pipeline.md`](token-usage-pipeline.md) —— ai2nao 如何把这些字段解析、聚合、落库
- [`docs/codex-session-token-usage.md`](codex-session-token-usage.md) —— 早期实现说明
- `src/claudeCodeHistory/normalize.ts` —— Claude usage 解析
- `src/codexHistory/normalize.ts` —— Codex token_count 解析
