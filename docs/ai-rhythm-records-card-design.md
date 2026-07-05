# 个人纪录卡 —— AI 节律仪表盘配菜卡 #4(设计)

> office-hours(builder)产出。仪表盘的「奖杯架」:一排个人纪录/极值。
> 只出设计,不写码。下一步:直接实现(复用 aiRhythm 范式)。

## 定位

热力图/曲线看趋势,这张卡看**极值和高光**——纯好玩、有炫耀欲。都是 MIN/MAX/COUNT 聚合,数据现成。
真实值:最忙一天 2026-06-27 · 168 条;一小时最多 2026-05-25 14:00 · 81 条;总输入 4269 条(自 4-24);
最大一次输入 341,393 字符。薄横条(像连续卡),不占竖高。

## 锁定决策(office-hours D1)

**4 个经典纪录,横排一行**:最忙一天 / 一小时最多 / 总输入+起始日 / 最大一次输入。里程碑日期(第1000/3000条)不做(价值低 + 需 window function)。最长连续已在连续卡,不重复。

## 后端 `src/aiRhythm/queries.ts`(加 `personalRecords`)

三条聚合(坏时间戳守卫,同前几卡):
```sql
-- 最忙一天(平局取最早)
SELECT date(event_at_utc,'localtime') AS day, COUNT(*) AS count FROM agent_user_messages
WHERE is_human=1 AND date(event_at_utc,'localtime') IS NOT NULL
GROUP BY day ORDER BY count DESC, day ASC LIMIT 1;
-- 一小时最多(平局取最早)
SELECT strftime('%Y-%m-%d %H:00', event_at_utc,'localtime') AS hour, COUNT(*) AS count FROM agent_user_messages
WHERE is_human=1 AND strftime('%Y-%m-%d %H:00', event_at_utc,'localtime') IS NOT NULL
GROUP BY hour ORDER BY count DESC, hour ASC LIMIT 1;
-- 总量 / 起始日 / 最大输入
SELECT COUNT(*) total, MIN(date(event_at_utc,'localtime')) firstDay, MAX(char_len) maxCharLen
FROM agent_user_messages WHERE is_human=1;
```
- **DTO**:`{ busiestDay:{day,count}|null, peakHour:{hour,count}|null, total, firstDay|null, maxCharLen, generatedAt }`。
  空库:两个 null、total 0、firstDay null、maxCharLen 0。

## 前端(热力图页,放连续卡下方 —— 两条薄统计条相邻)

四个 stat 块横排(复用连续卡的大数字+小标签样式):
- 🔥 **168 条** · 最忙一天 6-27
- ⚡ **81 条** · 一小时最多 5-25 14:00
- 📊 **4269** · 总输入(自 4-24)
- 📜 **341K** · 最大一次输入(字符;≥1000 显示 K)
- 空库 → 「还没有纪录」。诚实同页。

## 边界 + 测试(沿用前四卡教训)
- 后端 `personalRecords`:最忙一天/一小时(**平局取最早**)+ 坏 ts 守卫 + is_human 过滤 + MAX/MIN + 空库(null/0)。
- **createApp 集成**:`createApp({db})` 打 `/api/ai-rhythm/records` → 200 + shape。
- 前端:有纪录 / 空 两态。

## NOT in scope
- 里程碑日期(第 N 条是哪天)—— window function,价值低,留作以后。
- 最长连续 —— 已在连续卡。

## What already exists(复用)
- `src/aiRhythm/{queries,routes}.ts` + 前四卡的 createApp 挂载 / 坏 ts 守卫 / 测试范式。
- 连续卡的大数字横排样式。

## 里程碑 / The Assignment
- **T1**:后端 `personalRecords` + `/api/ai-rhythm/records`(createApp 挂载)+ 测试;前端纪录横条(有/空两态)。
- **下一步真动作**:做出来看你自己的高光(那次 341K 巨型粘贴到底是啥),仪表盘五卡收官。

直接实现。
