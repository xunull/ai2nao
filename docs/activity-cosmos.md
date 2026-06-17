# Activity Cosmos (`/dashboard/cosmos`)

> 把本地所有 AI 对话 session 嵌入 2D 语义空间，渲染成一张散点图。颜色 =
> source（Claude 蓝 / Codex 橙），大小 = log(token 数)，一键导出 PNG。
>
> 这是 ai2nao 首个以"出片"为目的的可视化模块：终产物是单帧截图，发 HN /
> Twitter 一眼讲明白"我和 AI 一年聊过的东西在语义空间里长什么样"。
>
> 本文是工程参考。**发给 embedding 的数据边界 + session 来源**的隐私向说明
> 见 `local-docs/2026-06-14-cosmos-embedding-data-boundary/README.md`。
> 设计 / 评审记录见
> `~/.gstack/projects/xunull-ai2nao/you-main-design-20260612-193633-activity-cosmos.md`。
>
> 版本：`COSMOS_RULE_VERSION = 1`。更新：2026-06-14。

---

## 1. 端到端数据流

```
~/.claude/projects/**/*.jsonl  ─┐
~/.codex/sessions/**/*.jsonl   ─┤  已被 token usage 层索引
                                │
                                ▼
        claude_session_token_usage / codex_session_token_usage
                                │   listSourceSessions()
                                ▼
                  ┌──────────────────────────┐
        (mtime,   │  per session              │
         size)    │  ─ stat 源文件            │
        skip ◄────┤  ─ 命中三元组? → skip      │
                  │  ─ 否则 summarize         │
                  └────────────┬─────────────┘
                               │ 首问 + 末答, strip, ≤2K char
                               ▼
                  ┌──────────────────────────┐
                  │  fetchEmbeddingsBatch()   │  src/rag/embeddings.ts
                  │  DashScope text-embed-v4  │  HTTPS, batch=10, 1024-dim
                  └────────────┬─────────────┘
                    ok ┌───────┴───────┐ 429/401/5xx
                       ▼               ▼
        work_cosmos_embeddings    embedding_status =
        (vector BLOB + summary)   rate_limited/auth_failed/provider_error
                       │
                       ▼  全部 ok 的 vector
                  ┌──────────────────────────┐
                  │  projectCosmosTo2D()      │  src/workCosmos/project.ts
                  │  UMAP-js → x,y            │  失败回退随机高斯投影
                  └────────────┬─────────────┘
                               ▼
                  work_cosmos_points.x/y  (仅坐标 + 元数据)
                               │
            ── HTTP 边界 ──────┼──────────────────────────────
                               ▼
        GET /api/work-cosmos/points   (无 summary，sanitize gate)
                               │
                               ▼
                  /dashboard/cosmos  Recharts ScatterChart
                               │
                               ▼
                  导出 PNG (html2canvas-pro)
```

---

## 2. 模块地图

| 文件 | 职责 |
|------|------|
| `src/workCosmos/types.ts` | `COSMOS_RULE_VERSION`、row / DTO / state 类型 |
| `src/workCosmos/summarize.ts` | 决定"发什么"——首问+末答抽取、strip 控制标签 / ANSI、≤2K 截断 |
| `src/workCosmos/queries.ts` | 两张表 + state 的 CRUD，`listCosmosPointsForApi`（API-safe） |
| `src/workCosmos/refresh.ts` | 主 pipeline：枚举 → skip → summarize → embed → 投影 → state |
| `src/workCosmos/project.ts` | UMAP-js 投影 + 随机高斯回退 |
| `src/workCosmos/progress.ts` | in-memory 进度单例（D5 轮询用） |
| `src/workCosmos/service.ts` | 组装响应 DTO，读 rag.json 拿 embedding model 名 |
| `src/workCosmos/json.ts` | sanitize gate —— 显式逐字段拷贝，summary 永不进 payload |
| `src/workCosmos/routes.ts` | 3 个 Hono 端点 |
| `src/scheduler/taskDefinitions.ts` | 注册 `work.cosmos.refresh` 调度任务 |
| `web/src/pages/Cosmos.tsx` | 前端散点图页 + 刷新轮询 + PNG 导出 |
| `web/src/util/exportPng.ts` | html2canvas-pro 懒加载封装 |

---

## 3. Session 来源

`refresh.ts:listSourceSessions()` 只从两张派生表拉数据：

| Source | 来源表 | 路径字段 |
|--------|--------|----------|
| `claude` | `claude_session_token_usage` | `file_path` |
| `codex` | `codex_session_token_usage` | `rollout_path` |

均带 `WHERE missing_since IS NULL`。**Cursor / Cherry / LLM Chat / LMStudio
尚未接入**（它们还没进 token usage 层；见 §8 Phase 2）。

当前实测（2026-06-14）：Claude 79 + Codex 127 = **206 session**。

---

## 4. 发给 embedding 的内容（摘要）

`summarizeSessionForCosmos()` 产出**原文节选**，不是 LLM 改写：

```
text = 第一条实质 user 消息 + "---" + 最后一条实质 assistant 回复  (≤2048 字符)
```

- "实质" = strip 掉控制标签（`<command-*>` / `<bash-*>` / `<system-reminder>`
  / `<local-command-*>`）和 ANSI 序列后长度 ≥20 字符。
- 中间轮次、工具调用、代码、thinking **不参与**。
- 都抽不到 → 返回 `null`，session 标 `embedding_status='no_summary'`，不渲染。

详细数据边界（含会发 / 不会发对照表、strip 清单、隐私收紧方向）见
`local-docs/2026-06-14-cosmos-embedding-data-boundary/README.md`。

---

## 5. Schema（v27）

### `work_cosmos_points`（散点表，进 API）

```
session_id PK | source ('claude'|'codex') | source_path | source_mtime_ms |
source_size_bytes | project_key | project_path | total_tokens |
x | y | cluster_id (NULL, Phase 2) | token_status | embedding_status |
missing_since | source_seen_at | updated_at
```

### `work_cosmos_embeddings`（sidecar，**不进 API**）

```
session_id PK (FK → points, ON DELETE CASCADE) | embedding_dim |
vector BLOB | summary TEXT | updated_at
```

> **D3 隐私决策**：summary 文本只在 sidecar，散点表没有这列。API 端点永远
> 只读散点表，所以 summary 不会进任何前端 payload 或导出的 PNG。

### `work_cosmos_state`（单例）

记录 rule_version + 最近一次 refresh 统计（source/indexed/embedded/no_summary/
error/skipped 计数 + projection_method + projected_session_count + duration）。

---

## 6. 投影（UMAP + 回退）

`projectCosmosTo2D()`：

- **主路径**：UMAP-js，`nComponents=2, nNeighbors=min(10, N-1), minDist=0.05,
  nEpochs=200`，seeded random 保证可复现。
- **回退到随机高斯投影**（Johnson-Lindenstrauss）的判据：
  1. 点数 < 4（UMAP 在小样本上不稳）
  2. UMAP 抛错
  3. 输出含 NaN / Inf
  4. 输出方差 < 1e-6（退化到一点）
- 回退仍写 `projection_method='pca'`（schema enum 复用），坐标永远写得出来。

实测：206 点 UMAP 约 1.4s，x 跨度 ~27、y 跨度 ~19。

---

## 7. API 端点

| 方法 | 路径 | 行为 |
|------|------|------|
| GET | `/api/work-cosmos/points` | 返回 sanitized DTO `{ ok, generatedAt, pointCount, projectionMethod, embeddingModel, points[] }`。只含已投影（x/y 非 null）+ `embedding_status='ok'` + 非 missing 的点。**无 summary**。 |
| POST | `/api/work-cosmos/refresh` | 经 `scheduler.runNow('work.cosmos.refresh')` 触发。lease 已持有 → **409**；scheduler 未注入 → 503。 |
| GET | `/api/work-cosmos/refresh-status` | 返回 in-memory 进度 `{ phase, indexedCount, totalCount, embeddedCount, ... }`，前端每 1s 轮询。 |

### 并发与进度（D4 / D5）

- **D4 lease**：refresh 复用 scheduler 的 `acquireTaskLease`。用户连点两次，第二次
  拿不到 lease → 409 "task already running"，不会双跑 embedding 浪费 quota。
- **D5 进度**：首次 refresh ~30-60s。`progress.ts` 单例记录 phase
  （scanning → embedding → projecting → done），前端轮询展示 "embedding 87/206"。
  进度是 in-memory、非持久化；重启 server 后回 idle，历史从 state 表读。

### 调度

`work.cosmos.refresh` 默认 6h interval。新装默认不会自动打 DashScope——用户在
页面点"刷新"按钮（走 `scheduler.runNow`）才首次填充。

---

## 8. 限制与 Phase 2 路线

### 当前限制

- 只覆盖 Claude + Codex（~206 点）。
- embedding 走远端 DashScope（非 local-first，页面如实标注）。
- summary 是"首问 + 末答"启发式，长 session 中段语义抓不到。
- cluster_id 恒为 NULL（无语义聚类标注）。
- PNG 导出走 html2canvas-pro（client-side），未做 server-side 渲染。

### Phase 2（不在首版，TODOS 已挂）

- 接入 Cursor / Cherry / LLM Chat session（TODOS #7 / #25）。
- 本地 embedding fallback（LMStudio nomic-embed / Ollama bge，TODOS #29）—— 让
  "truly local-first" 叙事成立。
- HDBSCAN-js 聚类 + LLM 自动标 cluster label（填 `cluster_id`）。
- 多视角切换（按月 / 按 cluster / 按 source）。
- 时间游标：拖滑块看 cosmos 随时间生长。
- 内部 / 公开模式 toggle：内部模式 tooltip 展示 session 标题。

---

## 9. 测试

| 文件 | 覆盖 |
|------|------|
| `test/workCosmos.migration.test.ts` | v27 三表 schema、CHECK 约束、FK 级联、state 单例 |
| `test/workCosmos.summarize.test.ts` | strip 控制标签 / ANSI、首问末答抽取、2K 截断 |
| `test/workCosmos.refresh.test.ts` | happy / skip / no_summary / full / self-heal / 429 / 401 / missing / state |
| `test/workCosmos.project.test.ts` | UMAP 输出有限性 + 方差、<4 点回退、missing/pending 排除 |
| `test/workCosmos.routes.test.ts` | points 形状、503/200、**409 并发 lease**、进度轮询 |
| `test/workCosmos.sanitize.test.ts` | ★ summary 永不进 JSON、内部字段不泄漏、行过滤 |
| `test/Cosmos.test.tsx` | 空态、header/footer、刷新 POST、失败 banner（Recharts 视觉留给手动 QA） |

> jsdom 不跑 Recharts layout，所以 legend / tooltip / 散点不在 DOM 里，前端
> 测试只断言 chart 外的元素 + API 契约。
