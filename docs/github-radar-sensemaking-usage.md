# GitHub 开源雷达：线索图版本使用说明

**状态：** 已实现  
**入口：** `/github/radar`  
**核心命令：** `ai2nao github sync --full`  

## 它解决什么问题

GitHub Star 很容易变成一个越来越长、越来越少打开的收藏夹。旧版开源雷达主要帮你整理 Star：哪些缺理由、哪些需要复盘、哪些可能过期。

这一版把目标改成了 **开源线索图**：

- GitHub topics 说明一个 repo 是什么。
- ai2nao 解释这个 repo 为什么可能和你现在的工作有关。

它不会要求你先给每个 Star 手写理由，而是先基于本地数据自动生成线索，再让你用很轻的反馈去纠偏。

## 怎么使用

### 1. 同步 GitHub Star

先确保 GitHub token 已配置，然后运行：

```bash
ai2nao github sync --full
```

同步只会把 GitHub 数据镜像到本地 SQLite，不会修改 GitHub 上的 Star、topics、Lists 或 repo。

### 2. 打开开源雷达

启动服务后打开：

```text
/github/radar
```

页面会优先显示“现在值得看的线索”，而不是先显示待办队列。

### 3. 生成或刷新线索

点击页面顶部的 **刷新线索**。

刷新会读取：

- 本地 GitHub Star
- GitHub topics / language / repo 描述
- 本地已索引项目中的 `TODOS.md` 集合
- 本地已索引项目中的受限 `docs/**/*.md`
- 本地已索引项目中的 README 与语言 manifest
- 当前 git branch
- 最近 30 条 commit subject
- 你之前对线索做过的反馈

刷新是本地手动触发，不会自动写回 GitHub。

这些项目上下文来自 `ai2nao scan --root <workspace>` 写入的本地索引库。刷新线索不会偷偷递归扫描磁盘；如果还没有已索引项目，页面会以 warning 降级，而不是静默假装已经读取了全局上下文。

### 4. 查看证据

每条 insight card 会先给一句判断，例如：

```text
foo/bar 可能和当前工作有关
```

卡片上会显示证据摘要：

```text
3 个证据 · strong · TODO / docs / topics
```

点击 **查看证据** 可以展开 evidence drawer，看到这条判断来自哪些安全证据：

- TODO 命中的词
- 已索引项目 docs / README / manifest 命中的词
- branch / commit 线索
- repo topics
- repo facts

注意：这一版不会把 `TODOS.md` 或 docs 的原文片段直接展示在 API/UI 里，只展示安全 label、相对路径、matched terms 和权重。

### 5. 给线索反馈

每条线索有四个反馈按钮：

| 按钮 | 作用 |
|------|------|
| 有用 | 提升这类线索和相关 terms 的权重 |
| 不准 | 暂时压低或隐藏这条错误线索 |
| 以后看 | 暂时不在“现在值得看”里展示 |
| 忽略 | 更长时间隐藏这条 repo/线索 |

反馈不是纯 UI 状态。下一次刷新线索时，它会影响排序、隐藏和 suppression。

## 页面结构

### 顶部状态条

状态条告诉你当前线索快照是否可信：

| 状态 | 含义 |
|------|------|
| fresh | 线索已更新 |
| stale | 当前工作上下文变化后，线索可能需要重算 |
| partial | 部分上下文读取失败，但仍有可用线索 |
| empty | 没有 Star 数据 |
| error | 本次生成失败，旧线索仍保留 |

### 现在值得看的线索

页面主区域默认展示最重要的当前工作线索。它回答：

```text
哪些 Star 现在最可能帮到我？
```

### 重新变得有用

展示旧收藏中最近仍然活跃，或重新和当前工作产生关系的 repo。

### 可能该降级关注

展示 archived、长期不活跃、或被反馈为低价值的 repo。它不是批量清理工具，只是给你轻量提醒。

### 技术品味画像

从 Star topics 和 language tags 里提炼长期兴趣方向，例如：

- local-first
- agent tooling
- SQLite
- RAG
- developer memory

它更像一面镜子，不是任务列表。

### 旧雷达队列

旧版功能没有删除，而是折叠在页面底部：

- 待补理由
- 需要复盘
- 可能过期
- 下一步试
- 最近收藏
- note editor

这些仍然可用，但不再作为页面主工作流。

## 主要特点

### 本地优先

所有 insight、feedback、note 都写入本地 SQLite。页面不会写回 GitHub。

### 证据优先

每条线索都必须能展开查看证据。没有证据的内容不会作为高置信 insight 展示。

### 不把 Star 变成维护债务

它不会要求你先补齐所有收藏理由。系统先猜，再让你轻量纠偏。

### 可纠偏

反馈会影响下一次排序和隐藏规则：

- `useful` 会提升相关线索
- `wrong` 会压低或隐藏错误线索
- `later` 会短期隐藏当前推荐
- `ignore` 会更长时间隐藏

### 可降级

如果 docs、TODO 或 git log 读取失败，页面会显示 `partial`，而不是静默假装一切正常。

如果刷新失败，旧 snapshot 会保留，不会把已有可读内容清空。

### 安全证据边界

API 不返回本地文档原文 excerpt，也不返回绝对路径。Evidence drawer 只展示：

- source kind
- repo label + relative path
- safe label
- matched terms
- weight

## 新增 API

### `GET /api/github/radar/insights`

读取当前 materialized insight snapshot。

返回内容包括：

- `meta`
- `current_clues`
- `rediscovered`
- `retire_candidates`
- `taste_profile`
- `legacy_available`

### `POST /api/github/radar/insights/refresh`

手动刷新 insight snapshot。

特点：

- 单进程 single-flight，同一时间只跑一个 refresh
- 新 snapshot 在内存中生成，成功后事务提交
- 失败时保留旧 snapshot
- 记录 refresh metrics，例如耗时、扫描 docs 数、候选数、线索数

### `POST /api/github/radar/insights/feedback`

保存线索反馈。

示例：

```json
{
  "target_type": "insight",
  "target_id": "insight-fingerprint",
  "feedback": "useful",
  "insight_fingerprint": "insight-fingerprint",
  "repo_id": 123,
  "terms": ["agent", "rag"]
}
```

## 数据表

这一版新增三张表：

| 表 | 用途 |
|----|------|
| `gh_radar_insight_snapshot` | 保存每次生成的 snapshot meta、状态、fingerprint、refresh metrics |
| `gh_radar_insight` | 保存可查询的 insight 字段和 `evidence_json` |
| `gh_radar_insight_feedback` | 保存用户反馈及其过期规则 |

旧表仍然保留：

| 表 | 用途 |
|----|------|
| `gh_star` | GitHub Star 镜像 |
| `gh_repo_tag` | topics / language fallback 派生标签 |
| `gh_star_note` | 旧雷达的本地收藏理由和复盘状态 |

## 不在这一版里的内容

这一版刻意不做：

- LLM 自动写长摘要
- README 缓存
- GitHub Lists 写回
- embedding 聚类
- 自动 clone / install / fork
- 专门的 review session 模式

原因是：先把 evidence-first 的线索引擎跑稳，确认它真的比 Star 管理器更有用，再接更重的能力。

## 推荐验证方式

开发或回归时至少跑：

```bash
npm test -- github.radarInsights.test.ts github.radar.routes.test.ts GithubRadar.test.tsx
npm run build
```

全量验证：

```bash
npm test
```
