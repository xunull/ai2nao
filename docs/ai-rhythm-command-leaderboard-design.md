# 命令 / 技能排行榜 —— AI 节律仪表盘配菜卡 #2(设计)

> office-hours(builder)产出。给「我的 AI 节律」仪表盘加第二张配菜卡:命令用量排行。
> 只出设计,不写码。下一步:直接实现(复用 aiRhythm 范式)。

## 定位

命令现在已抽成紧凑 `/名字`(is_human=1)。这张卡回答「你最依赖哪些工作流」—— 一眼看到你的**工作流指纹**。
真实数据:824 条命令调用(占 human 19%),top = `/gstack-office-hours` 178、`/gstack-plan-eng-review` 123、
`/plan-eng-review` 80、`/model` 74、`/gstack-investigate` 50。数据同源,查询进已有 `src/aiRhythm/`。

## 锁定决策(office-hours D1)

**纯排行榜**:top N 命令 + 次数 + 占比横条(像 GitHub 语言条)。不做时段/来源维(时段留作以后每行小注解)。

## 检测口径(核心)

- **命令消息** = `is_human=1 AND cleaned_text LIKE '/%'`。
- **命令名** = 去掉开头 `/` 后的**首个空白前 token**。
- **路径守卫**(必须):若 token 含 `/` → 丢弃。真命令名是 `plan-eng-review` 这种纯 slug;
  绝对路径(如 `/tmp/a/b`)的首 token 含 `/`,据此踢掉(真实库见到 2 条粘贴的绝对路径误命中)。
- `/graphify ./src` → 名 `graphify`(arg 里的 `/` 不影响,只看首 token);`/` 单字符 → 丢弃。

## 后端 `src/aiRhythm/queries.ts`(加 `commandLeaderboard`)

- 取 `cleaned_text LIKE '/%'` 的行(~824,小),**TS 侧提名 + 路径守卫 + 计数**(比 SQL substring 干净、可测)。
- 排序:count 降序,**平局按 name 升序**(确定性)。取 top `limit`(默认 10)。
- **DTO**:`{ commands:[{name,count}], maxCount, totalCommands, distinctCommands, generatedAt }`。
  `maxCount` = 榜首次数(占比条标度);空库全 0/[]。

## 前端(热力图页加第三张卡,放连续卡下方)

- 标题「命令 / 技能排行」+ 副「你最依赖的工作流」。
- 每行:`/名字`(等宽)+ 次数 + 占比横条(宽 = count/maxCount,防除零)。top 10。
- 空库 → 「还没有命令调用」。诚实同页:已索引消息快照。
- **PC 竖向克制**:top 10 紧凑行(~24px/行),整页仍不铺太多。

## 边界 + 测试(pin 北京;沿用前两卡教训)
- 后端 `commandLeaderboard`:提名 + **路径守卫(`/Users/...` 不计)** + arg 不影响名 + 平局 name 升序 + top N 截断 + is_human 过滤 + 空库([]／maxCount 0)。
- **createApp 集成**:`createApp({db})` 打 `/api/ai-rhythm/commands` → 200 + shape。
- 前端:有榜(占比条 + /名)/ 空 两态渲染。

## NOT in scope
- 时段维(每命令峰值小时)、来源拆分 —— 以后每行小注解再加。
- 命令趋势(随时间变化)、命令 × 项目 —— 另开。

## What already exists(复用)
- `src/aiRhythm/{queries,routes}.ts` + heatmap/streak 的 createApp 挂载 / 诚实 generatedAt / 测试范式。
- 前端 `web/src/pages/AiRhythm.tsx` 页 —— 加第三张卡,复用三态 + 诚实标注。

## 里程碑 / The Assignment
- **T1**:后端 `commandLeaderboard` + `/api/ai-rhythm/commands`(createApp 挂载)+ 测试(路径守卫/平局/空);前端排行卡(有榜/空)。
- **下一步真动作**:先做 T1,看你自己 top 榜 —— 那个指纹会告诉你下一步值不值得加时段维,或者仪表盘够了。

直接实现,或 `/plan-eng-review` 锁。
