# 连续天数纪录卡 —— AI 节律仪表盘配菜卡 #1(设计)

> office-hours(builder)产出。给「我的 AI 节律」仪表盘加第一张配菜卡:Duolingo 式连续打卡。
> 只出设计,不写码。下一步:/plan-eng-review 锁工程,或直接实现。

## 定位

热力图告诉你「一天里什么时候忙」。连续天数卡告诉你「你有多久没断过」—— 自量化里最有回来看的动力的一股紧迫感。
数据同源:`agent_user_messages`(仅 is_human,全源),本地日粒度。放热力图下方,查询进已有 `src/aiRhythm/`。

## 锁定决策(office-hours D1)

**Duolingo 式**:当前连续🔥 + 历史最长纪录 + 今天没记录时提醒「别断了」。**grace 规则**(今天或昨天有记录就算当前连续没断)。

## 连续语义(核心规格)

- **活跃日** = 那个**本地日**至少有 1 条 `is_human` 消息(全源合计)。
- **历史最长** `longestStreak` = 有史以来最长的一段连续活跃日。
- **当前连续** `currentStreak` = 以「最近一个活跃日」结尾的连续段长度,**但只有在最近活跃日 = 今天 或 昨天(grace)时才算「活着」**;若最近活跃日 < 昨天 → `currentStreak = 0`(已断)。
- **`todayActive`** = 今天(本地)是否已有记录。当前连续活着但 `todayActive=false` → 前端出「今天还没记录,别断了🔥」。

```
活跃日(本地):  07-01 07-02 07-03 ── 07-05 07-06  (今天=07-06)
                 └──── 连续 3 ────┘   └── 连续 2 ──┘
  历史最长 = 3;当前连续 = 2(最近活跃=今天 → 活着);todayActive = true
--------------------------------------------------------------------
若今天=07-07 且 07-07 无记录:最近活跃=07-06=昨天 → grace,当前连续仍=2,todayActive=false → 提醒别断
若今天=07-08:最近活跃=07-06 < 昨天 → 当前连续=0(已断)
```

## 后端 `src/aiRhythm/queries.ts`(加 `streakRhythm`)

- **取活跃日集**(SQL 只做 DISTINCT 本地日,连续逻辑放 TS —— 比 SQL 窗口/递归简单):
```sql
SELECT DISTINCT strftime('%Y-%m-%d', event_at_utc, 'localtime') AS day
FROM agent_user_messages
WHERE is_human = 1 AND strftime('%Y-%m-%d', event_at_utc, 'localtime') IS NOT NULL
ORDER BY day
```
  (坏时间戳过滤:与热力图同口径,strftime NULL 剔除。)
- **TS 算连续**:把 `YYYY-MM-DD` 转本地零点 Date,相邻差 `Math.round(diffMs/86400000)===1` 即连续(round 容 DST ±1h;北京无 DST)。走一遍求 longest;当前连续从末尾回溯。today/yesterday 用 `now`(可注入,测试 pin)的本地日字符串比对。
- **DTO**:`{ currentStreak, longestStreak, todayActive, lastActiveDay: string | null, totalActiveDays, generatedAt }`。空库:全 0 / null / false。

## 前端(热力图页加一张卡)

- 🔥 **当前连续 N 天**(大字);下面 **历史最长 M 天** + **累计活跃 K 天**。
- 当前连续活着但 `todayActive=false` → 「今天还没记录,别断了 🔥」(暖提醒)。
- 当前连续=0 → 「连续已断,今天发一条重新开始」。
- 空库 → 「还没有记录」。诚实同热力图:数据是已索引消息快照。

## 边界 + 测试(pin 北京;沿用热力图那轮 codex 的教训)
- 后端 `streakRhythm`(TZ pin Asia/Shanghai):
  - 连续段计算:多段有间隔取 longest;单日=1;空库全 0/null。
  - **grace 三态**:最近活跃=今天 → 当前连续含今天、todayActive=true;最近活跃=昨天 → 当前连续保留、todayActive=false;最近活跃<昨天 → currentStreak=0。
  - 坏时间戳过滤。
- **createApp 集成测试**:`createApp({db})` 打 `/api/ai-rhythm/streak` → 200 + shape(验证已挂载)。
- 前端:三态(有连续 / grace 提醒 / 空)渲染。

## NOT in scope
- 历法/月视图纪录、"最忙的一天"等其它纪录卡(另开)。
- 补签/冻结(streak freeze)—— 只读镜像,不做写侧。
- 通知/提醒推送 —— 只在页面里显示。

## What already exists(复用)
- `src/aiRhythm/{queries,routes}.ts` 模块 + `heatmapRhythm` 的 localtime / 坏 ts 过滤 / createApp 挂载 / 测试范式 —— 照抄。
- 前端 `web/src/pages/AiRhythm.tsx` 页 —— 加一张卡,复用其三态 + 诚实标注模式。

## 里程碑 / The Assignment
- **T1**:后端 `streakRhythm` + `/api/ai-rhythm/streak` 路由(createApp 挂载)+ 测试(grace 三态/空/坏ts/createApp);前端热力图页加连续卡(三态)。
- **下一步真动作**:先做 T1,跑起来看你自己**当前连续几天** —— 那个数字会直接告诉你这卡值不值得再加花样(纪录里程碑、活跃月历…)。

跑 `/plan-eng-review` 锁 T1,或直接开做。
