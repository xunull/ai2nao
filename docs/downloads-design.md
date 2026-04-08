# 下载目录索引（设计规格）

**状态：** 已实现（v1）  
**主文档副本（会话/修订历史）：** `~/.gstack/projects/xunull-ai2nao/quincy-main-design-20260408-095619.md`

---

## 目标

- 默认只扫描 **macOS / Windows** 系统「下载」目录：`path.join(homedir(), 'Downloads')`。
- SQLite **只 INSERT、不 DELETE**；列表 **仅在 Web** 展示（**不提供**「CLI 打印已记录文件」）。
- 多次扫描时 **仅当新组合出现才插入一行**，控制体积。

## 去重键（定稿）

**唯一性：** `(root_path, rel_path, file_birthtime_ms)`

| 字段 | 说明 |
|------|------|
| `root_path` | 规范化绝对路径，便于未来多根扩展 |
| `rel_path` | 相对下载根的相对路径（**含子目录**），避免仅用 basename 撞名 |
| `file_birthtime_ms` | `fs.stat` 的 `birthtimeMs`，区分同路径上「换了一个新文件」（如删了又下） |

逻辑：遍历文件 → 算三元组 → 库中已存在则 **跳过** → 否则 **INSERT**。可实现为 `UNIQUE(root_path, rel_path, file_birthtime_ms)` + `INSERT OR IGNORE`。

**birthtime 不可用**时的退化策略在实现阶段与 `/plan-eng-review` 锁死（含 UI 提示）。

## 其他字段建议

- `observed_at`、`calendar_day`：插入时刻与按日筛选。
- `file_mtime_ms`、扩展名分类等：展示与筛选。
- 可选批次表 `download_scans`（`inserted_count`、错误信息）便于调试。

## 扫描如何触发

| 方式 | 说明 |
|------|------|
| CLI 单次 | `ai2nao downloads scan`（命令名实现时可微调） |
| CLI 定时 | `ai2nao downloads watch --interval <秒>`；可在 `package.json` 的 `scripts` 里薄封装（如 30s） |
| Web | 页面 **「立即扫描」** 调用与单次 CLI **同一套**扫描逻辑；建议 `POST /api/downloads/scan` |

**注意：** `serve` 内建定时与独立 `watch` 进程 **二选一**，避免同一间隔重复扫描。

## Web 与 API（方向）

- 路由如 `/downloads`：`DayPicker` + 当日列表 + 扫描按钮。
- `GET /api/downloads/status`、`month`、`day` 等只读接口与现有 Hono 模式一致；`POST` 触发扫描时需处理 CORS 方法列表。

## 隐私

下载目录文件名可能敏感：文档与 UI 中提示；默认可 basename 展示、完整路径可展开。

## 后续优化（不阻塞 v1）

见仓库根目录 **`TODOS.md`**：**「下载目录索引：下载过程中 birthtime / mtime 抖动」**（大文件下载过程中时间戳变化可能导致重复/噪声行）。

## 验收要点

- 同一 `(rel_path, file_birthtime_ms)` 在多次扫描下 **不重复插行**。
- Migration v2 可升级；关键路径有测试覆盖。

## 实现顺序（建议）

1. `migrations.ts` v2 表与 `UNIQUE`  
2. `src/downloads/` 扫描内核 + 查询  
3. CLI `scan` / `watch` + `package.json` scripts  
4. `POST /api/downloads/scan` 与页面  
5. `README` 片段  

---

与主文档不一致时，以 **`~/.gstack/projects/xunull-ai2nao/quincy-main-design-*.md`** 中最新日期版本为准，并同步更新本文件。
