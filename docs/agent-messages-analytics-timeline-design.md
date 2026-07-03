# Agent 消息分析:可调范围 + 自适应粒度时间线图 设计

> 状态:**评审已锁**(office-hours → plan-eng-review 2026-07-03,含 codex 外部声音 10 findings)。
> **本文只是设计,未写实现代码。** 是 `docs/agent-user-messages-design.md`(已实现)的 analytics 增强。

## 1. 背景与目标

`/agent-messages` 页现在是**手搓 CSS mini-bar + 固定「近 30 天 byDay」**。升级为**可调时间范围 + 自适应
粒度**的 recharts 柱图:1天/3天/1周/2周/1月/3月/6月,桶单位自适应(小时/3小时/天/周),带**环比**。

## 2. 关键复用

`/dashboard/tokens-trend` 已实现「可调范围 + 自适应粒度 + recharts + 环比 + zero-fill」,窗口核是纯函数、
跟 token 零耦合。复用件:`WINDOW_KEYS`/`windowToGranularity`(1d→hour…6m→week)、`windowToRange`、
`bucketExpr`、`iterateBuckets`(key=`fmtLocal` 匹配 `bucketExpr` SQL 输出,zero-fill join 靠它)、
`previousWindowRange`、`anchorBucketStart`;前端 `WorkTokensTrend.tsx` 的窗口选择器 + recharts 模板。

## 3. 最终决策(已锁,含评审 + codex 修订)

| # | 决策 | 说明 | 来源 |
|---|---|---|---|
| D1 | **抽 `src/timeWindow/`** | 把通用窗口/分桶原语(WINDOW_KEYS/WindowKey/BucketGranularity/windowToGranularity/windowToDays/isWindowKey/bucketExpr/iterateBuckets/IteratedBucket/windowToRange/previousWindowRange/granularityFor/anchorBucketStart)移到中立模块。**token DTO 不搬**(留 workTokensTrend);month picker(MonthKey/isMonthKey/monthToRange/assertMonthInDepth/MONTH_PICKER_MAX_DEPTH)可一并搬。`__bucketExpr/__fmtLocal` 测试 re-export 随迁,`test/workTokensTrend.bucket.test.ts` 改 import。 | eng-review + codex#4/#5 |
| D2 | **re-point 全部现有消费者** | 不只 workTokensTrend —— **`gitChurn` 也 import `../workTokensTrend/{bucket,types}.js`(routes.ts:3),必须一起迁**。 | codex#3 |
| D3 | **anchor 向下含完整首桶** | SQL 下界 + iterate 起点都用 `anchorBucketStart(windowToRange.from)`(桶起点、≤from)。首桶**完整、零丢弃**;窗口比标称 N 天略长(补齐整桶)。**不是** `buckets[0].start`(那是向前跳过、仍漏首段)。不动 `iterateBuckets`。 | codex#1(推翻初版) |
| D4 | **末桶 partial 标注** | iterator 保留 in-progress 末桶(bucketEnd>to,SQL `<to`),最后一柱是部分 → **tooltip 标「截至现在」**,防读成完整桶假低。 | codex#10 |
| D5 | **响应拆 all-time / window** | 顶部总量条用 `allTimeTotals`(全表,一览「总共说了多少」);图用 `windowTotals` + `buckets`。**UI 文案明确区分**,别让用户把「共 X 条」当窗口数。 | codex#7 |
| D6 | **环比(本次做)** | 加 `previousWindowTotal`(`previousWindowRange(effectiveFrom, to)` 内 is_human 计数)+ `deltaRatio`。**全程用 effective(anchored)范围**,current/previous 一致等长,不踩 codex#2 的 nominal-vs-effective 混用。 | 用户选「现在就做」 |
| D7 | **新索引 applyV43** | 无 source filter 的 windowed query = `WHERE is_human=1 AND event_at_utc>=?`,现有 `(source,event_at_utc)` 索引 source 打头用不上。补 `idx_aum_human_event(is_human, event_at_utc, source)`(覆盖分桶 group)。**新版本号,不改旧 applyVNN。** | codex#8 |
| D8 | **TZ 一致性** | `bucketExpr` 用 SQLite `localtime`、`iterateBuckets/fmtLocal` 用 Node 进程 TZ;两者不一致 zero-fill join 会错。加 TZ 一致性测试(pin Asia/Shanghai,同 tokens-trend)。 | codex#9 |

## 4. 后端查询(复用窗口核)

```
新增 userMessageTimeline(db, { window=1w, source?, now? }):
  granularity = windowToGranularity(window)
  { from: rawFrom, to } = windowToRange(window, now)
  from = anchorBucketStart(rawFrom, granularity)          # D3:向下对齐,含完整首桶
  buckets = iterateBuckets(from, to, granularity)         # from 已对齐 → 不跳过、含首桶
  rows = SELECT bucketExpr(event_at_utc, granularity) AS k, source, COUNT(*) n
         FROM agent_user_messages
         WHERE is_human=1 AND event_at_utc >= from AND event_at_utc < to [AND source=?]
         GROUP BY k, source
  zero-fill: 每个 iterated bucket 按 .key 查 rows,合并三源 count + total
  prev  = previousWindowRange(from, to);  previousWindowTotal = COUNT(is_human) in [prev.from, prev.to)  # D6
  windowTotals = 桶内三源汇总;  deltaRatio = prev==0 ? null : (windowTotal - prev)/prev
返回 { window, granularity, range:{from,to}, buckets:[{bucketStart,bucketEnd, claude,codex,opencode,total}],
        windowTotals, previousWindowTotal, deltaRatio }

保留 userMessageAnalytics 的 allTimeTotals(全表 totals)给顶部条(D5)。byDay 由 window 图取代。
```

## 5. API
- `GET /api/agent-user-messages/analytics?window=1w&source=&from=&to=` → `{ allTimeTotals, timeline: {window, granularity, buckets, windowTotals, previousWindowTotal, deltaRatio} }`。

## 6. 前端(搜索页)
- 替掉 CSS mini-bar:窗口选择器(照 `WINDOWS` + URL `?window=` 持久化)+ recharts `BarChart`(三源堆叠/分色:claude #d97757、codex 蓝、opencode #7c3aed)。
- x 轴按粒度自适应标签(复用 `bucketLabel`);**末桶 tooltip 标「截至现在」**(D4);环比 badge(↑/↓ deltaRatio,同 tokens-trend)。
- 顶部条继续显 `allTimeTotals`,文案标「累计」;图区标当前窗口(D5)。**无横向滚动条**(ResponsiveContainer)。

## 7. 里程碑
| # | 任务 | 验证 |
|---|---|---|
| T1 | 抽 `src/timeWindow/`,re-point workTokensTrend **+ gitChurn**,迁 bucket 测试 | tsc + `workTokensTrend`/`gitChurn` 现有测试全绿(迁移安全网) |
| T2 | `applyV43` 索引 `(is_human,event_at_utc,source)`,不改旧 migration | migration 测试:全新库/老库自愈到 v43 |
| T3 | 后端 `userMessageTimeline`(anchor 向下 + zero-fill + 环比),扩展 route | 各 window 桶数/粒度、首桶完整零丢弃、末桶 partial、环比、is_human、source 分列、**TZ pin** |
| T4 | 前端窗口选择器 + recharts + 环比 badge + 末桶 tooltip,替 CSS 条 | 切 1d/1w/3m 粒度变、空态、无横滚 |

## 8. 非目标 / 推后
- 月视图(tokens-trend 有月选择器,可后续复用)、字数指标 toggle、「我最常问什么」(top terms,需分词)。

## The Assignment(写代码前一个动作)
先做 T1 的抽取安全网:确认 `gitChurn`(codex#3 抓的第三个消费者)+ `workTokensTrend` 迁移到 `src/timeWindow/`
后 tsc/vitest 全绿,再往下。

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | — |
| Codex Review | `/codex review` | Independent 2nd opinion | 0 | — | — |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | clean | 2 arch + 0 code-quality + 0 perf(自审)+ codex 外部声音 10(1 推翻初版决策、6 折入、2 环比已纳入、1 已在设计),全处置 |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | — |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | — |

**CODEX:** 外部声音 codex(medium)10 findings 全部对代码核实:#1 推翻初版「snap=buckets[0].start」(实为向前截断)→ 改 anchor 向下(D3);#3 抓到第三个消费者 gitChurn(D2);#7 totals 拆分(D5)、#8 索引(D7)、#9 TZ 测试(D8)、#10 末桶标注(D4)全折入;#2/#6 环比语义 → 用户选「现在就做」并按 effective 范围一致处理(D6)。
**CROSS-MODEL:** 自审 2 arch(半截桶 / 复用方式)+ codex 10 两轮硬化设计;无遗留 tension —— 每条要么采纳、要么纳入、要么已在设计。
**VERDICT:** ENG CLEARED —— 可实现。

NO UNRESOLVED DECISIONS
