# Scheduler 设计

本文记录 ai2nao V1 统一定时任务系统的实现边界。

## 范围

V1 是内置在 `serve` 进程中的本地 SQLite scheduler。它负责注册任务、保存调度配置、记录运行历史、提供 API 和 Web 控制台。它不负责后台 daemon、开机自启、分布式队列或 cron 表达式。

V1 支持的任务：

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

默认策略：所有任务注册后默认关闭，不会随 `serve` 启动自动扫描本机敏感数据。用户可以在 `/scheduler` 手动运行任务，或逐个启用 interval 调度。

## 数据模型

Scheduler 使用两张统一表：

- `scheduled_tasks`：保存任务是否启用、interval、next run、lease 和 config。
- `scheduled_task_runs`：保存每次运行的 trigger、开始/结束时间、状态、摘要和错误。

模块自己的状态表仍然保留。例如 Chrome History 继续使用 `chrome_history_sync_state` 保存增量水位，local inventory 继续使用 `local_inventory_sync_runs` 保存 source-specific 运行摘要。Scheduler 表只回答“任务何时运行、是否被锁、最近跑得怎么样”。

## 执行路径

Scheduler 不 shell out 到 `npm run`，也不通过 HTTP 回环调用本机 API。CLI、API 和 scheduler 都应该调用同一层业务函数。

```text
CLI command ─┐
API route   ├─ sync service/function
Scheduler ──┘
```

`src/scheduler/taskDefinitions.ts` 是任务注册表来源。每个任务定义包含 key、label、category、默认 interval、敏感度和 `run(ctx)`。

## 运行生命周期

`runServe` 会创建 `SchedulerRuntime` 和 `SchedulerLoop`，并在服务关闭时停止 loop。`createApp` 只在显式传入 `schedulerRuntime` 时注册 scheduler API；这避免只读 API 测试或只读 DB 打开时写入任务注册数据。

CLI 入口：

```bash
ai2nao scheduler status
ai2nao scheduler run downloads.scan
```

Web/API 入口：

```text
GET   /api/scheduler/tasks
PATCH /api/scheduler/tasks/:taskKey
POST  /api/scheduler/tasks/:taskKey/run
GET   /api/scheduler/runs?taskKey=&limit=
```

## 锁策略

V1 使用两层锁：

- 进程内 `runningTaskKeys`：避免同一 `serve` 进程重复启动同一任务。
- SQLite lease：`scheduled_tasks.lease_owner` + `lease_until`，用于挡住 CLI run-once 和 `serve` 自动 tick 的跨进程并发。

任务执行前先 acquire lease，执行结束后释放 lease。过期 lease 可以被新的 owner 抢占。

## UI

`/scheduler` 是 PC 桌面控制台页面。页面展示任务列表、启用状态、interval、next run、last run、状态、Run 按钮和最近运行历史。

V1 不做移动端适配，也不做 cron 编辑器。interval 以预设选项提供，避免首版 UI 和测试复杂化。
