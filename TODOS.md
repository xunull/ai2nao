# TODOS

## 后续优先级

1. 证据可回看层
2. stale cache 的 UI 体验
3. README / LM Studio 使用文档
4. 跨天工作线程
5. Chrome 下载镜像 v2（URL 链与可点击源 URL）
6. Chrome 下载镜像设计文档（`docs`）
7. Cursor 对话镜像 + FTS（`index.db`）
8. Cursor 集成：LICENSE / NOTICE 与上游署名
9. Cursor 设计文档修订（仅 `src/` 实现）
10. Cursor opened projects：显示关联 chat session counts
11. RAG：Evidence 载荷与「证据可回看层」DTO 对齐（与每日摘要合流前的类型约定）
12. Claude Code 本地对话 v1：只读扫描 + jsonl 解析 + Web 刷新（无 SQLite；项目根见下节）
13. Homebrew 清单：Brewfile 导出
14. 软件清单：Mac App 与 Homebrew Cask 关联
15. Chrome History 域名透视 v2：Public Suffix List / `registrable_domain`
16. Chrome History 域名透视 v2：CSV 导出
17. Chrome History 域名透视 v2：真正增量派生
18. Chrome History 微信文章正文索引
19. Chrome History 搜索命中原因展示
22. VS Code terminal dirs 工作信号（显式 opt-in）
23. CopilotKit 自定义 AI Studio UI
24. Work Dashboard 快照表 + scheduler 自动刷新
25. Work Dashboard 纳入 Cursor / Cherry / AI Chat 来源
26. Work Dashboard 项目摘要解释层
27. Work Dashboard 全量 token 历史统计
28. ai2nao apiKey 明文存储隐患（`~/.ai2nao/rag.json` 等）：迁移至 keychain / env var
29. Cosmos 本地 embedding fallback（让 "local-first" 叙事完整）
30. workDashboard / sessionMemory 取「最近 N 个项目」而非 alpha 前 N
31. Codex / Cursor 历史页也按最近活跃排序（与 Claude 项目列表平行）
32. MCP v2 重 tool：search_history + project_overview + 按项目 USD 成本
33. token-vs-git v2：per-commit churn + 降噪 config + 子目录二级粒度 + 精确剔除非 AI 提交

说明:
前四项里，前两项直接提升“这东西靠不靠谱”的体感。第三项降低未来使用成本。第四项价值很高，但明显更像下一阶段产品路线，而不是顺手补完。第五、六项依赖 Chrome 下载镜像 v1（`chrome_downloads` 表与同步）落地后再做；第五项补全重定向链展示，第六项与 `docs/downloads-design.md` 对齐、降低后续维护成本。第七至九项来自 `/gstack-plan-eng-review`（Cursor 本地对话接入）：第七项在 `src/cursorHistory` 的 DTO 与只读路径稳定后再做，用于性能与联合检索；第八项在从参考目录移植算法时落实合规；第九项把 `~/.gstack/projects/.../you-feat-cursor-history-design-*.md` 中与「workspace 依赖 cursor-history」不一致的段落改成「仅在 `src/` 实现、参考目录不 import」。**第十项**来自 `/plan-ceo-review` + `/plan-eng-review`（Cursor opened projects）：在 `/cursor-projects` v1 与 Cursor chat DTO/性能边界稳定后再做。**第十一至十三项**来自 `/plan-ceo-review`（RAG hybrid）：在 v1 引用与双写链路稳后再做，避免和首版抢复杂度。**第十四项**（Claude Code v1）：只读；落库与 FTS 与 Cursor 侧第 7 项一并规划 Phase 2。**第二十八项**来自 `/plan-eng-review`（Activity Cosmos 评审旁支发现）：rag.json apiKey 当前明文，没在 cosmos scope 但属 solo 项目的隐患，后续重构成 keychain 或 env var 即可。**第二十九项**来自 `/plan-eng-review`（Activity Cosmos）：首版 cosmos 用 DashScope 远端 embedding，要支持 "truly local-first" 叙事需补一条本地 embedding fallback (LMStudio nomic-embed / Ollama bge)；不阻塞 MVP ship，作 Phase 2 跟踪。

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
- 把 `--daily-summary`、`--llm-base-url`、`--llm-model` 这些入口正式化
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

## Diagnostic type 三处同款抽公共 util

**What:** `src/util/diagnostics.ts` 抽 `type Diagnostic = { severity: "info" | "warning" | "error"; kind: string; message: string; ... }`，让 workDashboard / workRecap / workTokensTrend 全部 import。

**Why:** 现有三处（含本 PR 即将引入的 workTokensTrend 是第四处）各定义同款 type，~10 行重复 × 4。未来加 source 会继续漂移；每加一处单点维护成本递增。

**Pros:**
- 单点 type 维护
- 跨 module 互通 diagnostic 数组形状，可写公共 UI 组件统一渲染

**Cons:**
- 抽公共 util 有 over-abstraction 风险（虽然 4 处够多了）
- 各 module 当前有 namespace-prefix 前缀（如 `WorkTokensTrendDiagnostic`），抽出后命名要重新决定

**Context:** 来源于 `/plan-eng-review` 对 work-tokens-trend 设计文档的 Section 2 review（2026-06-10）。当时选不在本 PR 中处理以保持 PR 聚焦，但记录避免遗忘。同款 module: `src/workDashboard/types.ts DashboardDiagnostic`、`src/workRecap/types.ts WorkRecapDiagnostic`、`src/workTokensTrend/types.ts WorkTokensTrendDiagnostic`。

**Depends on / blocked by:** work-tokens-trend ship 落地。

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

**What:** 项目级「token 消耗 vs git 产出」分析的 v1 落地后,补几件延后的:
- **per-commit churn 存储**(Approach C):存到每个 commit(sha/author/ts/added/deleted),支持「这次很贵的 session → 对应哪几个 commit」精细关联。
- **降噪 glob 的 config 覆盖**:v1 硬编码默认排除列表,v2 允许 `~/.ai2nao/config.json` 覆盖。
- **子目录二级粒度**:v1 输出 repo 级,v2 可展开看 repo 内子目录 token 占比。
- **精确剔除非 AI 提交**:把 AI session 时间窗对到 commit,只算 AI 辅助的提交,而非作者的全部提交。

**Why:** v1 把指标做对(多指标面板、token/行 当透镜、repo 级、窗口准确),但比值分子分母仍是「AI token ÷ 你所有提交的行」的近似;v2 把归因做精。

**Cons:**
- per-commit 存储让 churn 表与查询都变重
- 精确剔除非 AI 提交需要把 session 窗口与 commit 时间对齐,复杂度高

**Context:** 来自 `/plan-eng-review`(项目级 token vs git 产出,2026-06-26)。v1 设计:`~/.gstack/projects/xunull-ai2nao/quincy-main-design-20260626-214731-token-vs-git-output.md`。office-hours + eng-review + Codex 一致把这些移出 v1 以保持「engineered enough」。

**Depends on / blocked by:** v1（git_line_churn 表 + scheduler + 分析页）落地。

**Effort estimate:** M（human ~1天 / CC ~40min）

**Priority:** P3
