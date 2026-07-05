# 习惯演变曲线 —— AI 节律仪表盘配菜卡 #3(设计)

> office-hours(builder)产出。给「我的 AI 节律」仪表盘加第三张配菜卡:三源迁移周趋势。
> 只出设计,不写码。下一步:直接实现(复用 aiRhythm + recharts 范式)。

## 定位

一条随周的趋势,看你的**工具习惯怎么变**。真实数据里有清晰故事:
W16–20 几乎纯 **codex**(每周 200–490 条)→ W21 claude 冒头 → **W22 claude 546 反超 codex 121** →
W23–26 claude 主导 + opencode 上线。**你 5 月底从 codex 转向 claude**,一眼看得出。

## 锁定决策(office-hours D1)

**三源迁移(堆叠面积,周计数)**。不做 prompt 长度那条 —— 真实数据里它噪声大、均值被一次巨型粘贴(W24 均值 1695)污染,做得改中位数,故事也弱(留作以后)。

## 后端 `src/aiRhythm/queries.ts`(加 `weeklySourceMix`)

```sql
SELECT strftime('%Y-W%W', event_at_utc, 'localtime') AS week,
       SUM(source = 'claude')   AS claude,
       SUM(source = 'codex')    AS codex,
       SUM(source = 'opencode') AS opencode,
       COUNT(*)                 AS total
FROM agent_user_messages
WHERE is_human = 1
  AND strftime('%Y-W%W', event_at_utc, 'localtime') IS NOT NULL   -- 坏时间戳守卫(同热力图口径)
GROUP BY week ORDER BY week
```
- SQLite `SUM(source='claude')` = 该源计数(每行 1/0);本地周桶;坏 ts 剔除。
- **DTO**:`{ weeks: [{week, claude, codex, opencode, total}], generatedAt }`。空库 weeks:[]。

## 前端(热力图页加第四张卡,放命令排行下方)

- 标题「习惯演变 · 三源迁移」+ 副「你的工具从 codex 转向了 claude」。
- **recharts 堆叠面积**(复用 WorkTokensTrend 的 ResponsiveContainer 范式):x=周,三条堆叠 Area,
  色 claude `#d97757` / codex `#2563eb` / opencode `#7c3aed`(与全 app 一致)。高度 ~180px 紧凑。
- 空库 → 「还没有足够数据」。诚实同页。

## 边界 + 测试(沿用前三卡教训)
- 后端 `weeklySourceMix`:周分桶(localtime)+ 三源 pivot 计数 + 坏 ts 守卫 + is_human 过滤 + 排序 + 空库([])。
- **createApp 集成**:`createApp({db})` 打 `/api/ai-rhythm/source-trend` → 200 + shape。
- 前端:有数据(渲染图 + 图例)/ 空 两态。

## NOT in scope
- prompt 长度中位数趋势、消息强度 —— 数据噪声大,留作以后(要做用中位数)。
- 100% 归一化占比切换、命令趋势 —— 另开。

## ⚠️ 需要你拍板:仪表盘竖向布局
这是**第 4 张卡**(热力图 + 连续 + 排行 + 曲线)。四张全宽叠起来页面必滚,与你「禁止竖着铺太多超屏」的硬约束冲突。
**建议**:热力图当英雄(全宽)+ 其余三张小卡走 **2 列网格**,高度砍半、一屏装下。先把曲线卡做出来,再一起做这个布局收敛。

## What already exists(复用)
- `src/aiRhythm/{queries,routes}.ts` + 前三卡的 createApp 挂载 / 坏 ts 守卫 / 测试范式。
- recharts(WorkTokensTrend 的堆叠 BarChart/ResponsiveContainer)+ 三源色。
- `web/src/pages/AiRhythm.tsx` 页。

## 里程碑 / The Assignment
- **T1**:后端 `weeklySourceMix` + `/api/ai-rhythm/source-trend`(createApp 挂载)+ 测试;前端堆叠面积卡(有/空两态)。
- **紧接**:仪表盘 2 列网格布局收敛(解决竖向超屏)。
- **下一步真动作**:先做 T1 看曲线,然后咱俩定布局。

直接实现,或 `/plan-eng-review` 锁。
