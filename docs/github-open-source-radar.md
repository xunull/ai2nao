# GitHub 开源雷达（设计规格）

**状态：** 已实现（v1）  
**入口：** `/github/radar`  
**相关命令：** `ai2nao github sync` / `ai2nao github sync --full`

---

## 目标

GitHub Star 不应该只是一个按时间倒序排列的旧收藏列表。开源雷达把 Star 变成本地优先的技术记忆层：记录为什么收藏、现在是否还活跃、哪些项目需要复盘，以及收藏集中在哪些技术方向。

v1 回答三个问题：

- 哪些 Star 需要补收藏理由？
- 哪些项目已经过期、归档或很久没复盘？
- 我的 Star 主要聚在哪些主题方向？

## 范围

已实现：

- 本地收藏理由与复盘状态：`gh_star_note`
- Radar 信号：`missing_reason`、`needs_review`、`stale`、`archived`、`recently_starred`、`active_recently`
- Topic cluster 与 language-only 分区
- `/api/github/radar`
- `/api/github/radar/notes/:repo_id`
- `/github/radar` Web 页面
- Note 保存失败时保留草稿，并允许重试

不在 v1 范围：

- AI 摘要 / 重新发现推荐
- GitHub 原生 Star Lists 同步或写回
- ML / embedding 聚类
- 移动端优先 UI
- 任何写回 GitHub 的操作

## 数据流

```text
GitHub REST API
    |
    v
syncGithub()
    |
    +--> gh_star -----------+
    +--> gh_repo_tag -------+----> SQL-first radar aggregation
    +--> gh_sync_state      |
                            |
local note edits            |
    |                       |
    v                       v
gh_star_note --------> src/github/radar.ts
                            |
                            v
                  /api/github/radar*
                            |
                            v
                    /github/radar UI
```

`syncGithub()` 仍然是只读 GitHub 镜像。Radar 页面里的 note/status 保存只写 ai2nao 本地 SQLite，不会修改 GitHub Star、GitHub Lists、repo topics 或任何远端数据。

## 数据模型

### `gh_star`

Radar v1 复用已有 Star 镜像，并补充两个健康信号字段：

| 字段 | 说明 |
|------|------|
| `archived` | GitHub repo 是否已归档 |
| `pushed_at` | GitHub repo 最近 push 时间，用于 stale / active 判断 |

### `gh_star_note`

本地用户记忆表。它不绑定 `gh_star` 的删除生命周期，不使用 `ON DELETE CASCADE`。原因：note 是用户在 ai2nao 里写下的私有资产，不应因为未来 unstar 清理或 GitHub 镜像行缺失而被误删。

| 字段 | 说明 |
|------|------|
| `repo_id` | GitHub numeric repo id，主键 |
| `reason` | 为什么收藏这个项目 |
| `status` | 复盘状态 |
| `last_reviewed_at` | 最近复盘时间 |
| `source` | v1 固定为 `user` |
| `created_at` | note 创建时间 |
| `updated_at` | note 更新时间 |

状态枚举：

| status | 含义 |
|--------|------|
| `new` | 新收藏或尚未处理 |
| `reviewed` | 已复盘 |
| `try_next` | 下一步值得试 |
| `ignore` | 暂不关注 |
| `retired` | 曾经有用，现在退役 |

## Radar 信号

| 信号 | 规则 |
|------|------|
| `missing_reason` | 没有 note，或 `reason` 为空 |
| `needs_review` | `last_reviewed_at` 早于 12 个月前 |
| `stale` | 非 archived，且 `pushed_at` 早于 18 个月前 |
| `archived` | GitHub repo 已归档 |
| `recently_starred` | `starred_at` 在最近 30 天内 |
| `active_recently` | `pushed_at` 在最近 90 天内 |

时间相关查询在 `src/github/radar.ts` 中支持注入 clock，测试可以固定边界时间。Route 默认使用当前时间。

## Topic Cluster

Radar 的主题方向来自 `gh_repo_tag`，也就是 GitHub topics 经过 alias 归一后的结果。

v1 规则：

- 主 `clusters` 默认只展示真实 topic。
- `language:*` fallback 不混入主方向榜。
- 没有 topic、只能回退到语言的 repo 进入 `language_only` 分区。

这样可以避免 `language:typescript`、`language:go` 这类大桶淹没真正的技术主题，同时不丢掉 no-topic repo 的复盘入口。

## API

### `GET /api/github/radar`

返回开源雷达总览。

Query params：

| 参数 | 说明 |
|------|------|
| `cluster_limit` | 可选，限制 topic cluster 数量 |
| `queue_limit` | 可选，限制每个复盘队列返回的 repo 数量 |

响应结构：

```ts
type GhRadarOverviewRes = {
  generated_at: string;
  thresholds: {
    stale_before: string;
    needs_review_before: string;
    recently_starred_since: string;
    active_recently_since: string;
  };
  counts: {
    total_stars: number;
    missing_reason: number;
    needs_review: number;
    stale: number;
    archived: number;
    recently_starred: number;
    active_recently: number;
    try_next: number;
  };
  clusters: GhRadarCluster[];
  language_only: GhRadarCluster[];
  queues: {
    missing_reason: GhRadarRepo[];
    needs_review: GhRadarRepo[];
    stale: GhRadarRepo[];
    try_next: GhRadarRepo[];
    recently_starred: GhRadarRepo[];
  };
};
```

### `POST /api/github/radar/notes/:repo_id`

写入或更新本地 note。

Request body：

```json
{
  "reason": "想对比 agent framework 的插件系统",
  "status": "try_next",
  "last_reviewed_at": "2026-05-02T08:00:00.000Z"
}
```

行为：

- `repo_id` 非正整数返回 400。
- `status` 不在枚举内返回 400。
- SQLite 写入失败返回 500 JSON error。
- 不要求 `repo_id` 当前一定存在于 `gh_star`，避免本地 note 随镜像清理丢失。

## Web 页面

`/github/radar` 包含：

- 顶部指标：总 Star、待补理由、需复盘、过期、归档、最近收藏、最近活跃、行动队列。
- 左侧主题方向：topic clusters。
- 左侧 language-only：只有语言 fallback 的项目分区。
- 右侧复盘队列：待补理由、需要复盘、可能过期、下一步试、最近收藏。
- Repo card note editor：收藏理由 textarea + 状态 select + 保存按钮。

交互约束：

- 保存中禁用按钮，避免重复提交。
- 保存失败时保留草稿，显示错误，并允许重试。
- 页面不写回 GitHub，只写本地 SQLite。

## 实现文件

| 文件 | 说明 |
|------|------|
| `src/store/migrations.ts` | v15 schema：`gh_star_note`、`gh_star.archived`、`gh_star.pushed_at` |
| `src/github/queries.ts` | `upsertStar` 保存 archived / pushed_at |
| `src/github/radar.ts` | note CRUD、signals、clusters、overview DTO |
| `src/github/routes.ts` | Radar API routes |
| `web/src/types/github.ts` | 前端 DTO mirror |
| `web/src/pages/GithubRadar.tsx` | Radar 页面 |
| `web/src/App.tsx` | `/github/radar` lazy route |
| `web/src/components/Layout.tsx` | 导航入口 |

## 测试覆盖

| 测试文件 | 覆盖 |
|----------|------|
| `test/github.radar.test.ts` | schema、note CRUD、signals、clusters、corrupt topics fallback |
| `test/github.radar.routes.test.ts` | API DTO、note save、400 validation、500 error |
| `test/GithubRadar.test.tsx` | UI 渲染、token guidance、pending 禁用、防重复保存、保存失败保留草稿 |

验收命令：

```bash
npm run build
npm test
```

当前实现通过全量测试：62 个 test files，264 个 tests。

## 后续方向

- AI 摘要 / 重新发现推荐：建立在稳定的 note/status/signals 之上，必须有缓存版本、失败状态和隐私说明。
- Radar drilldown：点击 topic cluster 后查看该方向下的 repo 详情。
- Note 管理视图：显示 orphan notes，便于处理已经 unstar 但仍保留本地记忆的项目。

---

与实现不一致时，以当前代码和测试为准，并同步更新本文档。
