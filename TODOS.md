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
10. RAG：双路检索调试视图（同一查询下展示 FTS 与向量 topK/分数，利于录屏与排错）
11. RAG：黄金检索评测集（固定问句 + 期望命中；改融合/切块可回归）
12. RAG：Evidence 载荷与「证据可回看层」DTO 对齐（与每日摘要合流前的类型约定）
13. Claude Code 本地对话 v1：只读扫描 + jsonl 解析 + Web 刷新（无 SQLite；项目根见下节）

说明:
前四项里，前两项直接提升“这东西靠不靠谱”的体感。第三项降低未来使用成本。第四项价值很高，但明显更像下一阶段产品路线，而不是顺手补完。第五、六项依赖 Chrome 下载镜像 v1（`chrome_downloads` 表与同步）落地后再做；第五项补全重定向链展示，第六项与 `docs/downloads-design.md` 对齐、降低后续维护成本。第七至九项来自 `/gstack-plan-eng-review`（Cursor 本地对话接入）：第七项在 `src/cursorHistory` 的 DTO 与只读路径稳定后再做，用于性能与联合检索；第八项在从参考目录移植算法时落实合规；第九项把 `~/.gstack/projects/.../quincy-feat-cursor-history-design-*.md` 中与「workspace 依赖 cursor-history」不一致的段落改成「仅在 `src/` 实现、参考目录不 import」。**第十至十二项**来自 `/plan-ceo-review`（RAG hybrid）：在 v1 引用与双写链路稳后再做，避免和首版抢复杂度。**第十三项**（Claude Code v1）：只读；落库与 FTS 与 Cursor 侧第 7 项一并规划 Phase 2。

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

What: 更新 `~/.gstack/projects/xunull-ai2nao/quincy-feat-cursor-history-design-20260408-222328.md`（或迁到仓库 `docs/` 下的正式路径）：删除或改写 **「`package.json` workspace / `file:./cursor-history` + 薄封装」** 的推荐路径；改为 **所有实现位于仓库根 `src/cursorHistory/`（或约定目录）**；补充与 Chrome 能力的产品差异（是否要先 sync）。

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
