# VS Code `state.vscdb` 可用数据分析

本文档记录 VS Code 全局状态库 `state.vscdb` 中哪些数据适合被 ai2nao 使用，哪些数据只能在用户明确开启后使用，哪些数据应默认跳过。

> **重要说明**
> - 以下内容来自对 macOS 本机 VS Code 实际落盘行为的结构探测。
> - VS Code 升级、插件升级、Code Insiders / VSCodium / Cursor 等变体都可能改变 key 名或 JSON 形状。
> - 读取时应复制数据库快照后只读打开，避免与正在运行的 VS Code 争抢写入。
> - 不要默认展开或存储 `secret://...`、账号认证、终端命令正文、AI 插件原始状态等高敏内容。

---

## 1. 文件位置与表结构

macOS 默认路径：

```text
~/Library/Application Support/Code/User/globalStorage/state.vscdb
```

该文件是 SQLite 数据库，核心表为：

```sql
SELECT key, value FROM ItemTable;
```

本机探测时 `ItemTable` 有 331 个 key。真正适合产品化使用的 key 只占一小部分。

## 2. 最值得使用的数据

### 2.1 `history.recentlyOpenedPathsList`

**优先级：v1 必做**

这是 VS Code 「Open Recent」的主数据源，价值最高。

用途：

- 最近打开的文件夹
- 最近打开的文件
- 最近打开的 `.code-workspace`
- 远程 workspace 标记
- 与 ai2nao 已索引 repo 做关联
- 为每日摘要补充「最近在哪些工程里工作」

读取示例：

```sql
SELECT value
FROM ItemTable
WHERE key = 'history.recentlyOpenedPathsList';
```

本机探测到的结构特征：

| 项 | 数量 / 字段 |
|----|-------------|
| entries | 563 |
| folder entries | 470 |
| file entries | 89 |
| workspace entries | 4 |
| remote authority entries | 69 |
| 常见字段 | `folderUri`、`fileUri`、`workspace`、`remoteAuthority`、`label` |

建议落库字段：

| 字段 | 说明 |
|------|------|
| `kind` | `folder` / `file` / `workspace` |
| `uri` | 原始 URI，作为稳定去重键 |
| `path` | 仅对 `file://` URI 解码为本机路径 |
| `label` | 原始 label 或从路径 basename 推导 |
| `remote_authority_hash` | 远程主机建议默认只存 hash |
| `exists_on_disk` | 本机路径是否仍存在 |
| `first_seen_at` / `last_seen_at` / `missing_since` | 当前快照 + 历史可见模型 |

隐私注意：

- `remoteAuthority` 可能包含主机名、用户名或内部机器名。
- UI 默认展示前应考虑脱敏，数据库可优先存 hash。

### 2.2 `terminal.history.entries.dirs`

**优先级：v1.1，可选开关**

记录 VS Code terminal 曾经进入过的目录。它比命令正文安全一些，但仍可能暴露项目路径、客户名、服务器挂载路径。

用途：

- 补全「最近工作目录」
- 与 git repo 扫描结果做关联
- 与 Atuin shell history 互相校验
- 发现用户经常在 VS Code terminal 中工作的路径

建议策略：

- 默认关闭。
- 开启后只存规范化路径、repo 关联结果、计数和最近出现时间。
- 不需要在 v1 存 raw JSON。

### 2.3 `commandPalette.mru.cache` / `commandPalette.mru.counter`

**优先级：phase 2，聚合使用**

记录命令面板最近/常用命令。它适合做行为画像，不适合原样展示。

用途：

- 判断用户是否高频使用 Git、Debug、Remote、Test、Extensions 等能力。
- 为未来「开发习惯回看」提供弱信号。

建议策略：

- 只做命令 id 聚合和分类。
- 不存完整 raw value。
- 不阻塞 VS Code recent list v1。

### 2.4 `snippets.usageTimestamps`

**优先级：phase 2，小功能**

记录 snippets 使用时间戳。价值较小，但隐私风险相对低。

用途：

- 判断用户是否依赖 snippet 工作流。
- 作为编辑器使用习惯的一部分。

建议策略：

- 仅存 snippet 标识、使用次数、最近使用时间。
- 不作为首版范围。

## 3. 有价值但必须谨慎的数据

### 3.1 `terminal.history.entries.commands`

**优先级：v2，必须显式 opt-in**

这是高价值数据，也是不应默认抓的数据。

用途：

- 识别 VS Code 内执行过的开发动作。
- 补强每日摘要，比如测试、构建、部署、脚本运行。
- 与 Atuin 命令历史合并，形成更完整的工作流回放。

风险：

- 可能包含 token、cookie、内网地址、部署命令、客户名。
- 可能包含 destructive 命令、临时密码或 API key。

建议策略：

- 必须有显式开关。
- 默认只存脱敏后的命令类别，例如 `npm test`、`git commit`、`docker compose`。
- 原始命令正文不应默认落库。
- 若未来存 raw command，应提供一键清空和可见隐私提示。

### 3.2 `workbench.editor.languageDetectionOpenedLanguages.global`

**优先级：低**

可推断用户打开过哪些语言的文件。

用途：

- 编程语言偏好画像。
- 与 repo manifest 推断互补。

风险与限制：

- 价值低于 repo/package.json 扫描。
- 不应为它增加复杂 schema。

### 3.3 `chat.currentLanguageModel.*` / `chat.lastChatMode` / `chat.modelsControl`

**优先级：低，暂不做**

可推断 VS Code 内 Chat 面板的模型和模式偏好。

用途：

- AI 开发工具使用画像。
- 未来合并 Copilot / Claude Code / OpenAI 插件使用状态。

风险：

- 容易和插件私有状态混在一起。
- 字段语义依赖 VS Code 和插件版本。

建议策略：

- 暂不接入。
- 若要做，只存「是否使用过某类内置 chat 能力」这种低敏聚合。

### 3.4 `remote.tunnels.toRestore.*`

**优先级：低，默认跳过**

记录 remote tunnel / WSL 相关恢复状态。

用途：

- 判断用户是否使用远程开发。
- 辅助关联 remote workspace。

风险：

- key 中可能直接出现远程主机别名、WSL distro、内部环境名。

建议策略：

- 默认不抓。
- 若未来接入，只存 remote 类型和 hash，不存原始主机名。

### 3.5 Extension global state

代表 key：

- `ms-vscode-remote.remote-ssh`
- `eamodio.gitlens`
- `GitHub.copilot-chat`
- `openai.chatgpt`
- `Anthropic.claude-code`
- `ms-python.python`
- `vscode.github`

用途：

- 判断扩展是否安装、是否使用过、是否有某类工作流。

风险：

- 插件状态格式不稳定。
- 可能混入账号、仓库、远程主机、AI 会话、认证状态。
- 维护成本高，产品价值不稳定。

建议策略：

- 不从 `state.vscdb` 默认抓 extension state。
- VS Code 扩展清单应优先从扩展目录或官方 metadata 文件读取。
- 只在单独设计中接入特定扩展。

## 4. 默认不要抓的数据

### 4.1 Secret 与认证

代表 key：

```text
secret://{"extensionId":"vscode.github-authentication","key":"github.auth"}
secret://{"extensionId":"vscode.microsoft-authentication","key":"publicClientApplications-AzureCloud"}
secret://{"extensionId":"ms-toolsai.jupyter","key":"ms-toolsai.jupyter.user-jupyter-server-uri-list-version2"}
```

策略：

- 永远默认跳过。
- 不展示。
- 不计数也可以，避免给用户造成「我们读取了认证状态」的误解。

### 4.2 Telemetry / Sync / Machine IDs

代表 key：

- `storage.serviceMachineId`
- `sync.machine-session-id`
- `sync.user-session-id`
- `sync.sessionId`
- `telemetry.*`
- `globalState.lastSyncUserData`
- `settings.lastSyncUserData`
- `keybindings.lastSyncUserData`

策略：

- 默认跳过。
- 这些对 ai2nao 的回看和摘要价值很低。

### 4.3 UI 布局与主题

代表 key：

- `iconThemeData`
- `colorThemeData`
- `workbench.statusbar.hidden`
- `workbench.activity.*`
- `workbench.panel.*`
- `workbench.view.*`
- `workbench.welcomePage.*`
- `memento/gettingStartedService`

策略：

- 默认跳过。
- 数据量大，但用户价值低。

### 4.4 实验与推荐

代表 key：

- `experiments.*`
- `extensionsAssistant/recommendations`
- `extensionTips/*`
- `fileBasedRecommendations/*`

策略：

- 默认跳过。
- 这是 VS Code / 扩展内部推荐状态，不是用户工作证据。

## 5. 推荐接入顺序

### v1：recent entries

只接入：

```text
history.recentlyOpenedPathsList
```

目标：

- CLI：`ai2nao vscode sync`
- API：`GET /api/vscode/recent`
- Web：`/vscode`
- 只读、快照、幂等同步。

### v1.1：terminal dirs

可选接入：

```text
terminal.history.entries.dirs
```

目标：

- 建立 VS Code terminal 常用目录与 repo 的关联。
- 默认关闭或通过明确参数开启。

### v2：terminal commands

显式 opt-in 接入：

```text
terminal.history.entries.commands
```

目标：

- 为每日摘要补充 VS Code terminal 命令动作。
- 默认只存脱敏分类和统计。

### phase 2+：行为画像

可考虑：

```text
commandPalette.mru.cache
commandPalette.mru.counter
snippets.usageTimestamps
workbench.editor.languageDetectionOpenedLanguages.global
```

目标：

- 开发习惯画像。
- 不阻塞本机 recent list 主功能。

## 6. 实现注意事项

### 6.1 只读快照

不要直接写或长时间持有 VS Code 的 `state.vscdb`。

建议流程：

1. 复制 `state.vscdb` 到临时文件。
2. 用 `better-sqlite3` 只读打开临时文件。
3. 读取目标 key。
4. 关闭数据库并删除临时文件。

### 6.2 key 白名单

实现上应使用白名单读取，而不是遍历后批量入库。

推荐白名单：

```ts
const SAFE_VSCODE_KEYS = [
  "history.recentlyOpenedPathsList",
];
```

后续新增 key 必须经过单独评审。

### 6.3 URI 处理

recent entries 中可能出现：

- `file:///Users/...`
- `vscode-remote://ssh-remote+...`
- workspace object

处理原则：

- `file://` 解码为本机路径。
- remote URI 不做路径存在性检查。
- remote authority 默认脱敏。
- 原始 `uri` 可作为唯一键，但 UI 展示应更谨慎。

### 6.4 不存 raw extension state

`state.vscdb` 里很多 key 是扩展自己的 globalState。不要为了“以后可能有用”直接保存 raw value。

这会把 ai2nao 从本机活动索引变成插件隐私数据吸尘器。没必要，也不好维护。

## 7. 结论

`state.vscdb` 最有价值的是 VS Code recent list。它直接回答「最近打开过哪些项目、文件、workspace」，和 ai2nao 的本机工作回看方向高度一致。

第二价值层是 VS Code terminal 的目录与命令历史。但命令正文非常敏感，必须 opt-in 和脱敏。

其他大部分 key 是 UI 状态、扩展私有状态、认证状态、实验状态。它们不该进入首版。先把 `history.recentlyOpenedPathsList` 做好，才是正确的 v1。
