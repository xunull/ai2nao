---
title: MiniMax Token 记账（远程账单 API）与接入口径
category: Token 与成本
order: 110
---
# MiniMax Token 记账（远程账单 API）与接入口径

> 问题：MiniMax 能不能像 claude/codex 那样拿到**每天的 token 用量**接进 tokens-trend？官网
> `console/usage` 能看按天图，有没有对应的 API？
>
> 结论：**能拿到，且口径是三个源里最规整的。** 但它**不是** local-first —— 数据来自 MiniMax
> 的**远程账单接口**（未文档化的 console 端点，需 API Key 联网拉取），且账单**没有 conversation
> id**，只能喂「趋势/用量」这类聚合页，喂不了会话级视图。
>
> 口径映射：账单按 `method` 拆成 `cache-read` / `cache-create` / `chatcompletion-v2` 三类用量
> 记录（外加非用量的 `code_plan_purchase` 需过滤）。**含缓存 = 全部；不含缓存 = 只留
> `chatcompletion-v2`**（天然把两种 cache 都排除，无歧义）。
>
> 验证时间：2026-07-02（实拉某 coding_plan 账号 970 条记录）。状态：**调研验证完成，未落地**，
> 接入决策待定。
>
> ⚠ **本文推翻了 [provider-usage-sync-design](provider-usage-sync-design.md) 的核心前提。**
> 那篇（office-hours 2026-06-19「设计已锁定」）断定「MiniMax **没有**每天/每月历史 API，只有
> `remains` 快照」，据此拍了「**快照-only、不攒历史、不进 token-trend**」。本次实测发现
> `/account/amount` 就是被漏掉的**历史用量接口**（按小时、带 input/output/cache/model），
> 那三条边界因此**全部失效**——MiniMax 现在**可以**当真正的历史源接进 tokens-trend。设计需重议。

---

## 0. 推翻了哪些既有结论

[provider-usage-sync-design](provider-usage-sync-design.md) 当年只发现了 `remains` 快照端点
（和只用该端点的社区工具 `minimax-status`），**漏了 `/account/amount`**，于是得出并锁定了几条现在
已被证伪的结论：

| 既有设计的结论（2026-06-19） | 本次实测（2026-07-02） |
|---|---|
| §1「MiniMax **没有**每天/每月历史 API」 | **有**：`/account/amount` 返回按小时的扣费流水 |
| §5 / §7「**快照-only**，不攒历史」 | 可直接拿到**逐小时历史**，无需自己轮询攒 |
| §7「**不混进** token-trend（快照无时间维度）」 | 有 `created_at` + input/output/model → **可进** trend |
| §2「外部 provider 只有当前快照，无 session/明细」 | 无 session id 仍成立，但**有 method/model/按小时明细** |

**仍然成立**的部分：key 存 DB、可插拔 provider 抽象、错误隔离、无 conversation 链接（§5）。
所以不是推翻整个设计，而是**把「快照-only」升级为「快照 + 逐小时历史」**这一档。是否升级由后续
`/plan-eng-review` 定。

## 1. 数据来源：两个端点，只有一个能出「按天」

| 端点 | 鉴权 | 返回 | 有没有按天 |
|---|---|---|---|
| `GET /v1/token_plan/remains`（官方文档**唯一**列出） | `Bearer <API Key>` | `model_remains[]`：剩余额度、`remains_time`、`*_remaining_percent`、重置时间 | ❌ 只有当前快照 |
| `GET /account/amount`（**未文档化**，console 后端） | `Bearer <token>` | `charge_records[]`：**扣费流水明细**，分页 | ✅ 每条带 `created_at`，自己分桶 |

官方 FAQ 只正式列了 `remains`（且连返回字段都没写全），**只字未提** `/account/amount`。后者是
console 用量页背后的接口，吃 Bearer token 能跑通，但**没有文档背书，随时可能改**。

### 1.1 `/account/amount` 请求

```bash
curl -sS 'https://www.minimaxi.com/account/amount?page=1&limit=100&aggregate=false' \
  -H 'Authorization: Bearer <API Key>' \
  -H 'Content-Type: application/json' \
  -H 'Referer: https://platform.minimaxi.com/'
# 国际站换 https://www.minimax.io
```

- 分页：`page`（1 起）、`limit`（≤100）。翻页直到某页 `< 100` 条为止。
- `aggregate`：`false` 返回原始流水；`true` 返回的 **records 完全一样**，唯一区别是顶层
  `consume_token_sum` 会被填上全量总和（`false` 时为 `"0"`）。**服务端不提供按天预聚合**，
  按天/按小时都得客户端自己算。

### 1.2 `charge_record` 字段（逐字）

```json
{
  "method": "chatcompletion-v2(Text API)",   // 口径分类键，见 §2
  "model": "MiniMax-M3-512k",                 // 每条都带模型
  "consume_input_token": "16484",             // 输入 token（字符串）
  "consume_output_token": "1146",             // 输出 token
  "consume_token": "17630",                   // = input + output（冗余总和，逐条校验成立）
  "created_at": 1782788400,                   // 秒级 epoch = 该「北京整点」起点
  "consume_time": "2026-06-30 11:00-12:00",   // 人类可读的小时窗（北京时区）
  "consume_cash": "0.0000",                   // 现金（订阅制为 0）
  "consume_cash_after_voucher": "0.0000",
  "api_token_name": "coding_plan",            // 哪个 key/套餐
  "status": "SUCCESS",                        // 成功/失败可过滤
  "group_id": "20291799911...", "mail": "主账号", "creator_name": "主账号", "ymd": ""
}
```

**粒度 = 小时 × method × model 的预聚合**，不是每次调用。`created_at` 是该小时起点的绝对
epoch（+8h 落回北京日与 `consume_time` 一致）。所以按 `created_at` 分桶天然落到正确的北京日。

## 2. 全部 method 枚举 = 口径映射表（核心）

实拉 970 条，本地统计，共出现 **4 种 `method`**（三类用量 + 一类账务）：

| method | 条数 | input | output | 分类 | claude 等价物 |
|---|---:|---:|---:|---|---|
| `cache-read(Text API)` | 357 | 878.1M | 0 | 缓存**读** | `cache_read_input_tokens` |
| `cache-create(Text API)` | 219 | 19.4M | 0 | 缓存**写** | `cache_creation_input_tokens` |
| `chatcompletion-v2(Text API)` | 393 | 290.8M | 10.7M | **真正生成** | fresh input + output |
| `code_plan_purchase` | 1 | 0 | 0 | **账务事件（非用量）** | 无，**必须过滤** |

**完备性自洽**：三类 input 相加 = 290.8M + 878.1M + 19.4M = **1,188,308,562**，与 input 合计
**分毫不差** → 没有漏掉的 method。（`model` 维度里那个 `subscribe`/1 条/0 token 就是同一条
购买事件。）

> ⚠ 以上是**文本 API（coding_plan）账号**观测到的 method。其它业务（tts / image / embedding
> 等）可能有别的 `method` 值，接入前应在目标账号上重新枚举一次（§5 探针可复现）。

## 3. 缓存占大头 → 含/不含缓存口径

- **缓存占 74.9%**（cache-read 878M + cache-create 19M = 897M / 1199M）。真正干活的
  chatcompletion 只占 25%，其中 **output 仅占全局 0.9%**。典型重度 agentic coding + 512k
  上下文反复命中缓存的形状。

| ai2nao 口径 | MiniMax 怎么算 | 本次样本值 |
|---|---|---:|
| **含缓存**（看板 headline，input+output） | 全部 method（除 `code_plan_purchase`） | **1.199B** |
| **不含缓存** | **只留 `chatcompletion-v2`**（丢弃两种 cache） | **301.5M** |

因为 claude 把 `input / cache_read / cache_creation` 塞进**同一行三列**，而 MiniMax 把它们拆成
**独立 method 记录**，「不含缓存 = 只留 chatcompletion」天然把两种 cache 都排除、定义无歧义。
这顺带印证了 claude 侧那个悬案（「不含缓存」只减 cache_read、没减 cache_creation —— 见
[Claude token 按行累加导致 ~2x 重复计数](claude-token-double-count.md) 邻域的口径讨论），
MiniMax 这边不会踩。

## 4. 按天分桶天然正确 —— 结构上免疫「归属塌账」bug

codex/claude 都踩过「一整段会话生命周期的 token 塌到最后触碰日」的 bug（见
[Codex 跨天 session 的 token 逐天归属](codex-token-daily-bucketing.md)）。**MiniMax 结构上不可能犯**：每条记录本身已经是「某小时」的
预聚合，`created_at` 就是那个小时，天然锚定，不存在跨天累计。

实测 970 条横跨 2026-03-15…06-30，每天的值都合理（峰值 06-15 的 255M 是真实重度日，不是尖刺），
**没有任何单日异常膨胀**。

**但有 T+1~T+2 滞后**：本次最新只到 06-30，拉取当天为 07-02 —— 账单非实时，**当天数据永远不全**。
接入时今天不落库，只回填到「昨日/前日」。

## 5. 与 claude/codex 的两个本质差异（接入前必须认下）

口径已不是问题，真正要权衡的是**摄取模式**：

1. **不是 local-first，是「拉远程账单」**。claude/codex 读本地 JSONL（离线、无鉴权）；MiniMax
   必须**联网**打**未文档化**端点、带 API Key。这与 ai2nao「本地索引器」定位是另一种摄取模式
   （定时 pull 远程，而非解析本地文件）。
2. **只能喂 trend，喂不了会话级视图**。账单是「小时×method×model」聚合，**无 conversation/session
   id**，无法像 claude/codex 那样把 token 挂回具体对话日志。

## 6. 若接入：建议形状（未落地）

当作**独立的「远程用量源」**，不要塞进 claude/codex 的本地解析管线。

落库同构于 `codex_token_usage_event` / `claude_token_usage_event`：

```sql
minimax_token_usage_event(
  event_at        TEXT,     -- created_at → ISO（小时起点）
  method          TEXT,     -- 口径分类:cache-read / cache-create / chatcompletion-v2 / ...
  model           TEXT,     -- MiniMax-M3-512k / M2.7 / ...
  input_tokens    INTEGER,  -- consume_input_token
  output_tokens   INTEGER,  -- consume_output_token
  api_token_name  TEXT,     -- 可选:按 key 拆
  PRIMARY KEY (event_at, method, model, api_token_name)  -- 天然去重
)
```

- 分桶：按 `event_at` 复用现有 trend 聚合（`bucketExpr` + `mergeAndZeroFill`）。
- 口径开关：含缓存 = SUM 全部；不含缓存 = `WHERE method = 'chatcompletion-v2(Text API)'`。
- 过滤：`code_plan_purchase` 等 0-token 账务事件不入库（或入库但排除出用量聚合）。
- 同步任务：单开一个「MiniMax 账单同步」scheduler task，翻页拉 `/account/amount`，**只回填到
  昨日**（T+1 滞后），最新数据用 `PRIMARY KEY` upsert 幂等覆盖。

## 7. 复现（探针）

拉全量并统计 method/model/按天，只读、不落库：

```bash
# 逐页拉 /account/amount?aggregate=false，累积后本地按 method / model / 北京日 汇总，
# 并校验 consume_token == consume_input_token + consume_output_token。
# 北京日 = time.gmtime(created_at + 8*3600) 取 %Y-%m-%d（不依赖 tz 数据库）。
MINIMAX_KEY=<你的key> bash minimax-methods.sh
```

关键统计口径（供重写探针参考）：
- `consume_input_token` / `consume_output_token` 用 `int(x or 0)` 解析（字段是字符串）。
- 按 `method` 分组累加 input/output → 输出占比 0% 即「纯输入/缓存类」。
- 三类用量 input 之和应等于顶层 input 合计（完备性校验）。

---

**一句话**：MiniMax 值得接、口径最干净，但要当**远程用量源**独立设计（远程 pull + T+1 + 仅
trend），别硬套本地 JSONL 那套。
