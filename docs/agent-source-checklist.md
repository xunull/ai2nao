---
title: 给 agent_user_messages 加一个新源要改哪些地方
category: 数据源与同步
order: 85
---
# 给 `agent_user_messages` 加一个新源要改哪些地方

**这份清单存在的唯一理由：`tsc` 不会告诉你。**

## 先看证据

`AgentUserMessageSource` 是个联合类型，直觉上「加一个成员，编译器会把所有该改的地方报出来」。
实测（2026-09-01，加 `| "hermes"` 后其余一行不动）：

```
npx tsc --noEmit       → exit 0，零错误
npm run typecheck:web  → 零错误
```

原因：全仓**没有** `Record<AgentUserMessageSource, …>`，**没有** exhaustive switch + `never`。
所有引用点都在协变位置（字段类型、函数入参），往联合类型加成员是**放宽**，不产生任何错误。

**这个失败已经真实发生过一次。** `kimi` 早就在联合类型里、数据也早就入库了，
但它长期缺席下面第 1、6、7 项 —— `tsc` 从来没报过。

## 清单

改动前先跑 `grep -rn '"opencode"' src web/src`，逐处判定「加 / 明确不加」，不留未决。

### 必改（不改就是功能缺失或页面说谎）

| # | 位置 | 是什么 | 不改的后果 |
|---|---|---|---|
| 1 | `src/agentUserMessages/types.ts` | `AgentUserMessageSource` 联合类型 | 写入时类型报错 |
| 2 | `src/agentUserMessages/routes.ts` | 搜索的 `source=` 白名单 | 按该源筛选被当成非法值拒掉 |
| 3 | `src/aiSessions/routes.ts` | `coverage.sources` | **页面主动说谎** —— 旁边的注释原文：「不写明就又是一个『读起来像全部、其实不是』的数（排行页刚栽过）」 |
| 4 | `src/cli.ts` | `AumSourceName` + `AUM_SOURCES`（联合类型的**手抄副本**） | `agent-messages resync <新源>` 认不出该源 |
| 5 | `src/cli.ts` resync 的分派链 | 每个源一个显式 `else if` | 曾经最后是 `else → kimi` 兜底，加任何新源都会**静默跑成 kimi 的 ingest** |
| 6 | `web/src/pages/AiSessions.tsx` | `SOURCE_META`（标签 + 颜色） | 图例缺该源；渲染有 `?? s.source` 兜底所以不崩，但会显示原始 key |
| 7 | `src/agentUserMessages/queries.ts` | `ZERO_COUNTS`（时间线的逐源计数） | **静默丢数据**：新源既不进任何一列也不进 `total`，从图上消失而全套测试照样绿。现已改成 `Record<AgentUserMessageSource, number>`，漏键 tsc 会报 |
| 8 | `web/src/pages/AgentMessages.tsx` | 源下拉 `SOURCES` + `SOURCE_META` + 图表 `<Bar dataKey>` | 搜索页筛不到该源；堆叠图少一条 |

### 按功能范围判定（不是每个源都该进）

| # | 位置 | 是什么 | 判定依据 |
|---|---|---|---|
| 9 | `src/topicStream/conversation.ts` | `CONVERSATION_SOURCES` | 该源的人类消息要不要进话题聚类。进则需重建 embedding |
| 10 | `web/src/pages/AiRhythm.tsx` | 节奏页图例数组 | 该源有没有足够的时间分布密度 |
| 11 | `src/cards/sourceTrendSvg.ts` | 卡片 SVG 的 SERIES | 卡片是固定几条线的成图，加一条要重新配色 |
| 12 | `src/workTokensTrend/types.ts` `TOKEN_SOURCES` | token 趋势 | 该源有没有 token 数据 |
| 13 | `src/workDashboard/types.ts` `DASHBOARD_SOURCES` | Work Dashboard | **需要 `project_key` 归属** |
| 14 | `src/workDuration/types.ts` `WORK_DURATION_SOURCES` | 活跃时长 | **需要 `project_key` 归属** |

第 13、14 项对**没有项目归属的源**（如 hermes：`cwd` 9/120、`git_repo_root` 0/120）不适用——
硬塞会需要发明伪 `project_key`，那会污染所有按项目组织的页面。

## 这份清单第一版就漏了两条

写这份清单时（2026-09-01，接 hermes 那次）第 7、8 两项**不在里面**，
于是 hermes 的 152 条人类消息在 `/agent-messages` 的时间线上静默消失、
搜索页也筛不到它，而 2251 条测试全绿、两个 typecheck 全过。

漏的原因很具体：清单本身是靠 `grep -rn '"opencode"' src web/src` 得来的，
而我把它写进了验收却**从没真跑过**。事后真跑时还踩了第二个坑 ——
第一次跑的模式是大小写敏感的 `"hermes"`，
而 `AiSessions.tsx` 里是对象键 `hermes:`（无引号）、`navModel.ts` 里是 `"Hermes"`（大写），
两处都被误报成「没改」。**核对清单要用 `grep -ic hermes`，不是 `grep -c '"hermes"'`。**

## 验收怎么写

**不要写「tsc --noEmit 通过」。** 实测它在只加一行联合类型、其余什么都不做的状态下就已经全绿，
对「加源是否完整」零判别力。

改成：

```
grep -rn '"opencode"' src web/src 的每一处都已判定（加 / 明确不加，二选一）
GET /api/ai-sessions 返回的 coverage.sources 含新源
前端图例出现新源
agent-messages resync <新源> 跑的是该源自己的 ingest（不是兜底分支）
```
