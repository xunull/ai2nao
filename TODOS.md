# TODOS

## 索引

**这一节重写过两次：2026-08-21（编号列表失准）、2026-08-25（完成了没销账）。**

2026-08-21 那次的病是编号错位。这次是另一种：opencode 与 kimi 三天内做完了
5 件事，索引一条都没销，其中 3 条还带着「建议优先看」的加粗 —— 照着它挑活会
挑到已经做完的。**销账和记新条目一样重要。**

下面 68 条按性质分组，组内不排先后（另有 2 条待归档、5 条本轮销账，列在末尾）。
算式：上一版 65 条活跃 − 5 条销账 + 2 条新增 = 62；2026-08-26 +2、2026-08-27 +1、2026-09-01 +3 = 68。上一版头部写的 67 含了那 2 条待归档。**加粗**的是建议优先看的。
标注了实测日期的条目，括号里是当时的真实数字，不是估计。

### 正确性（5）
- **三个 reclean 入口全是死代码** —— `recleanClaude` / `recleanCodex` /
  `recleanOpencode`（`queries.ts:554-562`）**各自 0 处调用**。
  *（2026-08-25 实测。原条目只点名 recleanClaude，实际三个都一样。
  `cleaner_version` 回填机制因此整个不工作，不是 claude 一家的事。）*
- **pricing.ts 关于 Codex 的说法要重新表述** —— `codexAdapter.queryCostRows`
  确实存在（`adapters.ts:344`），但 `codex_token_usage_event` 没有 `cost_usd` 列，
  成本靠 join 价格表现算；而 `pricing.ts:38` 说主力模型 gpt-5.5 不在 LiteLLM 里
  故意留空。*（2026-08-25 实测。「注释说无定价、实际有」这个原表述不准确：
  注释里的 "Codex has none" 说的是 cache-creation，那是对的。）*
- 搜索两条路径的排序规则不一致
- 停更的同步任务审计
- 用户消息清洗：`bash-*` 三个标签的口径分叉
  *（2026-08-25 实测：`cleaned_text` 里仍含 `<bash-` 的有 claude 93 条、kimi 2 条。
  `myMessages.ts:17` 的 v4 注释写明「这不是一刀切」，所以残留可能是有意的 ——
  要先确认口径，再决定这 95 条算不算问题。）*

### 安全姿态（2）
- **`serve` 非-loopback 绑定** —— `--host` 加写接口无认证
- **RAG apiKey 明文落盘** —— `~/.ai2nao/rag.json` 的 `embedding.apiKey`，
  `src/rag/config.ts:111` 明文读取。文件是 0600，靠文件权限而非加密。
  *（此条只在旧列表里出现过，正文没有详细段落）*

### 数据缺口 / 待查清（5）
- codex 的 subagent 会话：AI 回答搜得到但看不出在回答什么
  *（2026-08-25 实测：25789 条 assistant 里 4334 条没有 `answering_user_key`，
  比 2026-08-21 记的 4325 略增。）*
- kimi 的 origin 为 null 是什么原因
- **kimi 的 `cache_creation_input` 确认恒为 0，但不知道为什么**
  *（2026-08-25 实测：6359 个事件合计 0。「是不是真的 0」已经有答案，
  剩下的是「为什么」—— 是 kimi 不做 cache write，还是 wire.jsonl 不上报。）*
- Agent 用户消息：周期性全 id 对账 sweep（源删除检测）
- **claude 有 57% 的会话源文件已被删除** 　*（2026-08-26 加）* —— 220 场里 125 场
  带 `missing_since`，「点进去看」对超过一半的 claude 会话做不到

### 归一 / 技术债（14）
- 看板两个入口函数抽成源适配器注册表
  *（`buildWorkDashboard` 与 `buildWorkTokenRanking` 仍是并列的两个函数。
  2026-08-21 记「已用 sourceCoverage 测试兜底」，那条兜底仍在。）*
- DB 背景的会话收集器缺 range/limit 　*（2026-08-21 加）*
- file-mtime 水位状态机已经有三份
- 外部只读数据源：抽公共同步状态机（等第三个源）
- 全站本地日分桶表达式统一走 `bucketExpr`
  *（原记 5 文件 27 处；2026-08-21 实测剩 6 处；2026-08-25 实测 7 处 ——
  数字口径可能与上次 grep 方式不同，做之前先重新数。）*
- clampLimit 跨项目 DRY 整合
- 其余页面增量迁移到 `<Page>` 框架
- `WORK_DURATION_RULE_VERSION` 不分源 　*（2026-08-25 加）* ——
  四个源共用一个全局常量，改任一源口径会强制四源全量重建
- `work_session_duration.identity_confidence` 是只写列 　*（2026-08-25 加）* ——
  有 4 个写入者、0 个读取者，写反了没有可观测后果
- **新增迁移会打挂已装的打包版** 　*（2026-08-26 加）* —— 用源码验收会把真库升版，
  桌面上那个旧包从此开不了库且报错不可解释
- `~` 缩写 home 是前端的 macOS-only 猜测 　*（2026-08-27 加）* ——
  Linux/Windows 上组头会显示全长路径
- 话题河的新鲜度判断永远为假 　*（2026-09-01 加，预先存在）* ——
  `rebuild.ts` 的 `conversationSourceCount` 数的是 aum 原始 distinct (source, session)，
  而实际建出来的是过完 `isInjectedNoise` + 20 字门槛 + embedding 的数。
  今天 553 vs 508，改动前是 518 vs 475，**一直对不上**。后果是
  `/topics/river` 的「对话主题」页顶部常驻一条「数据可能过期，终端重建」的黄条，
  重建完也不消失。调度任务是无条件重建，所以不会造成反复打 API，只是状态显示错。
  修法：让计数走与 `aggregateConversationSessions` 同一套过滤。
- hermes 六处「明确不加」的判定 　*（2026-09-01 加）* —— 接 hermes 时按
  `docs/agent-source-checklist.md` 逐处判定，以下六处**有意不加**，不是漏：
  `topicStream/conversation.ts`（进话题聚类要重建 embedding，152 条不值）、
  `AiRhythm.tsx` 图例（4 个月 152 条，时间分布太稀）、
  `cards/sourceTrendSvg.ts`（固定几条线的成图，加一条要重新配色）、
  `TOKEN_SOURCES`（hermes 有 250 万 token，但没有 `hermes_token_usage` 表，要先建）、
  `DASHBOARD_SOURCES` 与 `WORK_DURATION_SOURCES`（都要 `project_key`，hermes 没有）。
  其中 TOKEN_SOURCES 那条最值得以后做——token 是真的有。
- hermes 会话在 `/ai-sessions` 里显示「无标题」 　*（2026-09-01 加）* ——
  那页的标题来自 `work_session_duration`，而 hermes 不在该表（无项目归属，
  不建镜像表是有意的设计决定）。hermes 自己的历史页有好标题（直读 state.db）。
  要修得给 `daySessionDetail` 一条拿标题的旁路。

### 性能（3）
- index.db WAL checkpoint 策略
- codex / minimax 的 event 时间索引升级成复合索引
- 会话详情页：给另外四个来源上虚拟化

### 接更多源 / 打通（2）
- MiniMax 成本（pay-as-you-go）定价接入
  *（五个 token 源里唯一按量付费、真能算出钱的一个。）*
- **Work Dashboard 纳入 Cursor / Cherry / AI Chat 来源**
  *（2026-08-25 实测：cursor 与 cherry 各有历史页，但三张注册表
  `TOKEN_SOURCES` / `DASHBOARD_SOURCES` / `WORK_DURATION_SOURCES` 一张都没进，
  `index.db` 里 0 张相关表。是七个源里最大的空白。）*

### Work Dashboard（3）
- Work Dashboard 快照表 + scheduler 自动刷新 　*（2026-08-21 实测：无快照表，未做）*
- Work Dashboard 项目摘要解释层
- Work Dashboard 全量 token 历史统计

### Chrome History / 下载（8）
- Chrome History 域名透视 v2：Public Suffix List / `registrable_domain`
- Chrome History 域名透视 v2：CSV 导出
- Chrome History 域名透视 v2：真正增量派生
- Chrome History 微信文章正文索引
- Chrome History 搜索命中原因展示
- Chrome 下载镜像 v2：`downloads_url_chains` 与可点击源 URL
- Chrome 下载镜像：设计文档（docs）
- 下载目录索引：下载过程中 birthtime / mtime 抖动

### Cursor 接入（4）
- Cursor 对话镜像 + FTS（`index.db`） 　*（2026-08-25 复测：index.db 里仍 0 张 cursor 表）*
- Cursor 集成：LICENSE / NOTICE 与上游署名
- Cursor 设计文档修订（仅 `src/` 实现）
- Cursor opened projects：显示关联 chat session counts

### AI Chat Web Search（4）
- 网页正文抽取
- 专用 Evidence Strip / Panel UI
- 持久搜索缓存与 citation provenance
- freshness / 时间范围搜索参数

### 注意力层 / Atuin（4）
- 注意力层：零权限采样作为 knowledgeC 的降级路径
- 注意力层：shell 命令的交叉证据（Atuin 原始历史）
- Atuin 目录活动：repo 归属
- Atuin 目录活动：接入每日摘要证据层

### 会话与消息体验（4）
- Codex 对话详情：单会话内搜索
- claude-code-history 跨 session「提问流 / 消息搜索」
- AI 对话时间线：共享 AgentMessageTimeline 组件
- Codex / Cursor 历史页也按最近活跃排序 　*（2026-08-21 实测：cursor 仍按 `createdAt` 倒序，`storage.ts:995`，未做）*

### 其他（10）
- 证据可回看层
- stale cache 的 UI 体验
- 跨天工作线程
- README / LM Studio 使用文档
- CopilotKit 自定义 AI Studio UI
- MCP v2 重 tool：search_history + project_overview + 按项目 USD 成本
- token-vs-git v2 　*（2026-08-25 复查：v1 已上线在跑；四条延后项其实是
  「核心 2 条 + 副产品 2 条」。核心里的「精确剔除非 AI 提交」修的是比值正确性——
  现在分母混进手写代码，项目之间不可比。）*
- 首页线索的曝光 / 点击日志
- Cosmos 本地 embedding fallback 　*（2026-08-21 实测：0 处本地 embedding 代码，未做。此条只在旧列表里，正文没有段落）*
- RAG：Evidence 载荷与「证据可回看层」DTO 对齐 　*（同上，只有一句话）*

### 2026-08-25 销账（做完了，从上面移除）
- **opencode 的 AI 正文入库** —— 实测 2260 条 assistant 行在库
- **opencode 的 `raw_payload_json` 附件内联** —— `src/blobStore.ts` 按 sha256 抽出
- **opencode 接进 token 趋势页（第 5 个源）** —— `TOKEN_SOURCES` 含 opencode
- **`work_session_duration` 纳入 opencode / kimi** ——
  表里四个源齐全；kimi 口径是「按会话合并」（N 个 agent 并成一条时间轴）
- Agent 用户消息统一库（`agent_user_messages`）—— claude/codex/kimi/opencode 四源在库

### 待归档（正文还在，但已实测完成 —— 等你定要不要删正文）
- **Claude Code 本地对话（v1）** —— `/claude-code-history` 与
  `/claude-code-history/s/:sessionId` 都已上线（`web/src/routes.ts:48-49`）。
  正文的「已定约束」段落可能仍有参考价值，没有径自删除。
- **workDashboard / sessionMemory 取「最近 N 个项目」而非 alpha 前 N** ——
  `aggregate.ts:866-867` 已是 `.sort(按 lastUpdatedAt 倒序).slice(0, limitProjects)`。

### 旧优先级列表的排序说明（存档）

原列表附有一段说明，解释了若干条目之间的依赖与先后。其中仍然成立的部分：
Chrome 下载镜像 v2 与其设计文档依赖 v1（`chrome_downloads` 表与同步）落地；
Cursor 的 FTS 入库要等 `src/cursorHistory` 的 DTO 与只读路径稳定；
LICENSE / NOTICE 要在从参考目录移植算法时落实；设计文档修订是把
「workspace 依赖 cursor-history」的段落改成「仅在 `src/` 实现、参考目录不 import」；
RAG 的 Evidence DTO 对齐要等 v1 引用与双写链路稳，避免与首版抢复杂度。

## Claude Code 本地对话（v1）

What: 在 **`~/.claude/projects`** 下列出各子目录作为项目，枚举各项目下的 `*.jsonl`，按行解析并在网页展示；刷新按钮重新扫描。

已定约束:

- **项目根** = `~/.claude/projects`（每个**直接子目录**算一个项目；不从 `~/.claude` 根把 `projects` 以外的目录当作项目）。

## 证据可回看层

What: 在每日摘要卡片下增加可回看的证据，例如命中的 repo、代表命令、时间跨度、置信提示。

Why: 这会把“看起来聪明”的摘要升级成“用户能核对、能相信”的摘要。

Pros:
- 让用户能自己判断摘要是不是站得住脚
- 让后续 debug、误归因排查、提示词调整更容易
- 为未来更强的工作记忆层打下可解释基础

Cons:
- 会让 UI、payload 和测试面一起变厚
- 不适合和 v1 的单日摘要主线一起落地

Context:
当前 v1 已明确锁定为 `/atuin` 单入口，先把结构化 payload、repo 归属、degrade 边界、ship-block 测试跑稳。证据层不是当前版本的阻塞项，但它是把摘要从“会说”推到“可信”的第一优先级 Phase 2 工作。

Depends on / blocked by:
- 稳定的单日 `facts` 骨架
- 稳定的 repo 归属与 `degradeReason`
- 已落地的摘要主线与缓存边界

## stale cache 的 UI 体验

What: 当某日已有旧摘要缓存且用户触发刷新时，先显示旧结果并明确标记“正在更新”，新结果回来后再替换；若刷新失败，也要让用户看见这是旧缓存而不是最新结果。

Why: 这会把当前“有缓存”和“正在刷新”从实现细节变成用户可理解的状态，避免 silent stale。

Pros:
- 用户不会把旧摘要误认成刚生成的结果
- 刷新失败时仍有可读内容，不会整块空白
- 和之前设计里定下的 stale cache 策略对齐

Cons:
- 前端状态会比现在更复杂，需要区分 cached、refreshing、refresh-failed、fresh
- 测试面会增加，尤其是刷新失败和旧新切换时机

Context:
当前实现已经有 sidecar cache，但 UI 主要表现为普通 cache hit / refresh，还没有把“这是旧缓存”“正在更新”“刷新失败但保留旧结果”清楚表达出来。这是第二优先级，因为它直接影响用户是否信任缓存。

Depends on / blocked by:
- 已存在的 cache key / version metadata
- 前端摘要卡片状态机继续保持按日期隔离
- 至少一条覆盖 stale -> refresh success / stale -> refresh failure 的 UI 测试

## README / LM Studio 使用文档

What: 在 `README.md` 里补一段每日摘要功能说明，至少包含启用命令、LM Studio 本地服务地址格式、模型配置方式、降级行为说明。

Why: 当前功能已经能跑，但使用知识主要散落在对话里。文档不补，未来自己回来看也会重复踩同样的启动和配置问题。

Pros:
- 新旧自己都能更快上手，不用翻聊天记录
- 把 `--daily-summary` 入口和模型配置方式说清楚（每日摘要已改为复用 llm-chat「设置 → AI 与模型」，`--llm-base-url`/`--llm-model` 已移除）
- 降低“为什么只出了 factual recap”这类误解

Cons:
- 不是产品功能本身，不会直接提升摘要质量
- 需要跟实际 CLI 参数和行为保持同步

Context:
当前实现已经支持 LM Studio / OpenAI-compatible 本地服务，也已经有 loading、degrade、sidecar cache 这些行为。但仓库文档还没有把这条能力写清楚，属于很容易拖着拖着就忘的低风险高回报项。

Depends on / blocked by:
- 当前 CLI 参数和实际行为基本稳定
- README 中保留本机优先、显式开启、可能降级到 factual recap 的说明

## 跨天工作线程

What: 把单日摘要串成跨天脉络，识别昨天开始、今天继续、明天还会继续的工作线程。

Why: 这会把“每日回顾”升级成更接近工作记忆层的东西，而不是一张张彼此割裂的日卡片。

Pros:
- 为周报、检索、长期回放提供更高价值的素材
- 能更好回答“我这周到底在推进什么”
- 让 `Next up` 从单日猜测升级成连续上下文

Cons:
- 明显超出 v1，会引入跨日关联、命名稳定性、误归因和 UI 组织的新复杂度
- 如果单日摘要本身还不稳，跨天拼接会把误差放大

Context:
当前 v1 的目标仍然是可信的单日回放，不是完整工作记忆系统。跨天线程是明确的 Phase 2 路线，但应该建立在单日事实层和缓存边界已经跑稳之后。

Depends on / blocked by:
- 稳定的单日 `facts` 与 repo 命中
- 已定义清楚的缓存指纹和版本元数据
- 单日摘要质量边界已经通过测试验证

## Chrome 下载镜像 v2：`downloads_url_chains` 与可点击源 URL

What: 在 v1 仅镜像 Chromium `downloads` 表（及 `referrer` / `tab_url` 等字段）的基础上，读取 `downloads_url_chains`（或当前版本等价表），拼出重定向后的最终 URL，并在 Web 列表中提供可点击的「源地址」或完整链说明。

Why: v1 可能无法代表用户实际点击的起始链接；补上 URL 链后，回看价值更接近 Chrome「下载内容」里的真实上下文。

Pros:
- 列表信息与浏览器下载管理器更一致
- 便于排查「从哪个页面触发的下载」

Cons:
- SQL 与同步逻辑变厚，需处理多版本 schema
- 测试需要构造含 url chain 的 fixture

Context:
来自 `/gstack-plan-eng-review` 对 Chrome 下载镜像设计的后续项；与 office-hours 设计文档中的 Open Questions（`downloads_url_chains` v2）一致。

Depends on / blocked by:
- Chrome 下载镜像 v1 已合并（`chrome_downloads`、同步、API、`/chrome-downloads` 或等价路由）
- 本机或 fixture 上对真实 `History` 的 `.schema downloads_url_chains` 真源

Priority: Phase 2（v1 之后）

## Chrome History 域名透视 v2：Public Suffix List / `registrable_domain`

What: 在 v1 normalized host 的基础上，引入 Public Suffix List 或等价规则，新增 `registrable_domain` 字段用于更准确地聚合 `foo.github.io`、`example.co.uk` 等域名。

Why: v1 按 host 聚合足够简单可信，但真实长期浏览数据里会出现大量子域名；注册域聚合能让 Top domains 更接近用户心智。

Pros:
- 提升域名归组准确性，减少 Top domains 被子域名拆碎
- 可通过 `DOMAIN_RULE_VERSION` + rebuild 机制安全演进

Cons:
- 引入依赖或规则文件，规则解释成本更高
- 规则变化会要求重建派生表，测试面变厚

Context:
来自 `/gstack-plan-eng-review` 对 Chrome History 域名透视计划的后续项。v1 明确不做 PSL，先用 normalized host 保持实现简单；如果真实使用中 Top domains 被子域名拆碎，再做本项。

Depends on / blocked by:
- Chrome History 域名透视 v1 已落地
- `DOMAIN_RULE_VERSION` 与 rebuild 机制已可用

Priority: P2

## CopilotKit 自定义 AI Studio UI

What: 在 CopilotKit runtime 稳定后，重做 `/ai-chat` 自定义外壳，把内置 `CopilotChat` 升级为符合 ai2nao 设计系统的 Modern White AI Studio。

Why: 本轮 CopilotKit 迁移选择先使用默认 `CopilotChat`，迁移速度更快，但不会完全解决 `/ai-chat` “不好看、和业界差太多”的原始痛点。

Pros:
- 把 CopilotKit 的 runtime 底座和 ai2nao 自己的桌面工作台气质结合起来
- 可以重新实现左侧 history rail、固定 composer、状态层、空态 prompt starter
- 避免长期停留在“套了第三方默认组件”的体验

Cons:
- 需要第二轮 UI 实现和浏览器视觉 QA
- 可能要更深入研究 CopilotKit 的 headless/custom UI 能力
- 不是 runtime 迁移的必要条件

Context:
来自 `/plan-ceo-review` 对 CopilotKit 迁移的范围决策：D7 选择先用内置 `CopilotChat`，D11 明确 AI Studio 视觉 polish 移出本轮范围。本 TODO 用来确保“后续做漂亮”不会变成口头债务。

Depends on / blocked by:
- CopilotKit runtime migration 已落地
- `/api/copilotkit`、SQLite 历史和 e2e 会话隔离测试稳定
- 明确 CopilotKit custom/headless UI 接入边界

Priority: P1（CopilotKit 迁移后）

## 全站本地日分桶表达式统一走 bucketExpr

What: 把 `src/aiRhythm/queries.ts`、`src/atuin/queries.ts`、`src/agentUserMessages/queries.ts`、`src/workTokensTrend/queries.ts` 里手写的 `date(X,'localtime')` / `strftime('%Y-%m-%d', X, 'localtime')` 统一改成调用 `src/timeWindow/bucket.ts:24` 的 `bucketExpr(granularity, col)`。

Why: 本地日分桶的语义目前有 5 份副本（全仓库 27 处 `'localtime'` 散在 5 个文件）。改口径要改 5 个地方，漏掉的那几个不会报错、只会安静地按旧口径分桶。`/plan-eng-review` 在评审项目活动日历时发现设计文档差点造出第 6 份副本。

Pros:
- 分桶语义单一事实源；`bucketExpr` 的文件头注释（`bucket.ts:18-22`）就是 per-event 分桶不变式的权威表述
- `bucketExpr` 只接受枚举 granularity，带 TS 类型护栏，防止未来重构把用户输入漏进 SQL 片段
- 未来加时区契约（服务端权威 vs 浏览器权威）时只需改一处

Cons:
- 触碰 4 个已稳定模块，回归面不小，`aiRhythm.*`（6 个测试文件）、`atuin*`、`agentUserMessages.*`（7 个测试文件）、`workTokensTrend` 的测试都要一并跑
- 纯重构，无用户可见收益，容易被无限期推后

Context:
来自 `/plan-eng-review` 对项目活动日历页（`/project-calendar`）的评审。该页已按评审结论走 `bucketExpr`，所以**新代码不再加债**；这条只处理存量。`bucket.ts` 提供 hour / 3hour / day / week 四档，day 档返回 `strftime('%Y-%m-%d', col, 'localtime')`，与现有手写写法产出完全相同的字符串，所以改动是纯等价替换，风险集中在"改漏"而非"改错"。

Depends on / blocked by:
- 无硬依赖，可独立进行
- 建议在 `/project-calendar` 落地之后做，届时能直接拿它当参考实现

Priority: Phase 2（存量清理，不阻塞任何功能）

## Work Dashboard 快照表 + scheduler 自动刷新

What: 为 Work Dashboard 增加派生快照表，并接入 local scheduler 定时刷新。

Why: 当前 Work Dashboard 首版计划选择实时只读聚合；如果真实 Claude/Codex session 很多，首页作为 `/` 可能仍然变慢。

Pros:
- 首页响应稳定，不需要每次打开都扫本机对话文件
- 可以记录 freshness、partial token、扫描错误和上次刷新时间
- 和当前 `codex/local-scheduler` 分支方向契合

Cons:
- 需要 migration、刷新任务、差异同步和 stale UI 状态
- 首版一起做会扩大范围，延迟 dashboard 本体验证

Context:
来自 `/plan-eng-review` 对 Work Dashboard 设计的后续项。本轮审查已要求实时路径加入 `claudeProjectLimit`、`claudeSessionsPerProject`、`codexSessionLimit`、`codexFallbackFiles`、`tokenSessionsPerProject` 等预算。快照表是这些预算仍不够时的 Phase 2，不是首版阻塞项。

Depends on / blocked by:
- `/dashboard` 实时聚合已落地
- 真实数据证明首页扫描慢或用户需要 freshness 状态
- dashboard DTO 和 diagnostics shape 稳定

Priority: Phase 2（实时首页之后）

## Work Dashboard 纳入 Cursor / Cherry / AI Chat 来源

What: 将 Work Dashboard 从 Claude Code + Codex 扩展到 Cursor、Cherry Studio 和 ai2nao 自己的 AI Chat session。

Why: 用户真正关心的是“最近项目工作”，不是某两个工具；Claude/Codex 首版落地后，其他 AI 记录来源会成为明显缺口。

Pros:
- 工作回看更完整，减少跨工具漏归因
- 复用已有 `/cursor-history`、`/cherry-studio-history`、`/ai-chat` 数据
- 为未来统一 AI 记录中心打基础

Cons:
- 各来源项目身份字段差异更大，canonical identity 更难
- 容易把 dashboard 推向统一 `agentHistory` 抽象，复杂度会明显上升

Context:
来自 `/plan-eng-review` 对 Work Dashboard 的范围确认。本轮首版明确只聚合 Claude Code 和 Codex；设计里的 Approach C 也说明统一 AI 记录中心是长期方向，不应挡住当前首页。

Depends on / blocked by:
- Claude/Codex dashboard DTO 稳定
- canonical project identity 跑出真实效果
- Cursor / Cherry / AI Chat 的 session summary 字段足够可靠

Priority: Phase 2/3

## Work Dashboard 项目摘要解释层

What: 给每个 dashboard 项目增加一句本机生成的“最近在做什么”摘要，基于该项目最近 Claude/Codex session 的标题、用户首条消息和可见片段。

Why: 当前首版能回答“哪些项目活跃、多少 session/token”，但还不能直接回答“这个项目最近在推进什么主题”。

Pros:
- 工作回看价值更高，用户不必逐条点 session 才知道项目脉络
- 可与 session memory / RAG 合流
- 为未来跨天工作线程提供更自然的项目描述

Cons:
- 会引入摘要质量、证据可回看、缓存和 stale 状态问题
- 如果首版一起做，首页会从结构化 dashboard 变成 LLM 摘要产品

Context:
来自 Work Dashboard 设计中的 deferred 项：`session memory / RAG 对项目摘要的自然语言解释`。工程审查把首版重点放在 bounded scan、真实 token、canonical identity 和 partial diagnostics。

Depends on / blocked by:
- dashboard 项目/session 聚合稳定
- 证据可回看层或至少 summary source snippets 定义清楚
- 缓存/stale UI 策略稳定

Priority: Phase 2/3

## Work Dashboard 全量 token 历史统计

What: 在实时首页之外，提供按项目、来源、模型的全量 token 历史统计与趋势视图。

Why: 首版为了首页性能采用 bounded token scan，只展示有边界的真实 token 覆盖；如果用户后续想看完整消耗趋势，需要离线或快照统计。

Pros:
- token 数据从“首页证据”升级为可分析资产
- 可支持项目维度成本/强度回看
- 和外部 AI usage dashboard 的常见能力对齐

Cons:
- 需要快照表或定时任务
- 要处理模型维度、历史回填、格式漂移和 coverage 解释

Context:
本轮用户明确选择 token 只使用真实 usage、不估算；工程审查中又接受 `tokenSessionsPerProject` 上限。因此首版不会、也不应该承诺全量 token 历史。本项是 usage 契约稳定后的 Phase 2/3。

Depends on / blocked by:
- `ChatSession.usage` 单一真相已落地
- dashboard 快照表或等价离线扫描机制已落地
- Codex `token_count` 解析经过真实 fixture 验证

Priority: Phase 2/3

## Completed

### git churn per-commit 存储（V60）

**Completed:** 2026-08-26

`git_line_churn` 从 `(project_key, day)` 降到逐提交。解锁「这次很贵的会话 →
对应哪几个 commit」。全程只读，只是 `git log` 多要 `%H` / `%ae` / `%aI` 三个字段。

**它主要是拆掉而不是加上**：v1 的增量写入是累加（同一提交扫两次数字翻倍），
那套 `merge-base --is-ancestor` + 两路写 + 删窗 + 「重扫不双重计数」CRITICAL 单测
全为守它。sha 进主键后写入是 `INSERT OR REPLACE`，幂等由主键保证。

**对抗性冷读证伪了两条载荷性前提**，各有真库反例：
- `sha` **不是**全局唯一：`xibahe-rag` 被 clone 到两个路径，28 个 sha 同属两个
  project_key。只用 sha 做主键 + `pLimit(4)` 并发 → 一个项目产出静默归零且永不自愈。
  → `PRIMARY KEY (project_key, sha)`。
- rescan 删窗**不是**「自动就对」：`--since` 过滤 committer date、`day` 来自
  author date，真库两条相差一年多的提交会双重计数，占被保留历史的 44%。
  → 删窗外加「清掉本次涉及天的遗留行」。

**顺带治好一个 v1 就存在的静默数据丢失**：`insight-git` 的 `last_synced_sha`
被 gc 后 `merge-base --is-ancestor` 返回 exit 128，而 `isAncestor` 只认 exit 1、
其余 throw，外层 catch 又不清游标 —— 它冻结在 2026-01-04 一行，漏了 8 天 27 个提交。
V60 的 `rule_version` bump 恰好绕过 isAncestor 才暴露出来。已把 128 也当重扫。

真库验收：迁移后视图与 `git_line_churn_v59_snapshot` 714 行**逐行相等**；
重扫后 2534 行（2504 真提交 + 30 遗留），floor 以下 32 行 / 12458 行产出一行未少。

### work_session_duration 纳入 opencode / kimi

**Completed:** opencode 2026-08-23（O7a/O7b）、kimi 2026-08-25

原问题：排行页的「活跃时长」列只统计 `claude-code` 与 `codex`，`work_session_duration`
的 CHECK 也写死这两个。kimi-only 的项目时长为空，混合项目的数字不含另两家，
却读起来像项目总时长。

怎么没了的：V59 去掉两张表的 CHECK，约束下沉到 `WORK_DURATION_SOURCES` 这个写入边界；
opencode 与 kimi 各写一个收集器，都只读 `index.db`，**不碰各自的外部库**。

当初记的那条阻碍——「`transcript_path` 假设一个会话一个文件，而 kimi 一个会话有 N 个
agent 文件，接入前必须先定口径」——**前半句被证伪**：V59 已把那三个字段泛化成
「这个会话的原始材料变了没有」，全仓库无人对 `transcript_path` 做 `existsSync`，
填 `MIN(file_path)` 即可。**后半句是对的，而且是全部难点所在**：

```
32 场会话，9 场是多 agent（最多一场 12 个）
按会话合并      89.50 h      ← 选定
按 agent 相加   99.58 h      +11%
最坏一场        110.4 → 454.8 分钟   4.12×
```

那一场是一次派多个 subagent 并行跑 —— 并行 subagent 不会让人多出时间。

真库结果：kimi 32/32 场有时长、0 unknown（比 opencode 的 954/964 还全），
**14 个项目从「一行 duration 都没有」变成有值**，合计 41.34 h，
含 `meng1`(15.05h) 与 `gongren-pipeline`(12.49h)。

顺带修掉：`WorkTokenRanking.tsx:216` 那句 title「opencode 与 Kimi 尚未接入
work_session_duration」—— 它在 opencode 接入后就已经是错的。

### 趋势页「不算缓存」应同时扣 cache_creation（口径 bug）

**Completed:** 2026-08-20（作为原子分量重写的副产品，不是单独修的）

原问题：「计入缓存命中」开关 OFF 时只减 `cache_read`、没减 `cache_creation`，而
07-01 的 off 柱 164M 里 cache_creation 占 147.6M ≈ 90%，开关名不副实。

怎么没了的：趋势页归一时（X1）把存储改成**只存原子分量**
（`freshInput` / `cacheReadInput` / `cacheCreationInput` / `output`），
派生值一律现算。`tokensExcludingCache` 因此从减法变成**加法**：

```ts
// src/workTokensTrend/types.ts:158
export function tokensExcludingCache(u: SourceUsage): number {
  return u.freshInput + u.output;   // cache_creation 是另一个分量,结构上进不来
}
```

减法形式正是逐源漂移与负值的来源；改成加法之后这个 bug 没有藏身之处了。

### RAG：双路检索调试视图

**Completed:** v0.3.15 (2026-05-17)

What shipped:
- `/rag-debug` 展示同一查询下的 FTS、Vector、Hybrid 结果、分数、排名和命中分支。

### RAG：黄金检索评测集

**Completed:** v0.3.15 (2026-05-17)

What shipped:
- `docs/rag-eval-cases.json` 和 `ai2nao rag eval` 支持固定问句、期望命中、Recall@K / MRR / NoHit 回归。

## Chrome History 域名透视 v2：CSV 导出

What: 为 Top domains、domain timeline、drilldown visits 提供 CSV 导出能力，可从 Web 下载或通过 CLI/API 输出。

Why: 这是研究型功能，用户可能想把域名统计带到表格、笔记或外部分析工具里继续分析。

Pros:
- 增强开源/研究场景完整性
- 复用已稳定的 API 查询，便于调试和分享本地结果

Cons:
- 需要确定导出范围、隐私提示和字段稳定性
- 会增加 API/UI 状态与测试面

Context:
来自 `/gstack-plan-eng-review` 对 Chrome History 域名透视计划的后续项。v1 先把派生层、API、UI 查询口径打稳；CSV 不阻塞核心闭环。

Depends on / blocked by:
- `/api/chrome-history/domains/*` 接口稳定
- 字段命名和 half-open date range 语义已写入 README 或设计文档

Priority: P2

## Chrome History 域名透视 v2：真正增量派生

What: 用真正增量派生替代 v1 的 sync 后整 profile rebuild，只处理 `INSERT OR IGNORE` 后实际新增的 Chrome visits。

Why: 如果本地 Chrome history 很大，每次 sync 后全量 rebuild 当前 profile 会变慢；增量派生可以让 watch/sync 更轻。

Pros:
- 大历史库下 sync/watch 更快
- 减少每轮重算带来的 CPU/IO 成本

Cons:
- 要精确追踪实际新增 visits，避免为 skipped visits 生成派生行
- 失败边界更复杂，需要保证 state 不会误报 fresh

Context:
来自 `/gstack-plan-eng-review` 对 Chrome History 域名透视计划的性能后续项。v1 已决定 rebuild-after-sync，并记录 `last_rebuild_duration_ms`、source/derived counts；只有真实数据证明 rebuild 慢，才值得升级。

Depends on / blocked by:
- v1 `last_rebuild_duration_ms` 指标跑出真实慢样本
- freshness state 已覆盖 success、stale、error、count mismatch

Priority: P2

## Chrome History 微信文章正文索引

What: 在当前仅搜索 Chrome History 标题与 URL 的基础上，为 `mp.weixin.qq.com` 等已访问文章建立本地正文索引，支持按文章正文回找看过的微信文章。

Why: Chrome History 只稳定保存标题、URL、访问时间；如果文章标题不含关键词，用户仍然找不到“看过但忘了标题”的文章。正文索引能把微信文章搜索从历史过滤升级为本机浏览记忆。

Pros:
- 可以搜索文章正文，不再完全依赖标题和 URL 参数
- 为后续摘要、证据回看、收藏和本机知识库打下数据基础
- 能和现有 Chrome History freshness 经验对齐，避免旧索引被误认为新数据

Cons:
- 需要处理页面抓取或渲染、登录态、失效链接、反爬和正文解析失败
- 会增加隐私边界：正文落库前必须明确本机存储、范围和重建策略
- 需要 FTS、抓取状态、失败重试、清理策略和 UI 状态，明显不适合塞进当前搜索增强 PR

Context:
来自 `/plan-ceo-review` 与 `/plan-eng-review` 对 Chrome History 搜索增强的 deferred scope。当前 PR 只做 `domain + q + date range`，其中 `q` 搜 Chrome 保存的 title/url；正文索引是后续独立设计，不能被简化成“顺手加 FTS 表”。开始前应先确认数据源策略：直接 HTTP 抓取、浏览器渲染、还是仅对用户显式选中的文章归档。

Depends on / blocked by:
- `/chrome-history/domains` 的域名 + 关键词搜索已经稳定
- `mp.weixin.qq.com` 搜索入口有真实使用反馈
- 明确正文落库、删除、重建与失败可见性策略

Priority: P2

## Chrome History 搜索命中原因展示

What: 在 Chrome History 搜索结果中展示每条访问的命中原因，例如“域名匹配 `mp.weixin.qq.com`”“标题命中关键词”“URL 命中 `__biz`”。

Why: 当前搜索结果只显示标题、URL 和访问时间；当结果来自长 URL 或模糊关键词时，用户需要自己判断为什么命中。命中原因能提升搜索可信度，也让过滤条件调试更快。

Pros:
- 用户能更快判断结果是否相关
- 后续正文索引可以复用同一块解释 UI
- 便于调试 `domain`、`q`、日期范围和 URL/title 匹配语义

Cons:
- 会让结果列表信息密度变高，微信长 URL 尤其容易产生噪声
- 需要扩展 DTO 或前端计算匹配原因，并补 UI 测试

Context:
来自 `/plan-ceo-review` 中对 Chrome History 搜索解释性的 deferred scope。当前 PR 先保持结果列表干净，只保证 `mp.weixin.qq.com` + URL/title 关键词搜索可用；命中原因应等真实搜索反馈稳定后再决定展示粒度。

Depends on / blocked by:
- Chrome History 域名 + 关键词搜索已落地
- 明确是否只解释 title/url/domain，或同时为未来正文命中预留字段

Priority: P3

## Chrome 下载镜像：设计文档（docs）

What: 新增 `docs/chrome-downloads-design.md`（或与 `docs/downloads-design.md` 互链一小节），写清：数据源（`History` 内 `downloads`）、只增不删、与 `download_files` 的区别、默认路径与 profile、`sync`/`watch` 与 `chrome-history` 的关系、API 与页面路由。

Why: 下载目录索引已有 `docs/downloads-design.md`；Chrome 下载镜像若无对等文档，后续自己或贡献者容易混淆两条「下载」能力。

Pros:
- 与仓库现有设计规格风格一致
- 降低 onboarding 与 PR 审查成本

Cons:
- 需与实现及 CLI 帮助保持同步，否则会 stale

Context:
来自 `/gstack-plan-eng-review` 的文档类 TODO；可在 v1 实现 PR 中顺手落地，也可在 v1 merge 后单独补。

Depends on / blocked by:
- Chrome 下载镜像 v1 行为基本定型（命令名、路由、字段）

Priority: P2（建议在 v1 合入前后一周内补齐）

## 下载目录索引：下载过程中 birthtime / mtime 抖动

What: 扫描「下载」目录时，文件在**未下完**或**刚写完**的过程中，`birthtime` / `mtime` 可能随扫描间隔变化，导致同一逻辑文件被插入多行，或去重键与预期不一致。v1 已约定用 **`root_path + 相对路径 + file_birthtime_ms`** 判断是否新记录；若 birth 在部分平台不可用会退化（需与实现一致）。

Why: 这是增量插入策略在「大文件、慢下载」场景下的自然边界；不处理也能用，但数据会变噪。

Pros（处理之后）:
- 减少同一次下载产生多条「假新」记录
- 可与「稳定后再记」或「同路径短时间合并」等策略配合

Cons:
- 要定义何为「同一下载」（size、mtime 区间、轮询间隔），测试与边界变多

Context:
用户明确：**先选 birthtime 作联合键**；**mtime 在下载时会变的问题以后再考虑**，本项记录该后续工作，不阻塞第一版落地。

Depends on / blocked by:
- 下载目录索引功能本身已具备单次扫描、定时扫描、Web 触发扫描
- 若有真实噪声样本（日志或复现路径）再定方案更稳

Priority: P3（体验优化，非阻塞）

## VS Code terminal dirs 工作信号（显式 opt-in）

What: 在 VS Code recent 工作项目入口稳定后，读取 `state.vscdb` 中的 `terminal.history.entries.dirs`，把 VS Code terminal 曾经进入过的目录作为项目活跃度信号。该功能必须显式开启，不能默认抓取。

Why: VS Code recent list 只能说明“打开过哪里”；terminal dirs 能补充“终端实际在哪些目录工作过”。两者结合后，ai2nao 的最近工作项目排序和每日摘要会更接近真实开发活动。

Pros:
- 提升项目活跃度判断，不只依赖 recent list 顺序
- 可与 Atuin shell history、repo index、Claude/Cursor 对话做交叉验证
- 为未来本机工作记忆层提供高信号数据

Cons:
- 目录路径可能包含客户名、挂载路径、服务器路径等敏感信息
- 需要隐私说明、显式 opt-in、脱敏/过滤策略和一键清理
- 会增加 sync、UI、测试面，不能混进 VS Code recent v1

Context:
来自 `/plan-ceo-review` 对 VS Code recent 工作项目功能的 scope expansion。用户已选择 defer terminal dirs：当前 PR 只做 `history.recentlyOpenedPathsList`、repo 关联、remote 安全摘要、missing 状态、项目聚合视图；terminal dirs 单独设计后再做。

Depends on / blocked by:
- VS Code recent 工作项目 v1 已落地并验证隐私边界
- 已有明确的 opt-in 配置与 UI/CLI 提示
- 对路径脱敏、repo 关联、清理/reset 的策略已定

Priority: P2

## Cursor 对话镜像 + FTS（`index.db`）

What: 将 Cursor `workspaceStorage` / `globalStorage` 中解析出的会话与消息（或稳定中间表示）**增量镜像**进 ai2nao 主库，必要时对正文建 **FTS5**，使命令行 `search` 或统一 API 能跨源检索，避免每次关键词搜索都全盘打开多个 `state.vscdb`。

Why: 只读直连在会话多时延迟与 IO 放大；与 Chrome 历史的「先 sync 再查」心智一致，也有利于后续「证据可回看层」引用对话片段。

Pros:
- 搜索与列表性能可控，可做联合查询（repo 清单 + 对话等）
- 离线备份主库即可带走索引视图（若设计允许）

Cons:
- 需要迁移脚本、去重键、与 Cursor 升级后 JSON 形状变更的兼容策略
- 与「实时对话」之间必有同步滞后，产品上要说明

Context:
规划见 office-hours 设计文档中的 Approach A；工程评审确认**首版可在 `src/` 内先做只读全量能力**，镜像作为 Phase 2。参考实现逻辑仅作阅读，镜像代码仍写在 `src/`。

Depends on / blocked by:
- `src/cursorHistory` 输出结构稳定（会话 ID、bubble、时间戳字段）
- 是否允许镜像存全文（隐私与磁盘）的产品决定

Priority: P2（能力完备后的性能与一体化）

## Cursor 集成：LICENSE / NOTICE 与上游署名

What: 若从仓库内 `cursor-history/`（或上游 [cursor-history](https://github.com/S2thend/cursor-history)）**逐段移植**算法与结构，在仓库根 `LICENSE` 旁增加 **`NOTICE`**（或等价段落），列出第三方版权、许可链与来源链接；大段复制的文件头保留 SPDX / Copyright 注释。

Why: 满足 MIT 等许可的署名义务，降低合规与发行风险。

Pros:
- 发版、被 fork、进企业环境时少扯皮
- 贡献者能一眼看出哪段来自上游

Cons:
- 需要有人维护 NOTICE 与实现变更同步

Context:
当前规则：`cursor-history/` **仅参考、不得 runtime import**；在 `src/` 重写时仍可能「实质性相似」，署名是独立义务。

Depends on / blocked by:
- 明确哪些模块属于「移植」而非全新撰写（可在 PR 里标文件级）

Priority: P1（建议在首版合入前或紧随其后的文档 PR 完成）

## Cursor 设计文档修订（仅 `src/` 实现）

What: 更新 `~/.gstack/projects/xunull-ai2nao/you-feat-cursor-history-design-20260408-222328.md`（或迁到仓库 `docs/` 下的正式路径）：删除或改写 **「`package.json` workspace / `file:./cursor-history` + 薄封装」** 的推荐路径；改为 **所有实现位于仓库根 `src/cursorHistory/`（或约定目录）**；补充与 Chrome 能力的产品差异（是否要先 sync）。

Why: 原设计前提已被工程规则推翻；不修订会让后续评审与 onboarding 读到错误结论。

Pros:
- 与 `/gstack-plan-eng-review` 结论一致，减少执行分叉

Cons:
- gstack 目录下设计文需要手动同步或复制进 repo

Context:
若将设计文迁入 `docs/cursor-history-design.md`，README 可链到该文件作为单一事实来源。

Depends on / blocked by:
- 无硬依赖，可与实现 PR 并行

Priority: P2（建议在主线开发启动后一周内对齐）

## Cursor opened projects：显示关联 chat session counts

What: 在 `/cursor-projects` 的项目列表中显示每个项目关联的 Cursor chat session 数量，并允许后续进入对应对话证据。

Why: 打开项目只能说明“编辑器接触过这里”；chat session counts 能说明“AI 对话是否真的围绕这个项目发生过”，让工作上下文更接近真实活动。

Pros:
- 把 Cursor opened projects 从路径列表升级成工作证据入口
- 能复用未来稳定的 `src/cursorHistory` DTO 和路径归因结果
- 为后续项目时间线、证据可回看层、跨源检索提供连接点

Cons:
- 会引入 Cursor chat 扫描、路径匹配和聚合性能风险
- 如果过早实现，会把 `/cursor-projects` v1 从轻量 mirror 扩成多源关联功能

Context:
`/cursor-projects` v1 只复用 `src/vscode/*` recent mirror，通过 `app='cursor'` 展示 Cursor 打开的项目。CEO review 和 Eng review 都决定先不把 `src/cursorHistory/*` 拉进首版，避免 DTO、路径归因、性能边界一起扩 scope。等 Cursor chat 输出结构稳定后，再按 repo/path canonicalization 规则把 session counts 挂到项目行上。

Depends on / blocked by:
- `/cursor-projects` v1 已落地，且 app-scoped query/sync/reset 测试通过
- `src/cursorHistory` 会话 DTO、时间戳、项目路径归因稳定
- 大量 session 下的聚合性能边界已验证

Priority: P2

## Homebrew 清单：Brewfile 导出

What: 基于 `brew_packages` 中已同步的 formula / cask 生成 Brewfile，提供 CLI 导出入口（例如 `ai2nao brew export-brewfile`）或后续 UI 下载按钮。

Why: 软件清单不只是“看见列表”；换机或重装时，用户需要可执行的迁移辅助。Homebrew 官方已有 `brew bundle` / `Brewfile`，ai2nao 应该生成辅助导出，而不是替代 Homebrew 的声明式安装系统。

Pros:
- 让 `/brew` 从只读目录升级成迁移工具
- 复用已落库的 `brew_packages`，实现成本低
- 与 Homebrew 生态对齐，不自创格式

Cons:
- 需要清楚标注这不是安装状态的唯一事实来源
- 如果 `brew_packages` 来自降级同步，导出信息可能不完整

Context:
来自 `/plan-ceo-review` 对 macOS Apps + Homebrew inventory 计划的 SELECTIVE EXPANSION。用户选择 defer，不进入 v1。v1 先做可靠同步、分页 UI、`raw_json` 保存、`software_sync_runs` 和 reset 命令。

Effort estimate: M（human）→ S（CC+gstack）

Priority: P2

Depends on / blocked by:
- `brew_packages` v1 已落地并区分 `formula` / `cask`
- README 已写清 ai2nao 与 Homebrew Bundle / Brewfile 的边界

## 软件清单：Mac App 与 Homebrew Cask 关联

What: 在 Mac App 清单和 Homebrew cask 清单之间建立可信关联，例如识别 `google-chrome` cask 对应 `Google Chrome.app`，让 UI 能显示“此 App 由 Homebrew 管理”。

Why: 用户清理、迁移或排查软件来源时，需要知道一个 GUI 应用是手动安装、系统自带，还是由 Homebrew cask 管理。

Pros:
- 提升软件清单的解释力
- 为 Brewfile 导出、迁移 checklist、卸载提示打基础
- 能减少“同一个软件在两个页面重复出现但没有关系”的困惑

Cons:
- 名称匹配可能不可靠，错误关联会损害信任
- 需要真实同步数据样本后再设计规则

Context:
来自 `/plan-ceo-review` 对 macOS Apps + Homebrew inventory 计划的 SELECTIVE EXPANSION。用户选择 defer，不进入 v1。v1 不做 fuzzy matching，避免让猜测污染本地资产数据。

Effort estimate: M（human）→ S（CC+gstack）

Priority: P2

Depends on / blocked by:
- `mac_apps` 与 `brew_packages` 已有足够真实数据
- 先定义可信匹配规则：明确匹配、弱匹配、未匹配三态，不能把猜测显示成事实

## Codex 对话详情：单会话内搜索

What: 为 `/codex-history/s/:sessionId` 增加单会话内搜索、高亮和 next/prev 跳转。

Why: 长 Codex transcript 里查文件名、命令、错误输出会更快。

Pros:
- 提升长会话回看效率
- 不需要后端 FTS，可复用详情页已加载消息
- 和未来全局搜索互补，解决的是单会话内定位

Cons:
- 增加前端状态、可访问性和高亮测试
- 不阻塞 Codex history v1

Context:
CEO review 已决定 v1 先做结构化展示、工具摘要栏、fallback 诊断和紧凑工具事件。单会话内搜索 defer 到 v1 之后，等真实 Codex 会话长度和 timeline 结构稳定后再做。

Effort estimate: M（human）→ S（CC+gstack）

Priority: P2

Depends on / blocked by:
- Codex history v1 已落地
- 详情页 timeline 结构稳定
- 工具事件折叠/展开规则已确定

## AI 对话时间线：共享 AgentMessageTimeline 组件

What: 抽取共享 `AgentMessageTimeline` 或等价组件，统一 Claude Code / Codex / 后续 AI 对话来源的消息渲染。

Why: 避免 markdown、tool event、warning、thinking、metadata badge 样式在多个页面分叉。

Pros:
- 降低长期 UI 维护成本
- 为未来统一 Agent History 页面铺路
- 让工具事件、warning、thinking 折叠等体验保持一致

Cons:
- 过早抽象会误伤现有 Claude/Cursor 页面
- 需要等 Codex timeline 需求稳定后再抽，否则接口会反复改

Context:
CEO review 已明确不进 Codex history v1。当前 v1 应先实现 Codex 自己的 timeline 规则，尤其是紧凑折叠工具事件和失败命令高亮。等真实使用反馈稳定后，再抽共享组件。

Effort estimate: L（human）→ M（CC+gstack）

Priority: P2/P3

Depends on / blocked by:
- Codex history v1 已落地
- Claude Code 和 Codex 的 timeline 差异已通过真实使用验证
- 至少一次 UI 回归测试覆盖现有对话详情页

## Atuin 目录活动：repo 归属

What: 在 Atuin 目录活动派生层落地后，把 `cwd` 映射到已索引 repo，让目录排行和详情能显示项目级标签。

Why: 原始绝对路径可核对，但用户真正想识别的是“最近主要在哪些项目工作”。repo 归属能把长路径转成更可读的项目活动视图。

Pros:
- 提升目录活动页的可读性
- 为跨源工作记忆、项目级摘要和证据层打基础
- 让 ai2nao 相比 Atuin 原生命令搜索更有产品差异

Cons:
- 路径归属容易出错，错误归属会损害信任
- 必须复用现有 path canonicalization 真源，不能临时写第二套 cwd 匹配逻辑

Context:
来自 `/plan-ceo-review` 对 Atuin 目录活动计划的 SELECTIVE EXPANSION。首版先做派生表、freshness、raw/filtered 口径、CLI/Web rebuild 和目录命令分析；repo 归属 defer 到派生层稳定后做。

Effort estimate: M（human）→ S（CC+gstack）

Priority: P2

Depends on / blocked by:
- Atuin 目录活动派生层已落地
- `cwd`、raw/filtered count、目录命令聚合和 freshness 状态稳定
- 复用 `src/scanner/discover.ts` / path canonicalization 相关规则，避免第二套目录归属口径

## Atuin 目录活动：接入每日摘要证据层

What: 让每日摘要引用 Atuin 目录活动派生事实，例如近期目录活跃度、命令样本、失败率和 freshness 状态，作为可回看的证据。

Why: 每日摘要需要从“AI 说你做了什么”升级为“这些结论有可核对证据”。目录活动派生层正好能提供稳定、可解释的本机工作事实。

Pros:
- 提升每日摘要可信度
- 复用目录活动派生层，让它成为工作记忆基础设施
- 为未来跨天工作线程和证据可回看层提供更稳的数据来源

Cons:
- 会触碰 daily summary payload、缓存指纹、stale 语义和 UI 展示
- 如果过早接入，会把目录页首版和摘要缓存复杂度绑在一起

Context:
来自 `/plan-ceo-review` 对 Atuin 目录活动计划的 SELECTIVE EXPANSION。用户选择 defer，不进入目录活动首版；它应归入既有“证据可回看层”路线，在目录派生层和摘要证据设计稳定后实现。

Effort estimate: M（human）→ S（CC+gstack）

Priority: P2

Depends on / blocked by:
- Atuin 目录活动派生层已落地
- 每日摘要证据层设计稳定
- 明确缓存指纹如何纳入目录活动 rule version、filter config hash 和 freshness 状态

## AI Chat Web Search：网页正文抽取

What: 为 Web Search 增加页面 fetch 和正文抽取，把搜索结果的 title/url/snippet 升级为可审计网页片段。

Why: 首版只使用 Brave Search 返回的摘要，足够完成联网搜索闭环，但证据深度有限。正文抽取能让 AI 回答更可靠，也能和后续专用 Evidence Strip/Panel 更自然地结合。

Pros:
- 提升网页证据质量，减少只凭搜索摘要回答的问题
- 为后续本机 RAG + Web 统一证据层提供更强内容来源
- 能支持用户展开查看网页片段，而不是只看标题和 snippet

Cons:
- 需要处理超时、重定向、HTML 清洗、正文长度和恶意网页内容
- 会引入 robots/版权摘要边界与更厚的测试矩阵

Context:
来自 `/plan-ceo-review` 对 AI Chat Web Search 的 SELECTIVE EXPANSION。用户选择 defer，不进入首版。首版先完成 SearchProvider、Brave provider、server-side tool、敏感查询拦截、短 TTL 内存缓存、最终回答证据引用和 SSE 验证。

Effort estimate: M（human）→ S-M（CC+gstack）

Priority: P2

Depends on / blocked by:
- AI Chat Web Search 首版已落地
- SearchProvider typed errors 和性能预算稳定
- Dedicated Evidence Strip/Panel UI 的交互边界已确认

## AI Chat Web Search：专用 Evidence Strip/Panel UI

What: 在 AI Chat 中增加独立证据条/证据面板，把 RAG 和 Web Search 的结构化 evidence 以可展开、可复制 URL/path、可区分来源的方式呈现。

Why: 首版已经保证 Web Search 结果会被后端综合进最终回答，不再把 raw tool log 当用户回答。但长期看，用户需要能审计“答案用了哪些本机资料和网页结果”，而不是只能从最终回答文字里看引用。

Pros:
- 让本机 RAG + Web 当前信息的差异化更清楚
- 降低用户排查搜索质量和引用来源的成本
- 可以保留 CopilotKit 只做 UI 的边界，同时由 ai2nao 后端提供证据数据

Cons:
- 需要定义 CopilotKit UI 组件外的证据状态来源，避免把 CopilotKit tool/state 逻辑带回后端
- 需要处理历史会话恢复、tool result 为空、失败 evidence_error、长 URL/path 和多工具结果的布局

Context:
来自 AI Chat Web Search 首版发布收口。专用证据面板没有进入 v1；v1 先确保服务端 tool 调用、DSML 拦截、AI SDK v6 tool-result schema、最终回答兜底和 URL/title 引用稳定。

Effort estimate: M（human）→ S-M（CC+gstack）

Priority: P2

Depends on / blocked by:
- AI Chat Web Search 首版运行稳定
- AG-UI tool/result 持久化和最终回答证据综合稳定
- 明确证据面板只消费 ai2nao 后端持久化结果，不引入 CopilotKit 后端逻辑

## AI Chat Web Search：持久搜索缓存与 citation provenance

What: 将 web search 结果、answer citation、provider 元数据和生成时刻持久化，支持会话回放时知道“当时搜到了什么、答案引用了哪些来源”。

Why: 首版选择短 TTL 内存缓存，不把搜索词和结果落 SQLite。这保护隐私并降低首版复杂度，但长期看，AI 回答的引用如果不能回放，就很难审计和复盘。

Pros:
- 回放会话时能保留当时的网页证据上下文
- 支持更强的 citation provenance 和调试能力
- 为未来“本机资料 + Web 当前信息”的研究记录打基础

Cons:
- 需要明确搜索词、URL、摘要和引用的本地持久化隐私语义
- 需要 TTL、清理策略、schema migration 和 stale UI
- 会增加数据库、测试和文档维护成本

Context:
来自 `/plan-ceo-review` 对 AI Chat Web Search 的 SELECTIVE EXPANSION。用户选择首版只做短 TTL 内存缓存，本项作为后续设计记录；实现前必须重新确认隐私默认值和清理策略。

Effort estimate: M-L（human）→ M（CC+gstack）

Priority: P2

Depends on / blocked by:
- AI Chat Web Search 首版已落地
- 统一 Evidence model 和 AG-UI tool/result 持久化稳定
- 用户明确接受搜索词和搜索结果的本地持久化语义

## AI Chat Web Search：freshness / 时间范围搜索参数

What: 为 Web Search 增加 freshness 或时间范围参数，例如最近 24 小时、最近一周、指定年份，并在证据视图中显示实际使用的时间约束。

Why: 首版只做通用搜索。对于“最新版本”“今天新闻”“最近政策变化”这类问题，严格时间过滤比依赖 provider 默认排序更可信。

Pros:
- 提升时效性问题的答案质量
- 让用户看见搜索结果是否真的按时间约束过滤
- 可以复用 SearchProvider status 中的 capabilities 来判断 provider 是否支持

Cons:
- Brave、Tavily、OpenAI hosted search 等 provider 的 freshness 语义不完全一致
- 需要真实查询样本后再设计枚举，否则容易过早抽象

Context:
来自 `/plan-ceo-review` 对 AI Chat Web Search 的 SELECTIVE EXPANSION。用户选择 defer，不进入首版；首版 SearchRequest 只保留 `query` 和 `count`，Provider status 预留 capabilities。

Effort estimate: M（human）→ S-M（CC+gstack）

Priority: P2

Depends on / blocked by:
- AI Chat Web Search 首版已落地
- 至少一个 provider 的基础搜索稳定
- 收集到真实“最新/最近”类查询样本

---

## clampLimit 跨项目 DRY 整合

**What:** 把 `clampLimit()` 这个 6-7 行 helper 抽到 `src/util/numbers.ts`，三处调用点改为 import。

**Why:** 项目里有 3 处近似实现：
- `src/github/radar.ts:260`
- `src/atuin/directoryActivity/queries.ts:17`
- 即将新增的 `src/workRecap/scan.ts` (work-recap 设计文档)

未来调整边界（如 max 值上限策略）需要同步三处，容易漂移。

**Pros:**
- DRY 烟消除，单点维护
- 测试集中
- 后续新增模块直接 import 即可

**Cons:**
- 抽公共 util 有 over-abstraction 风险（虽然 3 处明显够多了）
- 现有调用点参数顺序不一定一致，可能需要小幅 refactor

**Context:** 来源于 `/plan-eng-review` 对 work-recap 设计文档的审查（2026-06-09）。当时选择不在 work-recap PR 中处理以保持 PR 范围聚焦，但记录于此避免遗忘。

**Depends on / blocked by:** 无。可以独立做。

**Effort estimate:** S（human ~30min / CC ~10min）

**Priority:** P3

---


## 30. workDashboard / sessionMemory 取「最近 N 个项目」而非 alpha 前 N

**What:** `workDashboard/aggregate.ts:291` 与 `sessionMemory/service.ts:246` 都 `listProjects(root)` 后 `projects.slice(0, limit)` 取前 N 个项目；当前 `listProjects` 默认 alpha 序，所以取的是「字母前 N」。改为按最近活跃取「最近 N」。

**Why:** 用户在首页/检索里真正想看的是最近在动的项目，不是 a-开头的项目。alpha 前 N 在项目多时会漏掉今天刚用的项目。

**Pros:**
- 首页与 session 检索覆盖到真正活跃的项目
- 复用本 PR 给 `listProjects` 加的 `sort` 参数（未来的 `"recency"` 变体）

**Cons:**
- recency 排序若要 DB 级精确，调用点需注入 db（discover 层保持无 DB，纯 mtime 变体则可无 db）
- 改动两个消费者的取样语义，需各自回归

**Context:** 来自 `/plan-eng-review`（Claude 项目列表按最近活跃排序，2026-06-22）的 Codex 外部意见 #3 旁支。本 PR 已把 `listProjects` 参数化为 `{ sort?: "alpha" }`（默认 alpha，零回归），留好了扩展点；本 TODO 是后续把消费者切到 recency。相关行：`src/workDashboard/aggregate.ts:291,314`、`src/sessionMemory/service.ts:246,249`。

**Depends on / blocked by:** 本 PR 的 `listProjects` sort 参数落地。

**Effort estimate:** S（human ~1h / CC ~15min）

**Priority:** P3

---

## 31. Codex / Cursor 历史页也按最近活跃排序

**What:** 把「项目列表按最近活跃倒序」从 Claude Code 历史页平移到 Codex、Cursor 历史页。

**Why:** 三个工具页排序口径一致，用户体验统一；现在只有 Claude 页是最近序，另两个仍是旧序。

**Pros:**
- 体验一致
- `codex_session_token_usage` 有同款结构与索引（`migrations.ts:1345`），算法可直接平移

**Cons:**
- Cursor 侧需确认有等价的 per-session last_updated_at 落库；没有则要先补
- 三处各自的发现层 + 端点要分别改，量不小

**Context:** 来自 `/plan-eng-review`（Claude 项目列表按最近活跃排序，2026-06-22）。本设计明确范围只做 Claude Code；Codex 同款表已就绪，Cursor 需先核对数据源。

**Depends on / blocked by:** Claude 项目列表 PR 落地（作为参考实现）；Cursor 侧需确认 session 元数据已入库。

**Effort estimate:** M（human ~半天 / CC ~30min）

**Priority:** P3

---

## 32. MCP v2 重 tool：search_history + project_overview + 按项目 USD 成本

**What:** ai2nao MCP server 首版只暴露 3 个薄 SELECT tool（project_tokens / time_spent / external_usage）。v2 补三件重的：
- `search_history`：包 `createSessionMemoryService`，「我上次怎么解决 X」。
- `project_overview`：包 `buildWorkDashboard`，某 repo 的 token/时间/session 快照。
- `cost_trend` 按项目 USD 成本（现成只给全局/分桶）。

**Why:** 这三个价值高但首版风险大；先让 transport / 条件挂载 / 只读句柄 / payload 限制跨稳，再加。

**Pros:**
- search_history 是「数字孪生问答」的核心入口
- project_overview 让 agent 一句话拿到 repo 全景

**Cons:**
- `search_history`：`createSessionMemoryService` 是服务工厂，要接 cursor/cherry/llmChat 句柄 + claude/codex 根，会扩 `ServeOptions`，依赖装配要先理清
- `project_overview`：`buildWorkDashboard` async + 每次读整个历史目录 + 慢 + 可能抛，要配超时/降级/缓存
- 按项目 USD 成本是新聚合（`priceCostByBucket` 无 project 参）

**Context:** 来自 `/plan-eng-review`（MCP 记忆器官，2026-06-25）。首版范围决策 A 把这三件移出，性能评审 + Codex 外部意见双双指向瘦身。参考设计：`~/.gstack/projects/xunull-ai2nao/you-main-design-20260625-144326-mcp-memory-organ.md`。

**Depends on / blocked by:** MCP v1（3 薄 tool + WebStandard transport + 条件挂载 + 只读句柄 + payload 限制）落地。

**Effort estimate:** M（human ~1天 / CC ~40min）

**Priority:** P3

---

## 33. token-vs-git v2

**What:** 项目级「token 消耗 vs git 产出」分析的 v1 落地后,补几件延后的。
**2026-08-25 复查后重新分组** —— 原来平列的四条其实是「两件事 + 两个副产品」:

**核心(捆在一起做,拆开做不出完整价值)**
- ~~**per-commit churn 存储**(Approach C)~~ **2026-08-26 done**(V60):
  `git_commit_churn(project_key, sha, author_email, authored_at, day, added, deleted, commits, is_legacy)`,
  `git_line_churn` 改成视图。v1 评的 `Effort: L / Risk: Med / 过度建设` 两个都反了 ——
  实测 2534 行 / 868 KiB,而且它**移除**了 v1 最脆的累加语义(幂等改由主键保证)。
- **精确剔除非 AI 提交**:把 AI session 时间窗对到 commit,只算 AI 辅助的提交,
  而非作者的全部提交。**四条里唯一修正比值正确性的一条** —— 现在分母混进了手写代码,
  「token/行」系统性偏高,且偏多少取决于各项目手写比例,**项目之间不可比**,
  而「哪个项目最费」正是这个页面存在的意义。

**副产品(上面两条做完后几乎免费)**
- **子目录二级粒度**:v1 输出 repo 级,v2 可展开看 repo 内子目录 token 占比。
  *(2026-08-25 实测过可行性,见下面「子目录粒度的两半」。)*
- **降噪 glob 的 config 覆盖**:v1 硬编码默认排除列表,v2 允许 `~/.ai2nao/config.json` 覆盖。
  (这条其实独立,S 号,想单做也行。)

### 子目录粒度的两半(2026-08-25 实测)

**git 那半:几乎白送。** `parseNumstat.ts:97` 已经把路径解析出来做降噪判断,下一行就扔掉:

```ts
const path = normalizeRenamePath(rawPath);
if (opts.isDenoised(path)) continue;
added += Number(a);        // ← path 到此为止,只累加进按天总数
```

改法是别扔:输出 key 从 `day` 变成 `(day, topDir)`。`git_line_churn` 现在是
`(project_key, day, added, deleted, commits)`,加一列即可。S 号。

**token 那半:库里没有可用信号。** 实测 `agent_user_messages`:

```
claude   14819 条 assistant → 带 tool_use 的 18 条、带 file_path 的 6 条
codex    25789 条           → 10 条、48 条
kimi / opencode            → 0-4 条、0 条
```

那十几条还是正文里**碰巧提到**这些词 —— **入库时工具调用整个没存**,只取了文本。
而源头是有的,随手抽一个 claude JSONL:`tool_use` 357 次
(Bash 45 / Write 27 / Edit 15 / Read 11),`file_path` 53 处全是真实路径。

三条路,选 C:
- **A. 把工具调用也入库** —— `agent_user_messages` 已 232MB,而 `Read` 的返回值
  可能是整个文件,存进去会爆;要存也只能存「工具名 + 路径」不存内容,且要一次全量回扫。
- **B. 查询时按需读 JSONL** —— 不涨库,但每次展开子目录要遍历几百个 JSONL,慢到不可用。
- **C. 用 git 当归因桥** —— 不问「这些 token 花在哪个子目录」,改问「这个会话时间窗内的
  commit 碰了哪些子目录」,再把会话 token 按那些子目录分摊。**C 需要的正好就是核心那两条。**

**结论:单独做「子目录粒度」只能做出 git 那半(每个子目录改了多少行),
做不出 token 那半(每个子目录花了多少 token),而后者才是这个页面存在的理由。**

**Why:** v1 把指标做对(多指标面板、token/行 当透镜、repo 级、窗口准确),但比值分子分母仍是「AI token ÷ 你所有提交的行」的近似;v2 把归因做精。

**Cons:**
- per-commit 存储让 churn 表与查询都变重
- 精确剔除非 AI 提交需要把 session 窗口与 commit 时间对齐,复杂度高

**Context:** 来自 `/plan-eng-review`(项目级 token vs git 产出,2026-06-26)。v1 设计:`~/.gstack/projects/xunull-ai2nao/quincy-main-design-20260626-214731-token-vs-git-output.md`。office-hours + eng-review + Codex 一致把这些移出 v1 以保持「engineered enough」。

**Depends on / blocked by:** v1（git_line_churn 表 + scheduler + 分析页）落地。

**Effort estimate:** 核心两条 M（human ~1天 / CC ~40min）；子目录粒度在其之后 +S；
降噪 config 覆盖可单独做，S。

**Priority:** P3（但「精确剔除非 AI 提交」修的是正确性不是分辨率，
若这个页面要拿来做决策，它应当先于其余三条）

---

## 34. 其余页面增量迁移到 `<Page>` 框架

**What:** app 壳 + `<Page>` 框架(固定页头 + 内容区滚动)已落地,但**只迁移了 Scheduler 一个样板**。其余 **41 个页面**仍未迁移 —— 它们在新壳下能正常滚动,但页头还在内容流里、滚动时会滚走(= 用户最初的痛点在这 41 页未消)。按难度分批迁移:

- **A 组 · 普通数据页(直接 `<Page title subtitle actions>` 包裹,约 34 页)**:Atuin、BashSandboxSettings、ChromeDownloads、ChromeHistory、ChromeHistoryDomains、ClaudeCodeHistory、CodexHistory、CursorHistory、CursorProjects、Cosmos(注意自带 `bg-slate-50 px-6 py-6`)、Downloads、EditorRecentPage、FileView、Github、GithubRadar、GithubTags、Homebrew、HuggingFaceModels、LmStudioModels、MacApps、ProjectOutput、Providers、RagDebug、RagStatus、RepoDetail、Repos、Search、Settings、Vscode、WorkDashboard、WorkRecap、WorkTokenRanking、WorkTokensTrend + 几个微型 stub(CherryStudioHistorySession 145B、Vscode 508B 等)。
- **B 组 · 自有 sticky 页头,迁移时把手搓的 `sticky top-0 ... backdrop-blur` 段去重换成 `<Page>`(3 页)**:CodexHistorySession、ClaudeCodeHistorySession、CursorHistorySession。
- **C 组 · 内部 `thead sticky top-0`,迁移后必须给 thead 加 `top-[57px]` 偏移(= `<Page>` 页头高),否则表头吸到同一 top:0 被页头遮挡(2 页)**:BashPermissions、AtuinDirectories。
- **D 组 · 全高/聊天页,需先给 `<Page>` 加 `fill` 模式(内容占满滚动区、页面不滚)再迁(2 页)**:AiChat、CherryStudioHistory。**AiChat 迁移只能动外层布局,绝不碰 CopilotKit/chat runtime/后端(CLAUDE.md AI 铁律)。**

**Why:** 让全部页面页头钉住、内容区滚动,彻底消掉"看下面内容要把页头滚出屏幕"的反人类体验(CLAUDE.md「禁止垂直堆太多超屏」)。当前只有 Scheduler 享受到。

**Cons:**
- 41 页逐个迁移,体力活;每批要浏览器验收(单测证不了滚动模型)。
- D 组要先扩 `<Page>` 契约(加 fill),改动面更大。

**Context:** 来自本会话 `/design-review` → `/plan-eng-review`。计划文档:`~/.gstack/projects/xunull-ai2nao/quincy-main-plan-appshell-page-frame-20260628.md`。首 PR 已落 3 commit(82935fb tab 重做 / 764a3be 壳改+ScrollToTop+vh 风险页 / e9a3cd0 `<Page>`+Scheduler)。建议迁移顺序:高频数据台先(Repos/Settings/Downloads/Github/WorkDashboard)→ A 组列表类批量 → C 组(加 thead offset)→ B 组(去重)→ D 组(先扩 fill)。每批一个小 PR、独立浏览器验收。

**Depends on / blocked by:** 首 PR 壳改(764a3be)已落地;D 组额外依赖 `<Page>` 加 `fill` 模式。

**Effort estimate:** L（human ~2-3天 / CC ~2-3h,分多批）

**Priority:** P3（增量,不阻塞;按页面重要度逐批做）

---

## 35. claude-code-history 跨 session「提问流 / 消息搜索」

**What:** 把一个项目下所有 session 里用户发过的消息汇成一条按时间的流(提问日记),并支持全文搜索「我之前问过什么」。区别于已设计的单 session 抽屉(只看一个会话)。

**Why:** 单 session「只看我说的」抽屉只解决"打开某个会话查看"。跨会话回看 / 搜索自己历史提问是另一个真需求 —— 翻自己几个月来在某项目里都问过什么、搜一个关键词定位到当时哪个会话。office-hours 的 D1-B 方案,被识别为独立方向后缓办。

**Pros:**
- 把 claude 对话的消息正文真正变成可检索资产(目前消息只在打开详情时实时解析,不入库、不可搜)。
- 一次入库后,工作台/产出统计等也能复用消息级数据。

**Cons:**
- 必须建 `claude_messages` 表 + `claude_messages_fts`(FTS5),改 `refreshClaudeTokenUsage` 在解析 JSONL 时逐条入库,首次要重扫 ~374MB transcript(self-heal full reparse,类似 token usage 的 RULE_VERSION 机制)。
- 入库逻辑要复用 `cleanUserMessage` 的剥注入,否则索引里全是 system-reminder/命令输出噪音(见抽屉特性 Finding 2)。
- 存储与查询都变重。

**Context:** 来自 office-hours(2026-06-29,`~/.gstack/projects/xunull-ai2nao/20260629-design-claude-history-my-messages-drawer.md` 的 premise challenge 与 NOT-in-scope)。当时明确「显示 ≠ 搜索」,本次只做轻量的单 session 抽屉。该抽屉的 `cleanUserMessage` 纯函数是本 TODO 的前置复用件。

**Depends on / blocked by:** 单 session 抽屉特性(产出可复用的 `cleanUserMessage`);需要先定 FTS5 schema 与重扫/自愈策略(可参考 `claude_session_token_usage` 的 RULE_VERSION 自愈)。

**Effort estimate:** L（human ~2-3天 / CC ~2-3h,含建表/迁移/重扫/搜索 UI)

**Priority:** P3（独立大特性,不阻塞抽屉)

---

## MiniMax 成本（pay-as-you-go）定价接入

**What:** 给 MiniMax 用量接入成本估算（按模型 / cache-read / cache-create / 输入输出分别定价），让成本模式下 MiniMax 柱有真实金额。

**Why:** 当前账号是 coding_plan 订阅制,`/account/amount` 每条 `consume_cash=0`,所以成本模式下 MiniMax 恒为 0/unpriced。若未来改用 pay-as-you-go,就需要真实成本。现在做是无用功。

**Pros:** pay-as-you-go 场景下成本图完整。
**Cons:** MiniMax 定价来源未文档化(账单接口本身可能是金额页,`consume_cash_after_voucher` 可能才是真实扣费);模型 × cache 类型的单价表要另查。

**Context:** 2026-07-02 plan-eng-review(MiniMax 作为第 4 个趋势 source)的 codex 外部声音 #10 提出。本轮已决定:MiniMax 成本走现有 unpriced 路径,但**在 `minimax_token_usage_event` 存下 `consume_cash` / `consume_cash_after_voucher`** 字段供日后接定价,不丢数据。验证与口径见 `docs/minimax-token-accounting.md`。

**Depends on / blocked by:** MiniMax 历史 source(B)主体落地后;需先确认 pay-as-you-go 账单里 `consume_cash` 是否为真实金额(subscription 下恒 0,无法验证)。

**Effort estimate:** S（human ~1-2h / CC ~20min,定价表 + cost 路径 minimax 分支 + 测试)
**Priority:** P3（订阅制下恒 0,非阻塞;字段已存,日后接不丢数据)

---

## Agent 用户消息统一库（agent_user_messages）

**What:** 把 claude/codex/opencode 三大 agent 会话里**用户自己发的消息**抽出来汇进 index.db 一张表（source + 时间 + raw/cleaned/is_human + raw_payload），建 FTS5 全文索引，支持跨 agent 搜索 + 输入分析。

**Why:** 三大 agent 现在都是读时、互不相通；要「搜我两周前问过的那句」+「我最常问什么/每天输入量」必须物化 + FTS。Cursor 已有镜像先例。

**Context:** 2026-07-03 office-hours（含 codex 冷读）已锁全部架构，落地路径 = 方案 A（OpenCode 先行纵向切片）。完整设计见 `docs/agent-user-messages-design.md`。

**头号未决:** 中文分词器 —— 现有 FTS 用 `unicode61`+按空格切词，中文词级/子串搜基本失效；建议 `trigram`，落地前先拿真实中文查询手测拍板（见设计文档 §7 + Assignment）。

**状态(2026-07-03):** ✅ **v1(opencode)+ v1.1(claude/codex + analytics)已实现并真实数据验证**（opencode 1050 / claude 21078 / codex 2281 行入库可搜;980 测试绿、web 出包）。清洗器统一到后端(option C)。剩:v2 语义搜索(可选)、周期性 id 对账 sweep(下方 P3)。

**⚠️ 语义已扩(2026-08-17/18):这张表不再只装「用户自己发的消息」。** 上面的 What 写于
只收 user 的时期,现在已经不准确 —— V53 加了 `role` 列,claude 与 codex 的 AI 回答也
进来了(claude 13456 条 / 7.29 MB、codex 12055 条 / 7.66 MB),因为 Claude Code 按 30 天
滚动窗口删本地 transcript,已经丢掉过 75 个会话的 AI 回答。

读这张表时必须知道的三件事:
- **`is_human = 1` 仍然只表示「人说的话」**,10 个既有消费点全部带这个过滤,所以加
  assistant 行没有改变它们的输出(有 IRON RULE 测试守着)。
- **`role` 才是「谁说的」**;`is_human = 0` 现在同时涵盖「注入噪音的 user 行」和
  「AI 的正经回答」两种,单看它会误判。
- **搜索默认仍只搜 `is_human = 1`**,搜 AI 的话要显式传 `role=assistant`
  (`/agent-messages` 上是「AI 说的」筛选器)。

表名 `agent_user_messages` 因此也带上了历史包袱 —— 改名要动 10 处引用 + 3 处 SQL
字符串,2026-08-17 eng review 明确列为 NOT in scope,不是忘了。

**Effort estimate:** M（v1 opencode 纵向切片：human ~2-3 天 / CC ~2-3 轮会话）
**Priority:** P2（新能力，非阻塞；先验最脏的 opencode 源）

---

## Agent 用户消息:周期性全 id 对账 sweep(源删除检测)

**What:** 独立低频调度任务,比对源(opencode 等)的 message id 集合 vs `agent_user_messages` 库里的 id,检测真实删除(opencode 里删了 session),供「源已删」信号或清理。

**Why:** v1 去掉了 `missing_since` —— 增量 watermark 只扫 `time_created >= 水位`,被删的老消息在水位之下、永不再进扫描范围,删除检测形同虚设(eng review 2026-07-03 外部声音#3)。档案本身仍在(从不删),只是无删除感知。

**Pros:** 补上删除感知;只比 id、不读数据,便宜。
**Cons:** 多一个任务;周期性对 3.46GB 源做 id 全扫(id-only 仍是扫);有真实需求前偏投机。
**Context:** agent_user_messages v1(opencode 切片)落地后再考虑。设计见 `docs/agent-user-messages-design.md` D7/§10。
**Depends on:** v1 agent_user_messages 落地。
**Effort:** S(human ~1-2h / CC ~20min) **Priority:** P3(archive 本就不删,非阻塞)

---

## index.db WAL checkpoint 策略

**What:** 给 `index.db` 定一个 WAL 回收策略 —— `wal_autocheckpoint` 阈值，或在 scheduler 空闲窗口跑一次 `wal_checkpoint(TRUNCATE)`。

**Why:** 2026-07-29 实测：`index.db` 898MB，`index.db-wal` 已涨到 43MB，而 `grep -rn "wal_autocheckpoint\|wal_checkpoint" src/` 全仓库只命中 `src/chromeHistory/sync.ts:403` —— 那是对 Chrome 的**源**快照做的，不是对自己的库。WAL 不回收会让读者扫描变慢、崩溃后恢复变慢、磁盘占用单向增长。

**Pros:** 一次性收益，所有读路径受益；崩溃恢复时间可控。
**Cons:** checkpoint 期间会短暂阻塞写者，得挑空闲窗口；TRUNCATE 比 PASSIVE 更彻底但更容易和长事务打架。

**Context:** 桌面壳计划（`~/.gstack/projects/xunull-ai2nao/quincy-main-design-20260729-111531.md`）会把 daemon 变成开机自启、724 常驻。**常驻化直接放大这个问题** —— 以前关终端就断了，以后它整天持续写。写这条时 daemon 还是手动起的，所以现在还不痛。

**Depends on:** 无，完全独立。但如果桌面壳 PR2 落地（daemon 常驻），优先级应上调。
**Effort:** S（human ~1h / CC ~15min） **Priority:** P3（现在不痛，常驻化后会痛）

---

## serve 非-loopback 绑定的姿态（--host + 写接口无认证）

**What:** 给 `ai2nao serve` 定一个非-loopback 绑定时的安全姿态：要么直接拒绝绑非 loopback 地址，要么在非 loopback 时强制要求一个 token。

**Why:** `src/cli.ts` 的 `--host` 可以绑任意地址（默认 `127.0.0.1`），而 API 表面有大量**写接口** —— 设置、provider（写 API key）、bash 审批规则等，全部无认证。今天风险可控，因为这是「你自己手动跑起来的本地服务」。桌面壳计划要把它变成开机自启、724 常驻；一旦有人为了「从平板上看一眼」绑了 `0.0.0.0`，那就不是「本地壳」的问题，而是一个裸露的控制面。

**Pros:** 开源项目，别人会拿它跑在比作者随意得多的环境里；默认安全 + 一个很好改的 flag 历来是事故配方。
**Cons:** 作者本人永远不会绑 `0.0.0.0`，对自己是零价值；token 方案会给「我就想在内网另一台机器上看看」这种合理用法加摩擦。

**Context:** 2026-07-29 eng review 的外部视角（codex）提出。README 现在写的是「默认只监听 127.0.0.1」，但没说改了会怎样。如果桌面壳走到 PR3（真的发 .dmg 给别人），这条应该在发布前处理。

**Depends on:** 无。但应早于「把桌面壳发给别人」。
**Effort:** M（human ~4h / CC ~40min） **Priority:** P2（发布桌面壳前处理；只自己用则 P3）

---

## 首页线索的曝光 / 点击日志

**What:** 记录每次 `/api/home/leads` 渲染了哪些 `leadId`、用户点了哪一条、跳去了哪个路由。一张表 + 一个上报端点。

**Why:** 这是**唯一**能回答「首页今日线索到底有没有用」的数据。原本的验证方案是「两周后看冷页访问量涨没涨」,但 2026-08 起主要使用桌面壳,Electron 有自己的存储、**不写 Chrome 历史** —— 当初产出这个方案的那份测量(4-7 月 1972 次访问)现在已经观测不到自己的结果了。而且 page-view 增长本身也测错了东西:它证明不了是哪条 Lead 起的作用。

**Pros:**
- 能按 leadId 看哪些探针有人点、哪些从来没人理 —— 没人理的探针该删,这是唯一的依据
- 顺带补上 ai2nao 对自己的可观测性(它记录了 Chrome / Atuin / 五家 AI 工具的行为,唯独不记录自己)

**Cons:**
- 新建一张表 + 一个上报端点 + 前端埋点
- 在首页 v1 落地之前建它是空转
- 「自己记录自己」要想清楚保留策略,否则又是一张单向增长的表(参见 `scheduled_task_runs` 已 12 万行)

**Context:** 来自 `/plan-eng-review` 对首页设计文档的 outside voice(codex,2026-08-08)第 10 条。设计文档 `~/.gstack/projects/xunull-ai2nao/quincy-main-design-20260808-211622.md` 的 Open Questions 第 1 条记的就是这个问题,当时没有答案。

**Depends on:** 首页 v1 落地(没有 Lead 就没有曝光可记)。

**Effort:** M(human ~4h / CC ~40min) **Priority:** P2(v1 之后立刻做,否则无从判断该不该扩展探针)

---

## 停更的同步任务审计

**What:** 逐个决定 27 个定时任务里那 6 个 disabled、5 个永久 partial 的到底该开、该删,还是该改判定。

**Why:** 2026-08-08 实测:`ai_tools.scan` 从未跑过(OFF, last=None,数据停在 7-21)、`atuin.directories.rebuild` OFF 且最后成功在 6-18、`work.cosmos.refresh` 停在 6-28、`minimax.tokens.sync` 停在 7-02、`chrome.domains.rebuild` 停在 6-18。**对应页面照样展示这些陈数据,不做任何声明。** 另有 5 个任务每次都 partial,其中 `git.commits.sync` / `git.line_churn.sync` 的原因只是 812 个仓库里有 32 个**空仓库** —— `git rev-parse HEAD` 在没有 commit 的仓库上必然失败,却被记成 error。永久黄灯等于没有灯,真出问题时看不出来。

**Pros:**
- 停更的数据源要么恢复、要么页面上标「数据截止 X」,不能装作是新的
- 把空仓库从 error 里排除,partial 才会重新有意义
- 首页的 `data.stale` 探针上线后,这些会天天挂在你眼前 —— 早晚要处理

**Cons:**
- 27 个任务逐个看是体力活
- 有些当初关掉可能是有理由的(比如 cosmos 刷新太贵),得先查清再动

**Context:** 来自 `/plan-eng-review`(2026-08-08)的 Step 0 调查。首页设计的 `data.stale` 探针(决定 T1A)会让这些**可见**,但可见不等于修好。

**Depends on:** 无。但建议在首页 v1 之后,那时你会天天看见它们。

**Effort:** M(human ~3h / CC ~30min) **Priority:** P2

## 注意力层:零权限采样作为 knowledgeC 的降级路径

**What:** 用 `lsappinfo` 轮询采集前台应用，作为 `knowledgeC.db` 失效时的第二条采集路径。`attention_focus_spans.source` 列已预留 `'sampler'` 取值，下游 spans / queries / routes 全部复用，不需要新迁移。

**Why:** 注意力层 v1 把全部赌注压在一个 Apple 不作兼容性承诺的私有数据库上。三种情况都会让功能整个归零且没有退路：macOS 升级改 schema、用户撤销完全磁盘访问、Apple 移走或重构 CoreDuet。来自 `/plan-eng-review`(2026-08-10)的 outside voice 第 5 条：「把私有系统数据库当稳定接口……rowid/reset anchor 只处理部分重建问题，处理不了语义漂移」。

**Pros:**
- 零 TCC 权限，不需要完全磁盘访问，和项目「本地优先 + 数据边界清晰」的叙事一致
- 口径完全自主：什么算一段专注、白名单采哪些、多久算离开，全由 ai2nao 定，永不因 Apple 改库失效
- 实测成本极低：`lsappinfo front` + `lsappinfo info -only name,bundleid` 约 **18ms/次**，能拿到显示名、bundle id、pid、启动时间；scheduler 和桌面壳常驻都是现成宿主
- 解锁 CLI / npm 安装路径 —— knowledgeC 路线因为 FDA 授权主体问题只支持 `.app`（见 D5）

**Cons:**
- 没有历史，只能从启用那天开始积累
- serve 未运行的时段会有洞，需要在数据体检里显性化
- 采样精度低于系统级记录，快速切换可能采不到

**Context:** 本轮实测数据（2026-08-10，本机）：`knowledgeC.db` 17.9MB 且当日仍在写入，但被 TCC 拦截（**目录级**拦截 —— `ls` 目录返回 `total 0`，`ls` 完整路径能拿 stat）。零权限替代已验证：`lsappinfo` 可用，`osascript` 取 `AXTitle` 可拿窗口标题（需辅助功能权限），`pmset -g log` 有 33323 条睡眠唤醒记录可用于给专注段封口。本机 152 个 GUI 应用在跑。

**Depends on:** 无前置依赖。但实现价值取决于 knowledgeC 路线先跑起来、并证明注意力数据确实有用 —— 否则两条路径都是白建。

**Effort:** M(human ~2d / CC ~40min) **Priority:** P2

## 注意力层:shell 命令的交叉证据(Atuin 原始历史)

**What:** 让 `/attention` 的交叉层能回答「那段时间我在终端里跑了哪几条命令」。

**Why:** `/plan-eng-review`(2026-08-10)把 atuin 列为交叉层的五个源之一，实现时才发现
`atuin_directory_activity_commands` **是聚合表而不是事件表**：主键是 `(cwd, command)`，带
`raw_count` / `filtered_count` 和 `first_timestamp_ns` / `last_timestamp_ns`。它能回答
「这条命令最后一次是什么时候」，回答不了「14:00–14:30 之间跑了哪几条」。所以交叉层首版只接了
4 个源（git 提交 / Chrome 浏览 / token 事件 / agent 提问），终端这一块是空的 —— 而终端恰好
是实测中前台时长第二高的应用（Warp 1656 分钟 / 20 天）。

**Pros:**
- 补上交叉层最有说服力的一半：「Warp 前台 2 小时」× 「跑了这 47 条命令」才是这个功能的卖点
- Atuin 原始库 `~/.local/share/atuin/history.db` 是逐条事件，带 timestamp / duration / exit / cwd
- 只读外部 SQLite 的形状在 `src/attention/read.ts` 和 `src/chromeHistory/sync.ts` 都有先例

**Cons:**
- 又一个外部只读源，又一套同步状态机（第三个 —— 到时候该抽公共 util 了，见本文件另一条 TODO）
- Atuin 库可能加密（取决于用户配置），需要先探测
- 首版可以只做「按时间区间查询」而不落库，但那样每次翻页都要开外部库

**Context:** 交叉层的 `UNSUPPORTED_SOURCES` 常量里已经声明了这个缺口和原因，页面上会显示
「shell 命令暂不可交叉」而不是假装那段时间没敲过命令。实测：真实数据上一天的交叉结果是
commit=12 / visit=103 / token=1371 / msg=63，终端那一列是 0。

**Depends on:** 无。但建议在 `/attention` 页面（T9）之后做，那时能直接看到缺了这一块的样子。

**Effort:** M(human ~2d / CC ~40min) **Priority:** P2

## 外部只读数据源:抽公共同步状态机(等第三个源)

**What:** 把 `src/chromeHistory/sync.ts` 和 `src/attention/sync.ts` 里那套同步状态机抽成公共 util：单调 row-id 水位、source instance id + anchor 三件套的源库重置检测、首轮 0 行也要写基线。

**Why:** 现在有两份形状一样的实现。两份不抽是有意的（rule of three 还没到，而且两者主键维度不同：Chrome 那份按 browser profile 分区，attention 那份是单源，现在抽会把一个对 attention 毫无意义的 `profile` 参数强加给所有调用方）。但两份会静默漂移 —— 而这套状态机的每一种失败都是静默的：水位漏行不报错、源库重置后停死不报错、首轮吞数据不报错。目前靠两边互指的注释维持可发现性，那依赖人去读。

**Pros:**
- 第三个源出现时，一次抽象三处受益，且新源不用重新踩一遍这三个坑
- 这三个坑各自都在这个项目里真实发生过（git_commits 停 22 天、desktopShell 首轮吞事件）

**Cons:**
- 抽早了会把先出现的那个源的形状固化成契约
- 需要同时改两处已在生产的采集路径，回归面不小

**Context:** 来自 `/plan-eng-review`(2026-08-10) D6 决议：「先平行实现，两边留互指注释 + 一条 TODO」。两个 `sync.ts` 的文件头已经互相指向并写明了共同的坑。触发条件是**第三个只读外部 SQLite 源**接入 —— 最可能是 TODOS 里那条 Atuin 原始历史。

**Depends on:** 第三个外部只读源。没有它就不要动。

**Effort:** M(human ~1d / CC ~40min) **Priority:** P3

---

## 用户消息清洗:bash-* 三个标签的口径分叉

**What:** 让后端 `cleanClaudeUserMessage`(src/claudeCodeHistory/myMessages.ts)覆盖 `bash-input` / `bash-stdout` / `bash-stderr` 三个控制标签,或明确写下为什么不覆盖。

**Why:** 前端 `web/src/util/controlTags.ts` 把这三个列进 `CONTROL_TAG_NAMES`(12 个之三),详情页 `parseUserMessage` 据此把 `!` 命令回显切成 command chip + 终端块。但后端清洗两条路都不管它们:`PAIRED_TAGS`(:21-30)没列,兼容正则(:63-66)只盖 `command-*` / `local-command-*` / `system-reminder` / `task-*`。结果是同一条消息在详情页是 chip、在「只看我说的」抽屉里是带尖括号的原文,并且标签文本会被当人类词汇写进 `agent_user_messages_fts` —— 以后搜自己的提问历史会搜到 `<bash-stdout>` 这类噪音。

**Pros:**
- 消掉一处已确认的前后端口径分叉(第三处口径 `conversationFilter` 已在阅读模式里靠「后端打标记」避免了,这条是遗留的那处)。
- 全文索引里少一批伪词汇,跨会话搜索质量直接受益。

**Cons:**
- 改清洗规则必须 bump `CLAUDE_CLEANER_VERSION`(当前 v3 → v4),触发 `agent_user_messages` 里 source='claude' 行从 `raw_payload_json` 全量回填,含 FTS5 索引重建。
- `test/controlTags.drift.test.ts` 目前只守 `controlTags.ts ↔ summarize.ts`,要扩成也守 `myMessages.ts`,否则修完还会再漂。

**Context:** 来自 `/plan-eng-review`(2026-08-13)阅读模式开关评审的 Step 0。当时在查「阅读模式的噪音口径该放哪」时翻出这处既有不一致;评审结论是阅读模式本身走「后端打标记」不新增第四份口径(D2=A),但这条遗留分叉与阅读模式无关,单独记录。注意 `myMessages.ts:5` 的注释指向的 parity 测试文件名是错的(写的是 `test/agentUserMessages.cleaners.test.ts`,实际是 `test/cleanUserMessage.test.ts`),修这条时顺手改。

**Depends on / blocked by:** 无前置。但因为要全表回填 + FTS 重建,不要和别的改动混在同一个 PR 里。

**Effort:** M(human ~4h / CC ~20min,含 bump/回填/扩 drift 测试) **Priority:** P3

## 会话详情页：给另外四个来源上虚拟化

What: 把 Claude 页已有的 `@tanstack/react-virtual` 方案推到 Cursor / Codex / OpenCode /
CherryStudio 四个会话详情页。

Why: 这四个页面打开即同步渲染整场会话的每一条消息。实测只有
`web/src/pages/ClaudeCodeHistorySession.tsx:512` 用了 `useVirtualizer`，其余三个是裸
`.map`（`CursorHistorySession.tsx:141` / `CodexHistorySession.tsx:181` /
`OpencodeHistorySession.tsx:195`）。后端也不截断：`src/serve/app.ts` 里 cursor 和 codex
都是整场会话一次返回，无 limit 参数。

Pros:
- 首帧成本与会话长度解耦（当前是线性）
- 顺带解决长会话的 DOM 体量
- 四个页面与 Claude 页行为统一，减少「同一个功能在五个页面表现不同」的排查成本

Cons:
- Claude 页的虚拟化 2026-08-13 才踩完 overscan 锚点坑（见 learnings
  `virtual-getVirtualItems-zero-includes-overscan`），四倍复制风险高
- 每个页面的消息卡片结构不同，行高估值要各自调
- 若首帧实测下来无感，这就是为不存在的性能问题付代价

Context:
2026-08-14「AI 正文 markdown 渲染」eng review 的外部声音（P0-2）发现的。markdown 渲染
上线后每条多约 1.37ms 解析，100 条会话首帧多付约 134ms、500 条约 685ms —— 但**根因是
没虚拟化，不是 markdown**。本期决定是「先实测真实最长会话的首次可交互时间再决定」，
若实测确认卡顿，这条是根治方案。注意 `useMemo` 救不了首帧（冷缓存），模块级缓存同样
救不了 —— 只有虚拟化能。

实测（2026-08-14，本机 345 场 Codex 会话，只数真正会走 markdown 渲染的 assistant
文本消息，已排除在 `CodexHistorySession.tsx:180-200` 早退的工具事件）：

| 分位 | 走渲染的消息数 | 平均/条 | 预估首帧解析 |
|---|---:|---:|---:|
| 中位数 | 6 | 533B | 5 ms |
| P90 | 201 | 511B | 159 ms |
| P99 | 730 | 325B | 527 ms |
| 最长 | 2009 | 308B | 1438 ms |

**结论：尾部问题，不是典型场景问题。** 中位数无感，P90 可接受，只有 P99 与最长那一场
会明显卡。所以本期不做，但这条 TODO 的优先级由「可能不需要」升为「确实需要，只是不急」。
触发条件很具体：当你开始经常打开 500 条以上的会话时。

Depends on / blocked by:
- ~~先拿到实测数字~~ ✅ 已测（见上表）

Effort estimate: L（human）→ M（CC+gstack）

Priority: P2

---

## recleanClaude 是死代码：cleaner_version 回填机制实际不工作

**What:** `src/agentUserMessages/queries.ts:507` 的 `recleanClaude` 定义完整、有测试，但
**生产代码零调用** —— grep 全仓只有 `test/agentUserMessages.claude.test.ts` 在调它。
同族的 `recleanBySource` / `recleanCodexFromPayload` 同理，需一并核。

**Why:** 本文件上方那条「用户消息清洗:bash-* 三个标签的口径分叉」在 Cons 里写着
「改清洗规则必须 bump `CLAUDE_CLEANER_VERSION`(当前 v3 → v4),触发 `agent_user_messages`
里 source='claude' 行从 `raw_payload_json` 全量回填」—— **这句话是假的**。bump 了版本号
也没有任何生产代码去调 `recleanClaude`，旧行会永远停在旧版本口径上，只有 bump 之后**新
入库**的行是新口径。结果是同一张表里两种口径共存且无人察觉。

**Pros:**
- 揭穿一个已经在误导决策的假前提（2026-08-17 的 eng review 正是因为相信它而把「先修
  bash-*」排在了前面，发现后收益重估）。
- `cleaner_version` 字段本身要么接上触发路径要么删掉，现状（有字段、有函数、无调用）是
  最差的中间态：它让人以为回填能力存在。

**Cons:**
- 接上需要先想清楚触发时机：serve 启动时扫一遍？加一个 scheduler 任务？还是只做 CLI
  子命令手动跑？各有代价 —— 启动时扫会拖慢冷启动，scheduler 任务默认 `enabled=0`
  （见 `src/scheduler/store.ts:29`）等于不会自动跑。
- 全量回填会重建 FTS 索引，成本随表增长。

**Context:** 2026-08-17 的 `/gstack-plan-eng-review` 中由 codex outside voice 抓出，
随后用 grep 验证属实。同一轮还发现新注册的 scheduler 任务默认 `enabled=0`
（`INSERT ... VALUES (?, 0, ...)`），所以「加个定时任务就能回填」这条路也不是白拿的。

**Depends on / blocked by:** 无前置。但与 bash-* 那条强相关 —— 修那条之前应先决定
本条，否则修完清洗规则只对新行生效。

**Effort:** S(human ~2h / CC ~15min，不含触发时机的设计决策) **Priority:** P2

---

## codex 的 subagent 会话:4325 条 AI 回答搜得到但看不出在回答什么

**What:** 给 codex `sessionKind === "subagent"` 会话的 assistant 行补上
`answering_user_key`（或等价的上下文来源）。

**Why:** 2026-08-18 的三态分流裁定 subagent 会话**只收 assistant、不收 user** ——
它的 user 侧是派给 codex 的活儿（`Read this document and review it on 5 dimensions`），
是机器注入。代价是那批 AI 回答全部没有锚点：真实语料实测 assistant 12055 条里
**7730 条有锚点、4325 条没有**，后者正好等于 subagent 会话的 assistant 条数。

这 4325 条恰恰是价值密度最高的一批 —— codex 写回来的对抗性审查意见。搜到一条
「response_item 是 agent_message 的真子集」，却看不出它在审什么，只能点进会话详情页。

`/agent-messages` 现在对这种情况显示中性的「没有关联的提问」而不编造原因
（早先写死的「这条提问已随源文件删除」对 codex 这种是假话，已修）。

**两条候选路径：**
1. **用会话标题当锚点** —— 最省事。subagent 会话的 title 往往就是任务描述，
   不需要碰 user 侧口径，也不会把派活 prompt 放进搜索。
2. **收 subagent 的 user 侧 + 剥离派活模板** —— 实测那批 user 清洗后 1087/1884 非空，
   里面混着真人内容和 prompt 模板，剥离规则要单独实测才能写对。

**Pros:** 搜索结果自解释；这批内容的价值密度在三家里最高。
**Cons:** 路径 2 会动 user 侧口径，要重新验回归基线；路径 1 需要给
`answering_user_key` 之外再加一个字段（或约定一种前缀），语义上不如真锚点干净。

**Context:** 2026-08-18 实现 codex AI 正文入库时产生。当时的裁定（D1 三类分别处理）
是有意接受这个代价的，不是遗漏。UI 侧已经诚实处理，所以这条不紧急。

**Depends on / blocked by:** 无前置。

**Effort:** S(human ~3h / CC ~20min，走路径 1) **Priority:** P3

---

## opencode 的 AI 正文尚未入库

**What:** 三家里只剩 opencode 的 assistant 内容没进 `agent_user_messages`。
Claude 于 2026-08-17 落地（V53 加 `role` 列），codex 于 2026-08-18 落地（三态分流）。

**Why:** `topicStream/conversation.ts` 的三家聚类、`replay`、`attention` 现在看到的是
「三家的提问 + 两家的回答」，仍然不对称。

**实测（2026-08-18，120/400 会话样本，用生产代码 `loadOpencodeSessionDetail` 跑）：**

| | 值 |
|---|---|
| assistant 有正文 | 427 条 / 0.188 MB |
| assistant 空 content | 1757 条（**80.4%**） |
| 平均正文长度 | 461 字节 |
| 全量外推 | **~1423 条 / 0.63 MB** |
| `metadata` 字段 | **完全为空** |
| `readingHidden` | 未实现 |

**对照已完成的两家**（都是全量实测，非外推）：

| | AI 正文 |
|---|---|
| Claude | 13456 条 / 7.29 MB |
| codex | 12055 条 / 7.66 MB |
| **opencode** | **~1423 条 / 0.63 MB ← 是另两家的 8%** |

**Pros:**
- 补齐后三家聚类真正对称。
- 判定可能是三家里最简单的：80.4% 的 assistant 消息 content 天然为空，
  「非空即正文」这条粗判据也许就够（Claude 要解析 content 块、codex 要看 metadata 分类）。

**Cons:**
- **价值最低、成本最高**，这是 2026-08-18 决定延后的直接理由。0.63 MB 是 codex 的 7%，
  而它读的是 `~/.local/share/opencode/opencode.db`（3.2 GB SQLite）而非扫文件
  —— `opencodeIngest.ts:45` 用的是 `opencodeDbPath(dataDir)`。查表 + 行 ID 水位
  与另两家的扫文件 + mtime 水位是两套 IO 模型。
- `metadata` 全空意味着没有任何分类标记可用。codex 之所以好做，正是因为它的消息自带
  `codexEventType`；opencode 什么都没有，判据只能从 content 形态里找。
- prune 策略未验证。现在 `opencode.db` 的 `message` 表最新一条与 db 水位对齐，
  但那可能只是因为闲置，不能当作「不会删」的证据。

**可照搬的形状**（两家已验证）：
- `extractXxxMessages` 收两侧 + `extractXxxUserMessages` 作为 `filter(role==='user')` 视图
- assistant 侧走 `readingHidden` 判据，user 侧口径**一字不动**（保回归基线）
- 空 content 的 assistant 不入库（否则往 FTS 写空串）
- `answeringUserKey` 靠 ingest 期顺序扫描，不用 parent 指针

**Depends on / blocked by:** 无前置。

**Effort:** M(human ~1.5d / CC ~35min，含语料噪音形态实测) **Priority:** P3
（从 P2 降为 P3：另两家落地后，这 0.63 MB 的边际价值进一步下降）

---

## 搜索两条路径的排序规则不一致

**What:** `src/agentUserMessages/queries.ts` 的 `searchUserMessages` 有两条路径：搜索词
**<3 码点**走 LIKE 全表匹配并 `ORDER BY m.event_at_utc DESC`；**≥3 码点**走 trigram
`MATCH` 并 `ORDER BY rank`。同一个搜索框，**输入长度决定排序规则**。

**Why:** 2 字中文词（「水位」「排序」「代码」）在 trigram 索引里命中不了，所以必须有
LIKE 兜底 —— 这个设计本身是对的（`queries.ts:99` 的 D4 注释解释了原因）。问题在于两条
路径顺带换了排序语义，用户搜「水位」得到时间倒序、搜「watermark」得到相关度序，而界面
上没有任何提示。2026-08-17 给这个页加了 role 筛选后它会被用得更频繁。

**Pros:**
- 修了之后搜索行为可预测。
- 即使不修，记录下来也能让下一个觉得「搜索好像乱排」的人查到成因，而不是当成 bug 去追。

**Cons:**
- 统一成哪种是个真问题：trigram 的 `rank` 对短词无意义（短词根本进不了这条路径），
  而纯时间序对长词搜索的体验又不如相关度。可能的第三条路：两条路径都按时间序，把
  相关度作为可选排序项交给用户。

**Context:** 2026-08-17 `/gstack-plan-eng-review` 的 Code Quality 章节顺手发现，属于现存
行为，不在那次改动范围内。`EXPLAIN QUERY PLAN` 实测 LIKE 路径走
`idx_aum_human_event(is_human, event_at_utc, source)` 并在 `LIMIT 50` 处提前退出，
所以时间序这一侧是有索引支撑的，改排序需要重新评估索引。

**Depends on / blocked by:** 无。

**Effort:** S(human ~2h / CC ~15min，不含「统一成哪种」的产品决策) **Priority:** P3

## file-mtime 水位状态机已经有三份

**What:** `claudeIngest.ts` / `codexIngest.ts` / `kimiIngest.ts` 各有一份「按文件 mtime 增量、分批 upsert、逐批推水位」的实现。抽成公共 helper(rule of three 已到)。

**Why:** 这套状态机的每一种失败都是静默的,而**漂移已经真实发生过一次**:`7de68d1` 修的「文件解析失败但水位照推 → 那个文件被永久排除且 lastStatus 仍写 success」只落在 claude 一处,codex 至今带着同一个缺陷(`codexIngest.ts:88-92` 的 `catch { continue }` 没有钳制)。kimi 是第三份,它从第一天就带上了钳制,但那是靠人记得照抄。

**Pros:**
- 三处受益,以后加第四个文件型源不用重新踩钳制这个坑
- 钳制逻辑只有一份,tripwire 测试也只需要一套

**Cons:**
- 要同时改两条已在生产的采集路径,回归面不小
- 三家的文件枚举形状不同(claude 两层目录、codex 一层、kimi 两个根),抽象要挑对边界:共享的是「给定 {id, mtimeMs} 列表,按 mtime 升序处理、失败钳制、分批提交水位」,不是文件发现

**Context:** 来自 `/plan-eng-review`(2026-08-18)kimi 入库评审的问题 6。当时选了 6C(修 codex 的 bug + kimi 写对 + 抽象另开 TODO),理由是重构的回归面不该与 applyV54 那个不可逆的 232 MB 迁移落在同一个 PR 里。参考 `TODOS.md` 里「外部只读数据源:抽公共同步状态机」那条 —— 它是 row-id 水位的同类问题,两条可以一起做。

**Depends on / blocked by:** codex 的水位钳制修复先落地(PR2),否则抽象出来的 helper 会把一个带缺陷的行为固化成契约。

**Effort:** M(human ~1d / CC ~40min) **Priority:** P2

---

## kimi 的 origin 为 null 是什么原因

**What:** kimi 的 `context.append_message` 里有一批消息 `origin` 缺失,实测**全是真人打的字**,判据因此写成 `origin === null || origin.kind === "user"`。但成因没查清。

**Why:** 这是 kimi 抽取口径里唯一一条「知其然不知其所以然」的规则。当前它是对的(2026-08-18 实测 162 条真人消息全部正确分类,`user-history` 对账差集为空),但如果 kimi 以后给别的东西也发 null origin,这条判据会把噪音当成人类提问放进搜索结果,而且是静默的。

**Pros:**
- 查清后可以把判据换成正面条件,而不是「排除法 + 经验」
- 顺带可能解释为什么它只在 2026-08-11 之后出现

**Cons:**
- kimi 是闭源二进制,可能查不出来
- 当前判据在实测数据上正确,收益是防御性的

**Context:** 来自 `/office-hours`(2026-08-18)。分布很有特点:2026-08-08 之前的会话一条都没有,08-11 那个会话 12 条无 origin 对 13 条有 origin,两种混杂在同一个会话里。`test/kimiHistory.realData.test.ts` 有一条断言守着「这批确实进了抽取结果」,但它守不住「未来的 null origin 仍然是人」。可查的地方:各会话的 `logs/kimi-code.log`、`~/.kimi-code/logs/`、`~/.kimi-code/bin/`(340 MB,也许能 strings 出线索)。

**Depends on / blocked by:** 无。

**Effort:** S(human ~2h / CC ~20min) **Priority:** P2

---

## opencode 的 raw_payload_json 把附件全文内联了

**What:** `agent_user_messages` 里 opencode 的 281 条真人提问占了 **56.2 MB** payload,而它们的正文只有 0.08 MB。最大一条是 **3.77 MB 换 553 字提问** —— 提问内容是「Analyze the attached file」,附件全文被内联进了 `raw_payload_json`。

**Why:** 整张表 232.5 MB 里,真正的正文只有 1.9 MB;其余是 `raw_text`(68.2 MB)和 `raw_payload_json`(123.4 MB),而 opencode 这 281 行独占其中 56.2 MB。每加一个源都要重建这张表时,搬的主要是这些附件。

**Pros:**
- 省约 56 MB
- 以后重建表(加源)会快一截

**Cons:**
- 附件留底**可能是故意的**:源文件会被删,payload 是唯一的原始副本
- 要动 `opencodeIngest` 的 payload 口径(写侧),而已存的 281 行怎么办是另一个决定(改写?留着?)
- 974 MB 的库里 56 MB 不疼,收益是长期的

**Context:** 来自 `/plan-eng-review`(2026-08-18)kimi 入库评审的 Step 0,量表体积时发现。当时判定不在本轮范围(D2)。kimi 不会得这个病:它的 user content 534 个 part 共 0.512 MB,平均 1 KB,附件只存引用(`<attachment>{"type":"image","path":...}</attachment>`)不存内容 —— 那个引用也已经在 `cleanKimiUserText` 里从 `cleaned_text` 剥掉,只留在 `raw_text`。

**Depends on / blocked by:** 无。做之前先确认「附件留底是不是故意的」。

**Effort:** M(human ~4h / CC ~30min) **Priority:** P3

---

## opencode 接进 token 趋势页(第 5 个源)

**What:** `/dashboard/tokens-trend` 现在有 claude / codex / minimax / kimi,唯独没有 opencode —— 而 `/dashboard/tokens` 排行页有它。归一成 source 维度之后,加它的边际成本降到「一个 adapter + 一行注册」。

**Why:** 两个 token 页面源集不一致,用户在排行页看到 opencode、切到趋势页它消失了,没有任何提示。这跟「少一家 = 页面在说谎」是同一类问题。

**Pros:**
- 两个页面源集终于一致
- 归一重构之后成本很低,不做等于浪费了刚建好的 adapter 机制

**Cons:**
- opencode 只有 **session 级** `tokens_input` / `tokens_output`(直接来自 `opencode.db` 的 `session` 表),**没有逐事件时间轴**
- 塞进按时间分桶的页面必须先决定「一个 session 的 token 记在哪个桶」:全记在 `time_updated` 那个桶?按 session 时长均摊?两种都会让柱子形状失真,且与另外四家的口径不同
- `capabilities` 里要多一个「无事件级时间分辨率」的维度,否则页面无法诚实表达这个差别

**Context:** 来自 `/plan-eng-review`(2026-08-20)对 token 归一重构的 Open Questions。当轮明确不做,因为分桶归属这个决定本身需要一次独立讨论,塞进已经 32 文件的 PR 里会失焦。相关代码:`src/opencodeTokenUsage/queries.ts`(144 行,无 refresh、无索引表,直接查 opencode.db)。

**Depends on / blocked by:** token 趋势页归一成 source 维度落地。

**Effort:** M(human ~4h / CC ~40min) **Priority:** P2

---

## 查清 kimi 的 inputCacheCreation 为什么恒为 0

**What:** kimi 的 `usage.record` 事件有四个 token 桶,其中 `inputCacheCreation` 在全量 5269 条里**无一例外都是 0**,而 `inputCacheRead` 占了 97.7%(1448.7M)。

**Why:** 决定趋势页「输入构成」要不要给 kimi 画第三段。如果 kimi 真的不写 cache(只读),那第三段应当隐藏;如果只是这个字段没被 kimi 填、cache 写入混在 `inputOther` 里,那 kimi 的「真实新增」被高估了,29.9M 里有一部分其实是 cache 写入。

**Pros:**
- 查清了才能决定 `capabilities.cacheCreation` 对 kimi 该是 true 还是 false
- 顺带验证 `inputOther` 的语义,它是「真实新增」这个口径的唯一来源

**Cons:**
- kimi 没有公开的 usage 字段文档,大概率只能靠对账推断(比如拿套餐消耗量与入库量比)
- 结论可能是「无法确定」,那就维持现状(字段存在、值为 0、画一段 0 高度)

**Context:** 来自 `/plan-eng-review`(2026-08-20)。当轮按 `capabilities.cacheCreation = true` + 值为 0 处理,与 claude 同构,是安全的默认。可查的地方:kimi 的 `llm.request` 事件(2316 条)里也许有请求侧的 cache 控制参数;`usage.record` 的 `usageScope` 目前只有 `"turn"` 一种,别的 scope 可能有别的桶。

**Depends on / blocked by:** kimi token 入库落地(要有数据才好对账)。

**Effort:** S(human ~2h / CC ~20min) **Priority:** P3

---

## codex / minimax 的 event 时间索引升级成复合索引

**What:** `codex_token_usage_event` 与 `minimax_token_usage_event` 的时间索引是裸 `(event_at)`,而 `claude_token_usage_event` 是复合 `(event_at, session_id)`。新建的 kimi 表按复合建(eng review 9A)。

**Why:** 趋势页的分桶查询是 `FROM event e JOIN session s ON s.session_id = e.session_id WHERE e.event_at >= ? AND e.event_at < ?`。复合索引能覆盖 join 键,裸列索引每命中一行都要回表取 `session_id`。codex 有 65200 行、minimax 有 65200 行。

**Pros:**
- 四家索引形状统一,以后照抄不会抄错
- 分桶查询免回表

**Cons:**
- 需要一个新的 `applyVNN`(已 applied 的不可改,CLAUDE.md 铁律)
- 现在这个数据量下大概率测不出差别,属于「趁着统一顺手做」而不是「有性能问题要修」
- minimax 表没有 session 表可 join,它的复合索引收益比 codex 小

**Context:** 来自 `/plan-eng-review`(2026-08-20)Section 4 性能审查。当轮只给新建的 kimi 表定了复合索引,没动已上线的两张表,避免把 migration 面扩大到本次范围之外。

**Depends on / blocked by:** 无。

**Effort:** S(human ~1h / CC ~15min) **Priority:** P3

---

## pricing.ts 的注释说 Codex 无定价,实际有

**What:** `src/cost/pricing.ts` 的注释写着「intentionally absent → Codex cost shows as unpriced until a real rate is added」,`MODEL_PRICES` 里也确实只有 claude 系列 + 一行 `// "gpt-5.5": fill from OpenAI pricing`。但实际运行时价格来自 DB 覆盖表 `model_prices`(56 行,models.dev 同步),里面 `gpt-5.5` / `gpt-5.6-sol` / `gpt-5.6-terra` 都有价。

**Why:** 注释会让下一个人以为 codex 的成本恒为 0,从而做出错误的设计决定 —— 本轮 eng review 我就是先信了注释、差点把 `capabilities.cost` 写成源级硬编码布尔,实测才发现两家都只有**模型级**的无价空洞(claude 有 18 个 session 的 model 为 null、codex 有 49 个是 `codex-auto-review`)。

**Pros:**
- 改注释,零风险
- 避免下一个人重复踩

**Cons:**
- 纯注释改动,没有行为变化

**Context:** 来自 `/plan-eng-review`(2026-08-20)Section 1 的 4A。vendored 快照是 fallback,DB 覆盖表才是运行时真相(`priceFor` 接受一个 PriceMap,趋势层传的是 DB 覆盖后的 map)。注释应当说明这个两层结构。

**Depends on / blocked by:** 无。

**Effort:** XS(human ~10min / CC ~2min) **Priority:** P3

---

## 看板两个入口函数抽成源适配器注册表

What: `buildWorkDashboard`（`aggregate.ts:698`）与 `buildWorkTokenRanking`（`aggregate.ts:932`）各自维护一套 `options.sources.includes(...)` 逐源块。接完 kimi 后总览页 8 个、排行页 4 个（每个还带一条 else-if 兜底），共 12 个近乎同构的块。抽成一张 `SOURCE_ADAPTERS` 注册表，两个函数改为遍历。

Why: T12 漏接排行页的根因就是「必须两边都记得」——我只在 `buildWorkDashboard` 里加了 kimi 块，排行页那个并列函数里 kimi 出现 0 次，而 commit message 却声称排行页已经有 kimi 了。`TODOS.md` 里点名的 Cursor / Cherry / AI Chat 三个未来源，每个都要把这 12 个块再走一遍。

Pros:
- 加一个源变成加一行配置，而不是记住 12 个位置
- 逐源块的差异（哪些源有 token、哪些有会话）变成注册表里的显式声明

Cons:
- 两边 token 块写回去的形状不同：总览页写进 `slot()` 建的格子，排行页调 `addRankingTokens`。适配器得吐一个中间形式再各自落地，不是纯粹的复制粘贴
- 是 1100 行文件里的真重构，`aggregate.test.ts` 现有 12 个用例都要重跑

Context: 2026-08-21 的 eng review 里评估过，当时选了更便宜的兜底方案——新增 `test/workDashboard.sourceCoverage.test.ts`，遍历 `DASHBOARD_SOURCES` 断言「DB 背景的源有种子就必须出行且无 warning 诊断，文件系统源不许静默」。那个测试会在加第五个源却忘了接排行页时变红。重构本身仍然值得做，但不再是唯一防线。

Depends on: 无

Priority: Phase 2

## 新增迁移会打挂已装的打包版

What: 每次 `SCHEMA_VERSION` 前进，已经装在机器上的桌面版（`desktop/release/…/ai2nao.app`）
就再也打不开 `~/.ai2nao/index.db` —— `migrations.ts:149` 在
`vAfter > CURRENT_VERSION` 时直接 `throw "Database schema newer than this binary"`。

Why: 这不是理论风险，是**每次开发都会发生**的。用源码起 `:8799` 做验收（CLAUDE.md
要求的做法）会顺手把真库升上去，于是桌面上那个图标点开就白屏/报错，
而用户完全不知道是自己刚才验收造成的。2026-08-26 的 V60 就是实例：
验收前必须先停 `:8787`、备份 `index.db.bak59`，事后必须重新打包。

Pros:
- 开发时不用每次手动记得「先停桌面版」
- 用户（哪怕就是自己）不会遇到一个无法解释的白屏

Cons:
- 真正的修法不止一种，要选：
  (a) 桌面版检测到库更新时给一个明确提示 + 「去更新」而不是抛异常
  (b) `serve` 在检测到有别的进程持有更旧的二进制版本时警告并要求 `--force-migrate`
  (c) 开发用 `AI2NAO_DB` 指向副本，根本不碰真库（最省事，但验收就不是真库了）
- (c) 与「验收要在真库真路由」的家法冲突，需要权衡

Context: 2026-08-26 做 per-commit churn（V60）时暴露。对抗性冷读把它列为
Distribution Plan 的盲点 —— 原文写的「现有管线覆盖」漏掉了这一步。

Depends on: 无

Priority: Phase 2

## claude 有 57% 的会话源文件已被删除

What: `work_session_duration` 里 claude-code 的 220 场会话，**125 场带 `missing_since`**
（源 JSONL 已不在磁盘上）。`claudeIngest.ts:11-13` 明写 Claude Code 按 30 天滚动窗口
删 transcript，「每天还在以约 3 个会话的速度继续丢」。codex 只有 4 场，
kimi / opencode 是 0（库型源，没有文件会消失）。

Why: 「点进去看那场会话说了什么」对**超过一半**的 claude 会话做不到。
2026-08-26 的 `/ai-sessions` 是第一个把这件事暴露到页面上的功能 ——
下钻列表里那些没有 title 的行就是它。这不是 bug（duration 表**故意**保留源已消失的行），
但用户会以为是。

Pros:
- 下钻/回看时能解释「为什么这场点不开」，而不是显示成空白
- 125 场里有 96 场**是有消息记录的**（消失前已入库），那 96 场其实能从
  `agent_user_messages` 重建出正文 —— 只是没有 title

Cons:
- 真正的修法是「入库时就把 title 存进 aum」，那是 ingest 的口径变更
- 或者：给 duration 表的 missing 行加一个「正文仍可从 aum 重建」的标记
- 也可以什么都不做，只在 UI 上诚实标注

Context: 2026-08-26 做 `/ai-sessions` 时查清。起因是追「29 个 claude 会话有时长
却在 aum 里零消息」，最后发现它们全部有 `missing_since`。

Depends on: 无

Priority: Phase 2

## `~` 缩写 home 是前端的 macOS-only 猜测

What: `/ai-sessions` 下钻的目录组头把 `/Users/<name>` 缩成 `~`，做法是前端的
`p.replace(/^\/Users\/[^/]+/, "~")`。浏览器里没有 `$HOME`，后端也不下发
（`grep -rn homedir src` 的 20 处全在服务端）。

Why: 在 Linux（`/home/<name>`）和 Windows 上这条 regex 什么都不做，路径原样全长显示。
今天不痛，因为页面可见的 159 个目录 **159/159 都在 `/Users/` 下**（实测）。
一旦这个工具跑在别的平台上，组头会变得很长。

Pros:
- 后端下发 `homePrefix` 一个字段就解决，且能顺带给别的页面用
  （`KimiHistory.tsx:93` 那种末两段缩写也在各自造轮子）

Cons:
- 加字段就破了本设计「后端零改动」那条，要动 `aiSessions/routes.ts`
- 或者更彻底：抽一个前端的 `shortenPath()` 工具，各页面统一用

Context: 2026-08-27 做目录分组时由对抗性冷读点出。当时选了前端启发式并明确标注
它是猜测。

Depends on: 无

Priority: Phase 3

## `WORK_DURATION_RULE_VERSION` 不分源

What: `src/workDuration/types.ts` 的 `WORK_DURATION_RULE_VERSION` 是一个全局常量（当前 `1`），四个源共用。

Why: 将来若只想改其中一个源的口径（比如 kimi 从「按会话合并」改成别的），bump 它会**强制四个源全部全量重建** —— claude 219 行要重新遍历 JSONL，codex 362 行同理。反过来若不 bump，已入库的行不会重算，改口径等于没改。另外三家的 token refresh 都是每源一个 `rule_version`，只有时长这里是全局的。

Pros:
- 改单源口径不再牵连另外三家
- 与 token 侧的 `*_TOKEN_RULE_VERSION` 家法一致

Cons:
- `work_duration_state` 已经是每源一行、自带 `rule_version` 列，所以是纯代码改动，不动 schema
- 今天没有实际痛点（四源口径都还没改过），属于欠账不是 bug

Context: 2026-08-25 接入 kimi 时发现。首次构建不受影响（没有存量 kimi 行）。

Depends on: 无

Priority: Phase 3

## `work_session_duration.identity_confidence` 是只写列

What: 该列有写入者（四个收集器都填），但**没有任何读取者**。`listWorkProjectDurationUsage`（`queries.ts:204-213`）根本不 SELECT 它；唯一 SELECT 它的是 `queries.ts:19` 的整行取回，而跳过判据不比较它。`aggregate.ts:862` 读的是 dashboard session 对象的同名字段，不是这张表。

Why: 写反了没有任何可观测后果 —— 这正是危险的地方。kimi 接入时 `MIN(identity_confidence)` vs `MAX` 差一个字就反向（`'high'` 字典序小于 `'low'`），而没有任何断言能抓到。要么给它找个消费者（排行页标出「路径推断不确定」的项目），要么承认它是死列并删掉。

Pros:
- 少一个能静默写错的字段
- 或者：low confidence 的项目在排行页上标出来，本来就是有用的信息（真库 8 个 `kimi:conv-*` 伪项目全是 low）

Cons:
- 删列要重建表；加消费者要动排行页 UI

Context: 2026-08-25 接入 kimi 时由对抗性冷读发现。真库 32 场 kimi 会话没有一场各 agent confidence 分歧，所以连数据都测不出来。

Depends on: 无

Priority: Phase 3

## DB 背景的会话收集器缺 range/limit

What: `listOpencode()` 与新增的 `listKimi()` 都不接参数，全量拉回后由 `buildWorkDashboard` 按 range 过滤。而 `listClaude` 带 `projectLimit`/`sessionsPerProject`、`listCodex` 带 `sessionLimit`/`fallbackFiles`。

Why: 历史只增不减，而 `rangeDays` 默认只看 30 天——拉回全部再丢掉绝大部分，随使用时长线性变差。两个 DB 背景的收集器共同欠这笔账，不是 kimi 特有的。

Pros:
- 排除掉一类「今天快、两年后卡」的退化，而这类退化通常要等到用户抱怨才被发现

Cons:
- 收集器接口要改，两个实现加上测试里所有手搭的 mock deps 都要跟

Context: 2026-08-21 的 eng review 里由 codex outside voice 提出。当时实测 kimi 是 31 个会话 / 2493 行 / 17 ms（命中 UNIQUE 约束的隐式索引，且是覆盖索引）——基数太小，这个测速不能当作长期保证。

Depends on: 无

Priority: Phase 3
