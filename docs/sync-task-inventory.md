---
title: Sync 型任务清单
category: 数据源与同步
order: 100
---
# Sync 型任务清单

统计日期：2026-06-04

本文统计当前项目中已经存在的同步、扫描、重建、索引类任务，为后续设计统一定时任务系统提供输入。统计范围包括：

- `package.json` 中已经暴露的快捷脚本。
- `src/cli.ts` 中已有的 CLI 子命令。
- `src/serve/app.ts` 及各模块 `routes.ts` 中已有的 Web/API 手动触发入口。
- 已有 SQLite 状态表和运行记录表。

本文不统计纯查询、纯展示、reset、测试、构建和开发服务器命令。

## 总览

当前可归入 sync 类型的任务可以分为四类：

| 层级 | 数量 | 说明 |
|---|---:|---|
| `package.json` 已暴露的主同步入口 | 9 | 包括 watch、sync、full sync、RAG ingest。 |
| `package.json` 已暴露的维护/重建入口 | 2 | GitHub tags rebuild 和 tag alias seed。 |
| 源码中已有、适合纳入统一 scheduler 的独立任务形态 | 18 | 包括 package scripts 未暴露的 Hugging Face、LM Studio、Cursor、Atuin、RAG 维护等；表中另列 1 个 Chrome downloads API 别名。 |
| Web/API 已有手动触发入口 | 10 | 多数本地 inventory 和 Chrome/Atuin 任务已有 API；其中 Chrome downloads sync 与 Chrome History 共用底层任务。 |

核心观察：

- 现有 `watch` 任务只有 `downloads watch` 和 `chrome-history watch`，都是在 CLI 中用 `setInterval` 轮询。
- `chrome-history watch` 已在 CLI 描述中明确提示不要让两个 watch 进程同时写同一个 DB，说明统一调度首先需要互斥和运行状态，而不只是 cron 表达式。
- 本地 inventory 类任务已经有 `local_inventory_sync_runs` 运行记录，适合作为统一 run history 的参考。
- Downloads、Chrome History、VS Code、GitHub、RAG、Atuin 等模块各有自己的状态语义，目前还没有统一的 scheduler 任务表。

## V1 实现状态

Scheduler V1 已按“serve 内置、本地 SQLite、默认关闭、interval 调度”的边界实现。设计细节见 [scheduler-design.md](./scheduler-design.md)。

V1 已注册的任务：

- `downloads.scan`
- `mac_apps.sync`
- `brew.sync`
- `huggingface.models.sync`
- `lmstudio.models.sync`
- `vscode.recent.sync`
- `cursor.projects.sync`
- `chrome.history.sync`
- `chrome.domains.rebuild`
- `atuin.directories.rebuild`

V1 暂未纳入 GitHub sync、RAG ingest/optimize/cleanup、repo scan 和 GitHub tag alias seed。

## package.json 中已有的 sync 类型脚本

### 主同步入口

| 脚本 | 底层命令 | 类型 | 当前语义 | 调度建议 |
|---|---|---|---|---|
| `downloads:watch` | `tsx src/cli.ts downloads watch --interval 30` | 高频 watch | 每 30 秒扫描本机下载文件夹。 | 可迁移为 `downloads.scan` 的 interval 任务；不建议保留独立 watch 进程作为最终形态。 |
| `apps:sync` | `tsx src/cli.ts apps sync` | 本地 inventory | 扫描 macOS `.app` 应用并写入索引库。 | 适合低频定时，例如数小时或每天。 |
| `brew:sync` | `tsx src/cli.ts brew sync` | 本地 inventory | 读取 Homebrew formula/cask 清单并写入索引库。 | 适合低频定时；需要处理 `brew` 命令耗时和不可用情况。 |
| `vscode:sync` | `tsx src/cli.ts vscode sync` | 本地 editor history | 读取 VS Code `state.vscdb` 最近项目/文件。 | 适合中低频定时；注意读取前会复制快照。 |
| `chrome-history:sync` | `tsx src/cli.ts chrome-history sync` | 本地 browser history | 同步 Chrome visits 和 downloads 到索引库，并触发 domain pivot rebuild。 | 适合中频定时；必须按 profile/source path 加锁。 |
| `chrome-history:watch` | `tsx src/cli.ts chrome-history watch --interval 30` | 高频 watch | 每 30 秒执行 Chrome History sync。 | 应迁移为 scheduler interval；同一 DB 不允许并发 watch。 |
| `github:sync` | `tsx src/cli.ts github sync` | 网络 sync | 增量同步 GitHub repos/stars/commit counts，并重建相关 tag。 | 适合低频定时；需要 token、rate limit、失败退避。 |
| `github:sync:full` | `tsx src/cli.ts github sync --full` | 网络 full sync | 忽略水位，完整重建 GitHub 镜像。 | 不建议默认定时；更适合手动或很低频维护。 |
| `rag:ingest` | `tsx src/cli.ts rag ingest` | 本地索引 | 扫描 RAG corpus，写入 FTS/manifest/vector。 | 适合显式 opt-in；默认可先只做手动触发。 |

### 维护/重建入口

| 脚本 | 底层命令 | 类型 | 当前语义 | 调度建议 |
|---|---|---|---|---|
| `github:tags:rebuild` | `tsx src/cli.ts github tags rebuild` | 派生表重建 | 从 GitHub stars/topics/language 重建 `gh_repo_tag`。 | 可作为 GitHub sync 后置任务；不需要独立高频定时。 |
| `github:tags:alias:seed` | `tsx src/cli.ts github tags alias seed` | 种子数据维护 | 写入预设 tag alias，保留用户 override。 | 一次性/手动维护；不建议周期执行。 |

未纳入 sync 统计的相关脚本：

- `apps:reset`、`brew:reset`、`vscode:reset` 是破坏性 reset，不应进入定时系统。
- `vscode:windows` 是只读检查命令，不写索引。
- `build`、`dev:*`、`test:*` 不属于数据同步任务。

## 源码中已有的可调度任务形态

| 建议任务键 | 当前入口 | Web/API | 实现位置 | 现有状态/运行记录 | 调度优先级 |
|---|---|---|---|---|---|
| `repo.scan` | `ai2nao scan --root <dir>` | 无 | `src/cli.ts` + `src/store/operations.ts` | `jobs` 表记录早期 scan job。 | 中。项目核心索引任务，但需要先明确 roots 配置。 |
| `downloads.scan` | `ai2nao downloads scan`、`downloads watch` | `POST /api/downloads/scan` | `src/downloads/scan.ts` | 无独立 run history；写 `download_files`。 | 高。可直接替代 `downloads:watch`。 |
| `chrome.history.sync` | `ai2nao chrome-history sync/watch` | `POST /api/chrome-history/sync` | `src/chromeHistory/sync.ts` | `chrome_history_sync_state` 保存 profile/source 水位。 | 高。需要互斥、profile 参数和失败记录。 |
| `chrome.downloads.sync` | 无独立 CLI；随 Chrome History sync 处理 | `POST /api/chrome-downloads/sync` | `src/chromeHistory/sync.ts` | 同 `chrome.history.sync`。 | 不建议作为独立后台任务；更适合作为 Chrome sync 的视图/API 别名。 |
| `chrome.domains.rebuild` | `ai2nao chrome-history domains rebuild` | `POST /api/chrome-history/domains/rebuild` | `src/chromeHistory/domainPivot.ts` | `chrome_history_domain_state` 记录 freshness、错误和耗时。 | 中。可作为 Chrome sync 后置任务。 |
| `github.sync.incremental` | `ai2nao github sync` | 无 | `src/github/sync.ts` | `gh_sync_state` 保存 full/incremental 状态和错误。 | 中。网络敏感，默认低频。 |
| `github.sync.full` | `ai2nao github sync --full` | 无 | `src/github/sync.ts` | `gh_sync_state`。 | 低。手动优先。 |
| `github.tags.rebuild` | `ai2nao github tags rebuild` | 无 | `src/github/tags.ts` | 派生写入 `gh_repo_tag`。 | 低到中。适合作为 GitHub sync 后置任务。 |
| `github.tags.alias.seed` | `ai2nao github tags alias seed` | 无 | `src/github/tags.ts` | 写入 `gh_tag_alias`。 | 低。一次性或手动维护。 |
| `mac_apps.sync` | `ai2nao apps sync` | `POST /api/apps/sync` | `src/software/macApps/sync.ts` | `local_inventory_sync_runs`，source=`mac_apps`。 | 高。已有 run history，适合第一批纳入。 |
| `brew.sync` | `ai2nao brew sync` | `POST /api/brew/sync` | `src/software/brew/sync.ts` | `local_inventory_sync_runs`，source=`brew`。 | 高。已有 run history，适合第一批纳入。 |
| `vscode.recent.sync` | `ai2nao vscode sync` | `POST /api/vscode/sync` | `src/vscode/sync.ts` | `vscode_sync_state` 主要用于隐私 salt；无独立 run table。 | 中。需要补统一 run history。 |
| `cursor.projects.sync` | `ai2nao cursor projects sync` | 可通过 `POST /api/vscode/sync` 传 `app: "cursor"` | `src/vscode/sync.ts` | 同 VS Code。 | 中。可作为 `vscode.recent.sync` 的参数化任务。 |
| `huggingface.models.sync` | `ai2nao huggingface sync` | `POST /api/huggingface/sync` | `src/huggingface/sync.ts` | `local_inventory_sync_runs`，source=`huggingface`。 | 高。已有 API 和 run history，但 package scripts 未暴露。 |
| `lmstudio.models.sync` | `ai2nao lmstudio sync` | `POST /api/lmstudio/sync` | `src/lmstudio/sync.ts` | `local_inventory_sync_runs`，source=`lmstudio`。 | 高。已有 API 和 run history，但 package scripts 未暴露。 |
| `atuin.directories.rebuild` | `ai2nao atuin directories rebuild` | `POST /api/atuin/directories/rebuild` | `src/atuin/directoryActivity/rebuild.ts` | `atuin_directory_activity_state`；模块内已有 in-process rebuild guard。 | 中。需要 Atuin DB 配置。 |
| `rag.ingest` | `ai2nao rag ingest` | 无 | `src/rag/ingest.ts` | `rag_files`、`rag_meta`、vector sync state。 | 中。重任务，建议 opt-in。 |
| `rag.optimize` | `ai2nao rag optimize` | 无 | `src/rag/vectorStore/*` | 依赖 vector provider。 | 低。维护型任务，默认手动。 |
| `rag.cleanup_tombstones` | `ai2nao rag cleanup-tombstones` | 无 | `src/rag/manifest.ts` | 清理 `rag_files` 中过期 deleted manifest。 | 低到中。可低频定时。 |

## Web/API 已有手动触发入口

| API | 对应任务 | 说明 |
|---|---|---|
| `POST /api/downloads/scan` | `downloads.scan` | 扫描本机下载文件夹。 |
| `POST /api/apps/sync` | `mac_apps.sync` | 同步 macOS 应用清单。 |
| `POST /api/brew/sync` | `brew.sync` | 同步 Homebrew 清单。 |
| `POST /api/vscode/sync` | `vscode.recent.sync` / `cursor.projects.sync` | 通过 body 中的 `app` 区分 `code`、`code-insiders`、`vscodium`、`cursor`。 |
| `POST /api/huggingface/sync` | `huggingface.models.sync` | 同步 Hugging Face Hub 本地 cache。 |
| `POST /api/lmstudio/sync` | `lmstudio.models.sync` | 同步 LM Studio 本地模型目录。 |
| `POST /api/chrome-history/sync` | `chrome.history.sync` | 同步 Chrome visits/downloads，并返回 domain 状态。 |
| `POST /api/chrome-downloads/sync` | `chrome.downloads.sync` | 调用同一个 `syncChromeHistory`，主要服务 Chrome downloads 页面。 |
| `POST /api/chrome-history/domains/rebuild` | `chrome.domains.rebuild` | 重建 Chrome domain pivot 派生表。 |
| `POST /api/atuin/directories/rebuild` | `atuin.directories.rebuild` | 从只读 Atuin history DB 重建目录活动派生表。 |

目前没有 Web/API 手动触发入口的重点任务：

- `github.sync.incremental`
- `github.sync.full`
- `github.tags.rebuild`
- `github.tags.alias.seed`
- `rag.ingest`
- `rag.optimize`
- `rag.cleanup_tombstones`
- `repo.scan`

## 已有状态与运行记录

| 状态/记录 | 覆盖任务 | 当前用途 | 对统一 scheduler 的启发 |
|---|---|---|---|
| `jobs` | `repo.scan` | 记录早期 manifest scan 的 kind/status/finished/error。 | 可参考，但字段过轻，不足以覆盖全部任务。 |
| `local_inventory_sync_runs` | apps、brew、huggingface、lmstudio | 记录 source、started/finished、status、insert/update/missing/warnings/error/metadata。 | 最接近统一 task run history。 |
| `local_inventory_sync_state` | 本地 inventory | 保存 inventory 状态键值。 | 可保留为 source-specific state。 |
| `gh_sync_state` | GitHub sync | 保存 full/incremental 时间、耗时、错误、水位和 in-progress 状态。 | 适合继续做 GitHub source state，但 scheduler 仍需单独 run table。 |
| `chrome_history_sync_state` | Chrome history/download sync | 保存 profile/source 的 source id、visit/download 水位、anchor。 | 适合做增量同步状态，不等价于 task run history。 |
| `chrome_history_domain_state` | Chrome domain rebuild | 保存 last_rebuilt_at、last_error、source/derived counts、duration。 | 可作为 freshness UI 输入。 |
| `vscode_sync_state` | VS Code/Cursor recent sync | 目前主要保存隐私 hash salt。 | 需要统一 run history 才能展示 last run/error。 |
| `atuin_directory_activity_state` | Atuin directory rebuild | 保存 rebuild freshness、错误、derived counts、duration。 | 已有状态不错，但仍需要 scheduler-level run。 |
| `rag_meta` / `rag_files` | RAG ingest/vector sync | 保存 manifest、vector sync 状态和 tombstone。 | RAG 可保留自己的 manifest 语义，scheduler 只记录任务运行。 |

## 第一批纳入统一 scheduler 的建议

建议第一批选择“已有业务函数、已有 API 或已有 run history、不会引入新外部依赖”的任务：

1. `downloads.scan`
2. `mac_apps.sync`
3. `brew.sync`
4. `huggingface.models.sync`
5. `lmstudio.models.sync`
6. `vscode.recent.sync`
7. `cursor.projects.sync`
8. `chrome.history.sync`
9. `chrome.domains.rebuild`
10. `atuin.directories.rebuild`

第二批再纳入网络或重任务：

1. `github.sync.incremental`
2. `github.sync.full`
3. `github.tags.rebuild`
4. `rag.ingest`
5. `rag.cleanup_tombstones`
6. `rag.optimize`
7. `repo.scan`

## 调度设计注意事项

- 不要把 scheduler 的执行内核设计成 `npm run xxx`。应该让 CLI、API、scheduler 调用同一层业务函数。
- 同一任务键必须互斥；对 Chrome History 还要按 `profile + sourcePath` 互斥。
- `watch` 命令应被视为旧的轮询包装，而不是最终 scheduler 形态。
- GitHub、RAG、Atuin 这类任务需要显式启用，避免默认访问 token、外部网络、终端历史或大规模本地语料。
- 统一 scheduler 应新增自己的 `scheduled_tasks` 和 `scheduled_task_runs`，不要强行把所有状态塞进现有 source-specific state 表。
- 任务状态 UI 至少要区分 disabled、due、running、success、partial、failed、stale。
- Chrome downloads 页面当前的 sync API 与 Chrome History 共用同一个底层同步函数，调度层不宜把它们当成两个会同时运行的独立任务。
