# GitHub 开源雷达下一版设计：从 Star 库存到技术线索图

**状态：** Draft
**日期：** 2026-05-02
**关联现有版本：** `docs/github-open-source-radar.md`

## 问题重述

当前开源雷达 v1 已经能把 GitHub Star 做成本地数据、主题分组、复盘队列和手写 note。但它不好用的根因不是缺少更多字段，而是产品主语错了。

v1 把 Star 当成库存管理：

- 哪些 Star 缺理由？
- 哪些 Star 过期？
- 哪些 Star 需要复盘？

这些问题会让用户产生维护负担。用户收藏一个 repo 时，经常只是觉得“以后可能有用”，并没有准备马上写一段理性说明。要求用户补理由，本质上是把整理成本推给用户。

下一版应该把 Star 当成技术线索：

- 这些收藏暗示我最近在追什么问题？
- 哪些 repo 和我当前项目、TODO、设计文档有关？
- 哪些旧收藏现在重新变得有价值？
- 我的技术品味和长期方向正在变成什么？

一句话：

> 开源雷达不该帮用户整理 Star，它应该帮用户看见自己正在追的技术线索。

## 核心洞察

GitHub topics 是 repo 自己给自己的标签，只能回答“这个 repo 是什么”。它不能回答“这个 repo 对我有什么意义”。

真正有价值的解释需要三层信息：

1. **Repo 客观信息**
   - README
   - description
   - topics
   - language
   - stars
   - pushed_at / archived

2. **用户关系信息**
   - 用户何时 Star
   - 本地项目近期 commit / branch / docs
   - `TODOS.md`
   - ai2nao 里已有的本地数据源，例如 Chrome history、AI 对话历史、终端命令、项目路径

3. **系统解释**
   - “你最近在关注 local-first AI memory”
   - “这几个 repo 都指向 agent workflow UI”
   - “这个 repo 可能能推进 ai2nao 的 RAG 调试视图”
   - “这不是马上要用的库，更像是一个未来可借鉴的设计样本”

深层价值来自第三层。

## 设计原则

### 1. 先解释，再让用户纠偏

不要问用户“为什么收藏”。先自动猜：

> 你可能收藏它是因为：它解决了本地 LLM 模型管理问题，和你最近做的 LM Studio / Hugging Face inventory 方向接近。

用户只需要做轻量反馈：

- 有用
- 不准
- 以后看
- 忽略

### 2. 首页显示洞察，不显示待办债务

“待补理由”“需要复盘”这类队列会制造压力。下一版首页应该像一面镜子，而不是任务列表。

首页默认展示 5 类洞察：

- 本周技术线索
- 现在值得打开的 3 个 repo
- 被遗忘但仍活跃
- 可能该淘汰
- 技术品味画像

### 3. 让 Star 回流到当前工作

最强价值不是总结 Star，而是把 Star 和用户正在做的事情连起来。

例如：

> 你收藏的 `foo/bar` 可能能帮助 `TODOS.md` 里的 “RAG 双路检索调试视图”。

这会把开源雷达从收藏管理变成灵感回流系统。

### 4. 不追求一次生成完全正确

系统解释只要 70% 准，就足以把维护成本降下来。用户反馈负责纠偏，系统后续可以根据反馈调整排序和解释。

## 推荐形态：Open Source Sensemaking

建议把下一版命名为 **Open Source Sensemaking**，中文可称为 **开源线索图** 或 **技术兴趣地图**。

它不是 GitHub Star 管理器，而是个人开源兴趣解释层。

## 页面结构

### Workbench v2 布局

下一版 `/github/radar` 应该套用 `DESIGN.md` 里的复杂工作台骨架，而不是继续把状态条、线索列表、旧队列、画像和统计平铺在同一屏。

推荐结构：

```text
页面头
  开源雷达
  从本地 Star 和当前工作上下文里挑出现在值得看的项目
  状态：已更新 / 可能过期 / 部分更新 / 出错
  主操作：刷新线索

轻工具条
  当前队列：现在值得看
  搜索：repo / topic / 本地上下文关键词
  更多筛选：health、kind、时间范围、旧队列

主体
  左侧索引：线索队列 / 复盘队列 / 降级候选
  右侧工作区：当前线索详情、证据、相关 repo、反馈按钮

主任务 tab
  当前线索
  复盘队列

次级折叠区
  旧雷达统计
  技术品味画像
  调试指标
```

关键设计规则：

- 默认选中最高优先级线索，而不是把所有线索同时铺出来。
- 左侧只负责选择线索或队列；右侧解释当前线索并承载反馈操作。
- 旧雷达队列和统计是 secondary details，不应该抢第一屏。
- 当前线索摘要应贴着右侧工作区顶部，例如 health、score、证据数、关联 repo 数。
- 反馈按钮属于当前线索，放在右侧工作区，不散落在多张卡片里。

### 1. 本周技术线索

展示 3-5 条系统识别出的方向。

示例：

- local-first AI memory
- agent workflow UI
- SQLite-backed personal data tools
- model inventory and local LLM operations

每条线索包含：

- 一句话解释
- 相关 repo 列表
- 为什么这些 repo 属于这条线
- 反馈按钮：有用 / 不准

### 2. 现在值得打开的 3 个 repo

不是按 star 数，也不是按收藏时间，而是按“对用户当前工作是否有用”排序。

排序依据可以包含：

- 和 `TODOS.md` 的关键词重合
- 和近期 docs / branch / commit message 重合
- repo 近期仍活跃
- 用户近期收藏或浏览过相近主题

每个 repo 展示：

- repo 名称
- 系统猜测的价值
- 关联到的本地上下文，例如 TODO、设计文档、近期页面
- 操作：打开 / 以后看 / 忽略

### 3. 被遗忘但仍活跃

寻找很久前收藏、最近仍更新的 repo。

这个区域负责制造惊喜：

> 你 2024 年收藏过这个 repo，但它最近 30 天仍在更新，而且和你现在做的本地模型库存方向有关。

### 4. 可能该淘汰

不是批量清理，而是轻量判断。

候选条件：

- repo archived
- 长期未 push
- 与当前技术线索无明显关系
- 用户多次反馈“不准”或“忽略”

### 5. 技术品味画像

从所有收藏中提炼长期主题。

示例：

- local-first
- SQLite
- personal data
- agent tooling
- developer memory
- CLI-first workflows

这个区域要像镜子，不像报表。它回答的是：

> 我正在变成什么样的开发者？

## 数据模型增量

现有 `gh_star_note` 可以保留，但下一版需要把“手写理由”降级为可选纠偏字段。

建议新增本地 insight 层：

```text
gh_star
  |
  +-- repo objective facts
  |
  +-- gh_star_insight
        repo_id
        insight_text
        evidence_json
        confidence
        feedback
        generated_at
        updated_at
```

`evidence_json` 用来解释系统为什么这么猜：

- README 关键词
- topics
- language
- matched TODO item
- matched doc path
- recent local activity

反馈枚举：

- `useful`
- `wrong`
- `later`
- `ignore`

## API 草案

### `GET /api/github/radar/insights`

返回下一版首页所需的洞察卡。

```ts
type RadarInsightsRes = {
  generated_at: string;
  lines: InsightLine[];
  recommended_now: RepoInsight[];
  rediscovered: RepoInsight[];
  retire_candidates: RepoInsight[];
  taste_profile: TasteProfile;
};
```

### `POST /api/github/radar/insights/:repo_id/feedback`

保存轻量反馈。

```json
{
  "feedback": "useful"
}
```

## 方案对比

### 方案 A：最小可用洞察层

只用现有本地数据和 GitHub repo metadata，不抓 README，不接 LLM。

规则：

- topics + language + description 聚合成线索
- 与 `TODOS.md`、docs 文件名、近期 commit message 做关键词重合
- 生成模板化解释

优点：

- 实现快
- 隐私简单
- 不依赖模型
- 能验证“洞察卡比队列更好用”这个核心判断

缺点：

- 解释会偏浅
- 对 repo 真实价值理解有限

适合第一步。

### 方案 B：LLM 起草洞察

抓取或缓存 README 摘要，把 repo metadata、本地上下文、TODO/docs 摘要交给本地或可配置 LLM，生成解释。

优点：

- 更接近“启发我”的目标
- 能生成自然语言 insight
- 更容易产出“我没想到”的连接

缺点：

- 要处理缓存、失败、隐私、成本、prompt 注入
- 需要明确本地/云模型边界

适合在 A 验证页面形态后升级。

### 方案 C：兴趣地图 + 时间线

把 Star 按时间组织成“兴趣演化”：

- 过去 90 天新方向
- 过去一年稳定主题
- 消失的旧兴趣
- 重新出现的主题

优点：

- 最像“看见自己”
- 差异化强
- 适合长期使用和录屏展示

缺点：

- 需要足够历史数据
- 需要更好的聚类和解释
- 首版容易做重

适合后续作为高级视图。

## 推荐路径

先做 **方案 A + 页面形态改造**。

原因：

> 当前最大的未知不是模型能不能生成好理由，而是“洞察卡是否比队列更让用户愿意打开”。先验证这个产品形态，再升级 LLM。

具体第一版范围：

1. 新增 `GET /api/github/radar/insights`
2. 从现有 `gh_star`、`gh_repo_tag`、`TODOS.md`、docs 文件名、近期 commit message 生成洞察卡
3. 首页默认展示洞察卡，而不是待办队列
4. repo card 上显示“系统猜测的价值”
5. 添加 `有用 / 不准 / 以后看 / 忽略` 反馈
6. 保留原来的 note editor，但收进详情或二级操作

## 成功标准

下一版是否成功，不看生成了多少 note，而看：

- 用户打开页面后能在 30 秒内看到 1 条“确实有启发”的线索
- 用户不需要手写理由也能理解 repo 为什么出现
- 至少 3 个 repo 被系统成功连接到当前 TODO、docs 或近期工作
- 用户愿意点击“有用 / 不准”反馈，而不是关闭页面
- 页面从“待整理”变成“来看看我最近在追什么”

## 不做什么

下一版不做：

- GitHub Lists 写回
- 批量编辑 note
- 复杂 embedding 聚类
- 自动 fork / clone / install repo
- 每个 repo 强制生成长摘要
- 把所有 Star 变成任务

## 下一步任务

1. 用本地真实 Star 数据跑一次手工分析，选出 10-20 个 repo，看能否人工归纳出 3-5 条“技术线索”。
2. 设计 `RadarInsightsRes` DTO，先让 API 返回规则生成的洞察卡。
3. 改 Web 首页信息架构：洞察卡优先，队列降级。
4. 加反馈模型和最小反馈 API。
5. 再评估是否引入 README 缓存和 LLM 起草。
