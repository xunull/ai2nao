# ai2nao 实施计划（单一真相来源）

本文档汇总截至 2026-04 的对话共识，供实现与评审引用。若与代码冲突，**以代码为准**时应尽快回写本文档，避免漂移。

---

## 1. 产品一句话

**本机优先**的个人数字痕迹索引器：先从 **Git 仓库 + 清单文件** 入手，索引入 **SQLite + FTS**；Web 层可选 **只读挂载 [Atuin](https://github.com/atuinsh/atuin) 的 `history.db`**，按日历查看 shell 历史。后续可扩展 AI 对话、浏览器历史等来源。

**信任原则**：本地运行、用户可排除路径/清空来源；不预设「全是公开数据」。

---

## 2. 当前已实现（Wave 1 CLI）

- **CLI**：`scan` / `status` / `search`
- **存储**：`better-sqlite3`，表 `repos`、`manifest_files`、`manifest_fts`（独立 FTS5 + `rowid` 同步）、`jobs`
- **默认 DB**：`~/.ai2nao/index.db`（可用 `--db` 覆盖）
- **多次 `scan`**：同一库上为更新模式；磁盘上已删除的清单文件，当前实现**不会**自动删库中旧行（已知局限，可后续补「按次扫描清理」）

### 2.1 Web + 扩展（已与 Wave 1 一并交付）

- **只读 HTTP**：`ai2nao serve`（`--db` 指向索引库，可选 `--atuin-db` 指向 Atuin `history.db`；未指定时若存在 `~/.local/share/atuin/history.db` 则自动挂载）
- **仓库列表分页**：`/repos` 使用 `?page=`，每页条数固定于前端常量（当前 25）
- **清单正文**：合法 JSON（如 `package.json`）支持 **Prism.js（prism-react-renderer）** 高亮 +「格式化 / 原始」切换
- **Atuin 日历页**：`/atuin`，**react-day-picker** 月视图，按**服务端本地时区**聚合并展示每日命令（只读，不写入 Atuin 库）

---

## 3. Web 展示层（首版范围）

### 3.1 目标

在 **本机** 用浏览器只读查看索引：**统计、仓库列表（分页）、清单列表、单文件正文（JSON 高亮）、全文搜索**，以及可选的 **Atuin 历史按日浏览**。  
**不包含**：网页内触发 `scan`、登录、对公网默认监听。

### 3.2 技术栈（已定）

| 层级 | 选择 | 明确不采用 |
|------|------|------------|
| HTTP API | **Hono**（`@hono/node-server`） | Nest.js |
| 前端 | **Vite + React + TypeScript** | Next.js |
| 路由 | React Router | — |
| 数据请求 | TanStack Query（推荐） | — |
| 样式 | Tailwind + 可选 shadcn/ui；或 CSS Modules | — |
| 日历（Atuin 页） | **react-day-picker** + **date-fns** | — |
| JSON 高亮 | **prism-react-renderer**（Prism） | — |

**监听**：默认仅 **`127.0.0.1`**；若需局域网再通过显式 `--host` 等参数扩展（后续）。

**架构原则**：HTTP 与领域/查询分离（`src/read/`、`src/store/`、`src/atuin/queries.ts` 只读），便于日后若迁移框架，业务逻辑可复用。Atuin 使用**第二个 SQLite 文件**只读打开，与索引库 **不混库**。

---

## 4. 信息架构（IA）

### 4.1 路由

| 路径 | 说明 |
|------|------|
| `/` | **重定向到** `/repos`（单一主页，避免双入口） |
| `/repos` | **主枢纽**：KPI + 仓库表格；**分页** `?page=`（从 1 起，缺省等价第 1 页） |
| `/repos/:id` | 单仓库：manifest 列表 |
| `/repos/:id/file?path=` | 单文件正文（`path` 为 `rel_path`，URL 编码）；JSON 可格式化 + 语法高亮 |
| `/search` | FTS 搜索；`?q=` 与输入框同步 |
| `/atuin` | **可选**：Atuin shell 历史，日历按日 + 当日命令列表（未配置 `history.db` 时显示说明） |

### 4.2 全局壳

- **顶栏**：品牌名（回 `/repos`）、「仓库」→ `/repos`、「搜索」→ `/search`、「Atuin」→ `/atuin`
- **顶栏紧凑搜索**（可选）：仅 **跳转** `/search?q=...`，不在顶栏展开完整结果列表

### 4.3 首屏视线顺序（`/repos`）

1. 页面标题 + KPI 条（仓库数、manifest 数、最近 job）
2. 仓库表格（主列）
3. 分页条：总条数、每页条数、当前页、上一页/下一页（总页数大于 1 时显示）

---

## 5. 线框级页面说明

### 5.1 `/repos`

- **KPI**：仓库数、已索引文件数、最近任务（`#jobId · scan · 状态 · 时间`）
- **表格列**：短路径展示（全路径 tooltip 或展开）、origin、最后扫描
- **空状态**：说明尚未索引 + 可复制命令示例 `ai2nao scan --root <目录>`
- **错误**：数据库无法打开时的明确提示

### 5.2 `/repos/:id`

- **返回** → `/repos`
- **标题区**：短名 + origin + 最后扫描
- **表**：rel_path、size、mtime；行点击进入文件页

### 5.3 `/repos/:id/file`

- **返回** → `/repos/:id`
- **正文**：等宽区域；长文内部滚动
- **JSON**：能解析为 JSON 时默认 **格式化**（2 空格缩进），可切换「原始文本」；使用 **Prism** `language="json"` 与浅色主题（`vsLight`）高亮

### 5.4 `/atuin`

- **前提**：serve 已挂载 Atuin `history.db`（见 `--atuin-db` 与自动探测）
- **布局**：左侧 **月历**（有历史条数的日期高亮），右侧 **选中日的命令表**（时间、命令、cwd、exit）
- **时区**：按 **运行 `serve` 的机器本地时区** 划分「日」；与 Atuin 表字段 `timestamp`（纳秒）一致
- **空/未启用**：说明如何安装 Atuin 与 `--atuin-db`

### 5.5 `/search`

- 大搜索框 + 一句 FTS5 说明 + 文档链接
- 结果：仓库路径（短显示）、rel_path、snippet；点击进文件页（需 API 返回 `repo_id` 等）

---

## 6. API 草案（只读）

实现时以实际路径为准，以下为概念契约：

| 方法 | 路径 | 用途 |
|------|------|------|
| GET | `/api/status` | 对应 `getStatusSummary` |
| GET | `/api/repos?page=&limit=` | 仓库分页列表 |
| GET | `/api/repos/:id` | 仓库详情 + manifest 列表（或拆成两个端点） |
| GET | `/api/repos/:id/manifest?path=` | 单文件全文（`path` 为 `rel_path`，URL 编码） |
| GET | `/api/search?q=&limit=` | FTS 搜索；限制 `limit` 上限 |
| GET | `/api/atuin/status` | `{ enabled: boolean, path?: string }`，是否已挂载 Atuin 库 |
| GET | `/api/atuin/month?year=&month=` | 指定年月的本地日历日 → 条数（用于日历高亮） |
| GET | `/api/atuin/day?date=YYYY-MM-DD` | 当日历史记录列表（有上限，见实现） |

**安全**：FTS 查询需校验长度/防注入；错误时 **400** 可读说明，不泄露堆栈。Shell 历史属敏感数据，**仅本机、默认 127.0.0.1**；若对外暴露需额外评审。

**SQLite**：Web 进程 **只读**（如 `query_only` 或仅 SELECT）; 与 CLI `scan` 并发时依赖 WAL；**不在 Web 内写索引库**。Atuin 文件 **单独只读连接**，**不**对 `history.db` 做写入。

---

## 7. 设计约束（App UI）

类型：**本机数据工具（App UI）**，非营销落地页。

- **避免**：紫蓝渐变、三列图标功能卡、首屏大段「欢迎使用」营销文案、无意义的装饰性卡片墙
- **优先**：顶栏 + 表格、冷静层级、utility 文案
- **最小设计令牌**（建议 CSS 变量）：`--bg`、`--fg`、`--muted`、`--border`、`--accent`
- **字体**：UI 用 `system-ui` 等；代码/正文区用 `ui-monospace` 栈
- **触控**：目标 ≥ 44px；表格行高约 40–44px

### 7.1 交互状态（验收用）

| 功能 | LOADING | EMPTY | ERROR | SUCCESS |
|------|---------|-------|-------|---------|
| 仓库列表 | 骨架或文案 | 引导 scan | DB 打不开 | 表格 |
| 仓库详情 | 同左 | 无 manifest | 404/500 | 有表 |
| 文件正文 | 轻量 loading | — | 404/500 | 有正文 |
| 搜索 | loading | 无 q 不请求 | FTS 语法错 | 有结果 |
| Atuin 日历 | loading | 未启用 DB | 路径无效/500 | 月历 + 当日列表 |

### 7.2 响应式与无障碍（首版须满足）

- 窄屏：表格 **横向滚动**；顶栏 **汉堡或两行**（实现前二选一）
- 地标：`header` / `main` / `nav`；表格语义正确
- 键盘：链接可 Tab；搜索框 Enter 提交

### 7.3 待决（实现前定一条）

- 窄屏导航：**汉堡 vs 双行顶栏**
- 路径展示：**默认显示最后 1 段 vs 2 段**（隐私 vs 辨识度）
- 页脚是否展示 DB 路径：建议 **默认隐藏**，调试区展开

---

## 8. 明确不在首版范围

- Nest.js、Next.js
- 网页内触发 `scan`
- 默认对 `0.0.0.0` 暴露
- 暗色主题、国际化、复杂图表（可后补）
- **Atuin**：在 Web 内修改/删除历史、同步账号、跨机器时区协商 UI
- **超大 `history.db`**：流式加载与完整分页（当前单日列表有上限）

---

## 9. 实施顺序建议

1. **只读查询层**：`listRepos`、`getRepo`、`getManifestBody`、`search`（复用/扩展 `store`）
2. **Hono**：`serve` 子命令、`/api/*`、默认 `127.0.0.1`
3. **Vite + React**：路由、TanStack Query、页面骨架
4. **联调**：Vite dev proxy → API；生产由 Hono 提供 `web/dist` 静态资源
5. **测试**：API 集成测试（临时 DB）；关键查询单元测试

---

## 10. 文档与技能

- 本文件为 **计划与产品决策** 的权威来源
- 更细的 **视觉规范** 可另增 `DESIGN.md`（令牌与组件约定），与本文档对齐
- gstack 技能（如 `/plan-design-review`）可引用本文件路径：`docs/PLAN.md`

---

## 11. 修订记录

| 日期 | 说明 |
|------|------|
| 2026-04-06 | 初始创建：整合 IA、栈、线框、设计约束、API 草案；同日补充：仓库分页、JSON+Prism、Atuin 日历页与 `--atuin-db`、相关 API 与 IA |
