# /agent-messages 窗口浏览 —— 设计与工程评审

> 选了时间窗口后,下方逆序(最新在上)铺出该窗口内 is_human 消息,不用先搜。
> office-hours 跳过(功能小、就现有代码锁);plan-eng-review + codex 外部声音已过(codex 7 findings 全采纳)。

## 锁定决策

| # | 决策 | 选择 |
|---|---|---|
| 1 共存 | 窗口/浏览/搜索三者 | **浏览默认、搜索接管**:搜索框空 → 窗口浏览列表;有提交词 → 现有全量搜索结果。窗口驱动图 + 浏览列表;搜索保持全量。 |
| 2 分页 | 控量方式 | **keyset 加载更多 + 定高滚动容器**,默认最新 50。**复合游标 `(event_at_utc, id)`**(codex #2 纠正)。 |
| 3 source | select 过滤谁 | **浏览=全源(与图一致),source 只管搜索**。→ 浏览查询不带 source,消解 codex #4 + #7,零新索引。 |

## codex 外部声音 —— 7 findings 全采纳

| # | 发现 | 处理 |
|---|---|---|
| 1 | 非 today 范围是 `anchorBucketStart(windowToRange.from, granularity)`,不是裸 `windowToRange.from`;裸值会回归 anchor 向下零丢弃 / 图列不一致 | `resolveWindowRange` **返回锚定范围**,复用 timeline 精确算法(见下)。DRY 且不回归。 |
| 2 | `event_at_utc` 非唯一,单列游标会跳过同时间戳剩余行 | **复合游标 `(event_at_utc, id)` + `ORDER BY event_at_utc DESC, id DESC`**。 |
| 3 | `input`/`submitted` 分离,搜完清空输入旧结果仍在 | 显示模式绑 `submitted.q`;**输入清空 / 切窗口时清 `submitted`+`openId`+浏览分页**,回浏览。 |
| 4 | source 过滤语义没定,易假一致 | 决策 3:浏览=全源,不带 source。 |
| 5 | `Snippet` 把任意 `[...]` 当高亮,浏览正文里的中括号会误高亮 | 浏览列表用 **plain-text 渲染**(非 Snippet),截断 + RawPanel 展开。 |
| 6 | 测试缺 route 层 + UI 状态 | 补 `/list` 校验测试(与 `/analytics` 一致)+ UI 状态重置测试。 |
| 7 | "不用新索引"当结论过早 | 因决策 3 浏览不带 source → `idx_aum_human_event(is_human,event_at_utc,source)` 等值+范围+倒序最优,**确认零新索引**。 |

## 数据流

```
窗口选择器(今天/1天/../6月)  ← state 上提到父 AgentMessages
        │ windowKey (controlled prop)
        ├──────────────► AnalyticsStrip:图(/analytics?window=,全源)
        └──────────────► 父:GET /api/agent-user-messages/list?window=&before=&beforeId=&limit=
                                        │
   结果区显示模式:                      ▼
   submitted.q 空 ─► 浏览列表(全源, 最新在前, 定高滚动 + 加载更多)
   submitted.q 有 ─► 现有全量搜索结果(source select 生效)
```

## 后端(src/agentUserMessages/)

### 抽取 `resolveWindowRange`(DRY,codex #1)
`queries.ts` 现有 `userMessageTimeline` 内联的范围算法抽成:
```
resolveWindowRange(window: TimelineWindow, now: Date): { from: Date; to: Date }
  today → { from: anchorBucketStart(now, "day"), to: now }
  else  → { from: anchorBucketStart(windowToRange(window, now).from, windowToGranularity(window)), to: now }
```
`userMessageTimeline` 改用它(既有 10 测试须仍绿 = 回归网)。`userMessageList` 也用它 → **列表范围 === 图范围**。

### `userMessageList`(新)
```
userMessageList(db, {
  window: TimelineWindow, before?: string, beforeId?: number, limit?: number, now?: Date
}): { items: {id,source,sourceSessionId,eventAtUtc,text}[]; nextBefore: {eventAt,id} | null }
```
- 范围 = `resolveWindowRange(window, now)`。
- SQL(复合游标,codex #2):
```
WHERE is_human = 1 AND event_at_utc >= @from AND event_at_utc < @to
  [AND (event_at_utc < @before OR (event_at_utc = @before AND id < @beforeId))]
ORDER BY event_at_utc DESC, id DESC
LIMIT @limit
```
- `text = cleaned_text`(不做 snippet)。limit 夹取 `[1,200]` 默认 50。
- `nextBefore = 满页时最后一行的 {eventAt,id},否则 null`。
- 走 `idx_aum_human_event`,无 source → 索引最优,零新索引/迁移。

### `/list` 路由
`GET /api/agent-user-messages/list?window=&before=&beforeId=&limit=` → `{ ok, items, nextBefore }`。
window 校验复用 `today | isWindowKey`(与 `/analytics` 一致,codex #6);before/beforeId 成对校验。

## 前端(web/src/pages/AgentMessages.tsx)
- `windowKey` 从 AnalyticsStrip **上提到父**,controlled prop 传回(图仍自取 timeline)。
- 结果区显示模式(codex #3):`submitted.q` 空 → 浏览列表;有 → 搜索结果。**输入清空 / 切窗口 → 清 `submitted`+`openId`+浏览分页游标**。
- 浏览列表:定高 `max-h` 滚动容器(守竖向约束)+「加载更多」(keyset,携 `before`+`beforeId`)。条目用 **plain-text 渲染**(codex #5)+ 复用 `RawPanel`「查看原文」。

## 测试(覆盖图)
```
后端 userMessageList (test/agentUserMessages.list.test.ts, pin 北京)
  ├── [★★★] 逆序 + 复合游标翻页无重叠/无跳过(构造同 event_at 多行, 验证不丢)  ← codex #2 实证
  ├── [★★★] 范围: today(今天0点) + 滚动窗口锚定(== timeline 范围)
  ├── [★★ ] is_human 过滤(注入不计) / limit 夹取 / 空窗口 = []+nextBefore null
  └── [★★ ] 全源(不受 source 影响)
resolveWindowRange 抽取 → timeline 既有 10 测试仍绿(回归)                     ← codex #1 兜底
route 层 (test)                                                              ← codex #6
  ├── [★★ ] /list window 非法 → 400(与 /analytics 一致) / before+beforeId 成对
UI 状态 (web test)                                                           ← codex #6
  ├── [★★ ] 搜索框空 → 浏览; 提交词 → 搜索; 清空输入 → 回浏览(submitted 清)
  └── [★★ ] 切窗口 → 浏览刷新 + 分页游标重置; 加载更多追加
COVERAGE 目标: 新增路径全覆盖
```

## 失败模式
| 新路径 | 失败方式 | 测试 | 错误处理 | 用户可见 |
|---|---|---|---|---|
| 复合游标翻页 | 同时间戳跨页跳行 | ✅ codex#2 实证测试 | 复合游标 | — |
| resolveWindowRange 抽取 | 回归 timeline 锚定 | ✅ 既有 10 测试 | — | — |
| 清空输入 | 旧搜索结果卡住 | ✅ UI 测试 | 绑 input | 回浏览 |
| /list 空窗口 | 空图/报错 | ✅ 空窗口测试 | items=[] | 空态提示 |

## NOT in scope
- **窗口内搜索**(把 from/to 传给 search):搜索保持全量,决策 1。P3 TODO。
- **浏览按 source 分栏 / source 统管全页**:决策 3 保持全源。
- **跳转到会话原文位置**:仅「查看原文」展开,不做定位跳转。
- **虚拟滚动**:keyset 加载更多已够,不引 react-window。

## What already exists(复用 vs 重建)
- `searchUserMessages`(queries.ts:74):照抄查询骨架(DESC + is_human + range),但空 q 返 [] → 新函数,不改它。
- `idx_aum_human_event`(applyV43):正好支撑浏览查询,零新索引。
- `windowToRange`/`anchorBucketStart`/`windowToGranularity`(timeWindow):resolveWindowRange 复用。
- `RawPanel`「查看原文」:浏览条目复用。**`Snippet` 不复用**(codex #5)。

## 实现任务
- [ ] **T1 (P1)** — queries.ts — 抽 `resolveWindowRange`,timeline 改用;跑既有 10 timeline 测试须绿。
- [ ] **T2 (P1)** — queries.ts — `userMessageList`(复合游标 + 全源 + resolveWindowRange)+ 测试(逆序/游标无跳/范围/is_human/limit/空)。
- [ ] **T3 (P1)** — routes.ts — `GET /list`(window/before/beforeId/limit 校验)+ route 测试。
- [ ] **T4 (P1)** — AgentMessages.tsx — windowKey 上提;浏览列表(定高滚动 + 加载更多 + plain-text)+ 显示模式(清空输入回浏览)+ UI 测试。
- [ ] **T5 (P3)** — TODO:窗口内搜索(from/to 传 search)。

NO UNRESOLVED DECISIONS
