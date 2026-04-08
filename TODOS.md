# TODOS

## 后续优先级

1. 证据可回看层
2. stale cache 的 UI 体验
3. README / LM Studio 使用文档
4. 跨天工作线程

说明:
当前这四项里，前两项直接提升“这东西靠不靠谱”的体感。第三项降低未来使用成本。第四项价值很高，但明显更像下一阶段产品路线，而不是顺手补完。

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
