# 我的 AI 节律 —— 自量化仪表盘(设计)

> office-hours(builder 模式)产出。把「你对三个 AI 说过的每一句话」变成一面**认识自己**的镜子。
> 只出设计,不写码。下一步:/plan-eng-review 锁工程,或直接实现 T1。

## 定位

你已经把三源(claude/codex/opencode)的**真人输入**抽进 `agent_user_messages`(~4234 条 is_human,
最早 2026-04-24,带 event_at / source / char_len / 全文)。这不只是使用统计,是你的**工作节律**。
本功能 = 一个**给你自己看**的自量化仪表盘,像「AI 工作版的 Strava / Spotify Wrapped」。

## 锁定决策(office-hours)

| # | 决策 | 选择 |
|---|---|---|
| D1 大方向 | 数据长成什么 | **认识自己**(自量化仪表盘)—— 纯现有字段,不需 embedding,最快能出 |
| D2 英雄位 | 一打开先看到啥 | **作息热力图**(小时 × 星期)—— 最直观的 whoa,一眼看出夜猫/早鸟/周末狂 |
| D3 放哪/多大 | 位置与范围 | **新建「我的 AI 节律」仪表盘页** —— 自量化有个干净的家 + 以后配菜卡的锚点;搜索页保持搜索专注 |

## 英雄:作息热力图(= GitHub punch card)

```
        0h ─────────────────────────────── 23h
  周一   ░ ░ ░ ▒ ▓ █ █ ▓ ▒ ░ … ░ ▒ ▓ █ ▓ ▒ ░
  周二   ░ ░ ░ ░ ▒ ▓ █ ▓ ▒ … 
  …
  周日   ▒ ░ ░ ░ ░ ▒ ▓ …
        色深 = 那个「星期几 × 整点」你发了多少条(is_human)
```

- **网格**:7 行(周一…周日)× 24 列(0–23 整点)= 168 格。
- **口径**:`is_human = 1`,**本地时区**分桶(复用 `src/timeWindow/bucket.ts` 的 `strftime(..., 'localtime')` 思路):
  `weekday = strftime('%w', event_at_utc, 'localtime')`(0=周日,前端映射到周一起)、
  `hour = strftime('%H', event_at_utc, 'localtime')`,`COUNT(*)` group by (weekday, hour)。
- **配色**:count → 5–6 档色阶(像 GitHub 绿阶;本项目可用 emerald 或中性阶)。零格淡。
- **范围**:v1 **全时段**(all-time,一次聚合即可);后续可加窗口选择(复用 timeWindow)。
- **来源**:v1 **全源合计**(与搜索页图口径一致);后续可加 source 分面/切换。
- **交互**:hover 单元格 → tooltip「周三 14:00 · 42 条」。
- **旁注**:顶部一行文字洞察 —— 「你最活跃:周四 22:00 · 峰值 X 条 / 夜猫指数…」(从同一份聚合直接算,不额外查)。

**查询极轻**:一条 `GROUP BY strftime(...)`,168 行以内,毫秒级。零新表、零 embedding。

## 配菜卡(预留,后面慢慢加,不在首版)

英雄位下方留卡位,数据都在现有表里:
- **命令/技能排行榜**:命令已抽成 `/名字` → 你最爱哪些 skill、什么时段用什么命令、各用多少次。
- **习惯演变曲线**:prompt 平均长度趋势(越来越简练?)、三源迁移(codex→claude)、每活跃日消息强度。
- **个人纪录**:史上最忙的一天、最长连续使用天数、一小时最多、里程碑(第 1000/5000 条)。

## 备选方案(Phase 4,已选 B)

- **A 最小**:搜索页加一张热力图卡。快,但把「搜索」和「自量化」两个目的混在一页,以后加卡更挤。**否**。
- **B 新页(选中)**:独立「我的 AI 节律」页,热力图英雄 + 预留配菜卡位。自量化有干净的家,能长大。
- **C 创意 AI Wrapped**:每周/月生成回顾(热力图 + 纪录 + 一句旁白)。最有 whoa,但要摘要生成 + 周期调度,范围大 → 记 P3 未来方向。

## NOT in scope
- **语义/embedding**(主题聚类、按意思搜、「我问过 auth 的」)—— 是另一条大路(office-hours D1 的 C),不在自量化这条。
- **自动工作日志**(从 prompt 反推「我做了什么」,需 LLM 摘要)—— D1 的 B,单列。
- **AI Wrapped 定期回顾 / 分享**—— 备选 C,P3。
- **多用户 / 权限 / 分享**—— 单用户本地工具,不做。

## What already exists(复用)
- `agent_user_messages`(event_at_utc / is_human / source / char_len)—— 直接聚合,无需新数据。
- `src/timeWindow/bucket.ts` 的 `strftime localtime` 分桶口径 —— weekday/hour 分桶照抄。
- recharts(已在)—— 或热力图用纯 CSS grid(168 格,不必上图表库)。
- 页面壳 / 路由 / 导航模式(WorkTokensTrend 等页)—— 照搬。

## 里程碑
- **T1(首版 MVP)**:后端聚合查询(weekday×hour,is_human,localtime)+ 新页 7×24 CSS 网格 + hover tooltip + 顶部一行洞察 + 路由/导航。**这就够先跑起来看你自己的 punch card。**
- **T2+**:配菜卡(命令排行 → 习惯曲线 → 纪录),按你看完 T1 后最想要的顺序加。

## The Assignment(下一步真动作)
**先只做 T1 热力图**,别一次铺满配菜。理由:那一眼(看到自己真实的 168 格节律)往往**直接告诉你**下一张配菜卡该是什么 —— 你可能看到「原来我周末也在爆肝」就想要连续天数纪录,或「深夜 prompt 特别长」就想要习惯曲线。让数据的第一印象来排后面的优先级。

跑起来后拿 `/plan-eng-review` 锁 T1 的工程(查询口径 + 页面),或直接开做。

---

## T1 工程规格(plan-eng-review 锁定,codex 二审 10 条全采纳)

**后端 `src/aiRhythm/{queries,routes}.ts`:**
```sql
-- weekday/hour 必须 CAST 成 number(codex#3:strftime 返 TEXT "08"/"0",否则和前端 number key 错开)
-- 坏时间戳过滤(codex#4:event_at_utc 无 ISO CHECK,不可解析 → strftime NULL)
SELECT CAST(strftime('%w', event_at_utc, 'localtime') AS INTEGER) AS weekday, -- 0=周日
       CAST(strftime('%H', event_at_utc, 'localtime') AS INTEGER) AS hour,
       COUNT(*) AS count
FROM agent_user_messages
WHERE is_human = 1 AND strftime('%w', event_at_utc, 'localtime') IS NOT NULL
GROUP BY weekday, hour
```
- **DTO**:`{ cells:[{weekday,hour,count}], maxCount, total, peak: {weekday,hour,count} | null, generatedAt }`。
  - `peak` **空库为 null**(codex#2),非空时 TS 侧算,**tie-break 明确**:count 最大 → weekday(周一起)最早 → hour 最早(codex#5,别靠 SQLite 返回序)。
  - `generatedAt` = now(codex#1:诚实新鲜度)。weekday/hour 是 number。
- **路由**:必须在 `src/serve/app.ts` 的 `createApp` 里注册(codex#6:写 routes.ts ≠ 挂载)。`GET /api/ai-rhythm/heatmap`(v1 无参)。
- **模块 DRY**(codex#9):weekday×hour 是 agentUserMessages 没有的新口径,localtime 概念复用 timeWindow;`is_human=1` 谓词轻,不强抽共享 helper —— 但**别复制既有的 source/window 口径**,只做热力图这一件事。

**前端:新页「已索引消息节律」**(codex#1:诚实命名,不叫「我的全部消息」;顶部标更新时间)
- **复用仓库已有热力图组件**(codex#10:`web/src/components/TagTimeHeatmap.tsx` / `GithubHeatmap.tsx` 已有先例)——**不从零搓 CSS grid**,借它们的格子/配色/tooltip。
- **三态齐**(codex#8:`apiGet` 非 2xx 抛错):loading / error / empty(空库友好提示)+ 除零守卫(maxCount=0)。
- **无横向滚动**(codex#10 + CLAUDE.md 硬约束):24 列固定尺寸在展开侧栏 + `max-w-[1760px]` 下不溢出;兜底 `overflow-x-auto` 容器。
- `%w` 0=周日 → 前端映射周一起显示。改 `App.tsx` lazy route + `Layout.tsx` 侧栏 nav。

**测试:**
- 后端查询(pin 北京):weekday×hour 分桶 + localtime + is_human 过滤 + CAST 出 number + maxCount/peak(**含 tie-break 用例**)+ **坏时间戳过滤** + **空库(cells=[], maxCount=0, peak=null)**。
- **createApp 集成测试**(codex#6):`createApp({db})` 打 `/api/ai-rhythm/heatmap` → 200 + shape(证明已挂载,不只是独立 Hono app)。
- 前端(codex#7/#8):页面渲染网格 + loading/error/empty 三态 + route/nav 接线。

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| Eng Review | `/plan-eng-review` | 架构与测试(必需) | 1 | CLEAR | 1 架构决策(模块边界)+ codex 10 条全采纳 |
| Outside Voice | codex | 独立二审 | 1 | issues_found | 10 findings,全采纳 |

- **CODEX:** 抓到真 bug(#3 CAST 否则 zero-fill 错位、#5 peak tie-break 不定、#2 空库 peak、#4 坏时间戳 NULL)+ 大 DRY(#10 仓库已有热力图组件,别从零搓)+ 诚实点(#1 命名/新鲜度)+ 测试缺口(#6 createApp 集成、#7/#8 前端三态)。全部折进 T1 规格。
- **CROSS-MODEL:** 唯一触及你决定的是 #9(模块 DRY),但你已选新模块 aiRhythm 且 codex 未推翻,只提醒别复制口径 —— 已在规格里注明。
- **VERDICT:** ENG CLEARED — 可实现 T1。

NO UNRESOLVED DECISIONS
