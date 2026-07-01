---
title: opencode Token 记账（真实用量，非估算）与看板口径
category: Token 与成本
order: 90
---
# opencode Token 记账（真实用量，非估算）与看板口径

> 问题：ai2nao 工作看板里 opencode 的 token 数字，是 opencode 记下来的**真实 API 用量**，
> 还是按字数/内容**估算**的？
>
> 结论：**真实记账，不是估算。** opencode 每条 assistant 消息记的是模型 provider 回的 usage
> 字段；`session` 表的 token 列是这些逐条真实用量的**精确加总**（实测逐字吻合）。看板直接
> SUM 这些列，一层不加工。
>
> 口径：看板只汇总 **input + output**，不含 cache / reasoning（与 claude/codex「真实 usage」
> 一致）。cost 列稀疏（订阅制模型常为 0）。
>
> 验证时间：2026-07-01。落地：`src/opencodeTokenUsage/queries.ts`。

---

## 1. 数据在哪、谁写的

opencode（`~/.local/share/opencode/opencode.db`）分两层记 token，都是 opencode 自己写：

- **逐条**：每条 assistant `message.data.tokens` = 模型 API 返回的 usage，结构完整：
  ```json
  { "total": 74926, "input": 74564, "output": 248, "reasoning": 0,
    "cache": { "write": 0, "read": 114 } }
  ```
  这是 provider 回的用量字段（和 Claude/Codex 一样），**不是**按 token 数猜的。
- **会话级**：`session` 表列 `tokens_input` / `tokens_output` / `tokens_reasoning` /
  `tokens_cache_read` / `tokens_cache_write` / `cost` = 该 session 全部消息的聚合。

## 2. 验证：会话列 == 逐条加总（精确吻合）

取 token 最多的 session（`ses_145a…`）对比：

| 来源 | tokens_input | tokens_output |
|---|---|---|
| `session` 列 | 20,224,405 | 668,088 |
| 逐条 assistant `message.data.tokens` 加总 | 20,224,405 | 668,088 |

```
SELECT SUM(json_extract(data,'$.tokens.input')),
       SUM(json_extract(data,'$.tokens.output'))
FROM message WHERE session_id = ? AND json_extract(data,'$.role')='assistant';
-- 结果 = session.tokens_input / tokens_output，逐字相同
```

**逐字相同** → 会话列不是另算/估算，就是逐条真实用量的和。所以 ai2nao 看板 SUM `session` 列
= SUM 逐条真实 API 用量，可信。

## 3. 看板口径：汇总什么、不汇总什么

`src/opencodeTokenUsage/queries.ts` 的 `listOpencodeProjectTokenUsage`：

```
SUM(tokens_input)  ─┐
SUM(tokens_output) ─┴─▶ 看板的 input / output / total（= 真实输入+输出 token）
tokens_cache_read  ─┐
tokens_cache_write ─┼─▶ 记着但看板不汇总（缓存命中/写入，计费不同）
tokens_reasoning   ─┘
cost               ───▶ 不用（稀疏，见 §4）
```

- **只 input + output**：与 claude/codex 看板的「真实 usage」口径一致，也是设计计划里的
  「先 input/output/total」。
- **cache 不算**：同一个 `ses_145a…` 的 `tokens_cache_read` 是 **1.6 亿**（远超 input）。缓存命中是
  真实发生但**计费与语义不同**的一类，算进去会让数字虚高，故不并入「真实 token」。
- reasoning 同理暂不细分。

## 4. cost 为什么不用

`session.cost` 列**稀疏**：订阅制/plan 模型（如 MiniMax plan）opencode 常写 `0.0`。cost 语义
（stored cost vs 等价 API cost、是否受 cache 影响）与 trend 页的价格快照算法也不同，故 A1 token
接入**不碰 cost**，留给后续 cost 语义统一那一轮。

## 5. 与其它源的一致性

- 记账层级和 Claude/Codex 一样：provider usage 字段 → 逐条记 → 聚合。
- **project_key 口径统一**：opencode token 按 `canonicalizePath(session.directory)` 归并，与
  claude/codex 的 project_key 同口径，故同一 repo 的三源 token 合并到一个看板项目
  （见 `docs/token-usage-pipeline.md`、`src/workProjects/identity.ts`）。
- **archived 一致**：token 聚合排除 `time_archived`，与 opencode 列表口径一致。
- 缺 token 列（旧 schema）→ 空 + coverage 不假装 full；缺库（没装 opencode）→ 缺席即静默、不报 warning。

## 6. 相关

- 代码：`src/opencodeTokenUsage/queries.ts`（SUM 列 + canonical keying + archived 排除 + 缺列诊断）。
- 看板接入：`docs/`（无独立文件）+ 计划 `~/.gstack/projects/xunull-ai2nao/20260701-design-opencode-token-dashboard.md`（A1，只 input/output）。
- 同类：`docs/session-token-fields.md`（Claude/Codex 字段）、`docs/token-usage-pipeline.md`、`docs/codex-session-token-usage.md`。
- 未做：cache/reasoning 细分、cost 语义统一、trend/duration 接 opencode（各自独立一轮）。
