# Cursor 本地对话存储说明

本文档说明 **如何从 Cursor 在本机的 SQLite 数据库中读取 AI 对话内容**：涉及哪些文件、哪些表与键、JSON 字段含义、以及会话如何与「某个项目 / 工作区」对应。

> **重要说明**  
> - 以下内容来自对 Cursor 实际落盘行为的**逆向归纳**，并与本仓库 `src/cursorHistory/` 中的读取逻辑一致。  
> - Cursor 升级后键名、表结构或 JSON 形状**可能变化**；若与你的版本不一致，请以本机 DB 为准并对比源码。  
> - 读取时请使用**只读**打开数据库，避免与正在运行的 Cursor 争抢写入（常见错误：`SQLITE_BUSY`）。

---

## 1. 总体架构：两类目录、两个 `state.vscdb`

Cursor 基于 VS Code 体系，把状态放在用户目录下。与聊天相关的数据主要分布在：

| 角色 | 典型路径（macOS） | 典型路径（Windows） | 典型路径（Linux） |
|------|------------------|---------------------|-------------------|
| **按工作区** | `~/Library/Application Support/Cursor/User/workspaceStorage/` | `%APPDATA%\Cursor\User\workspaceStorage\` | `~/.config/Cursor/User/workspaceStorage/` |
| **全局** | `~/Library/Application Support/Cursor/User/globalStorage/` | `%APPDATA%\Cursor\User\globalStorage\` | `~/.config/Cursor/User/globalStorage/` |

每一类目录下，真正承载键值的是同名文件 **`state.vscdb`**（SQLite）。

### 1.1 为什么需要两个库？

- **`workspaceStorage/<哈希>/state.vscdb`**  
  - 存放与**该工作区窗口**相关的状态。  
  - 对话的**会话列表元数据**（尤其是新版 `composer.composerData`）通常从这里可读。  
  - 同目录下的 **`workspace.json`** 把「这个哈希文件夹」映射回**磁盘上的项目路径**或 **`.code-workspace` 文件**。

- **`globalStorage/state.vscdb`**  
  - Cursor 扩展使用的 **`cursorDiskKV`** 表在这里（若存在）。  
  - **单条气泡（bubble）级别的完整内容**、以及 **`composerData:<composerId>`** 的会话级 JSON，通常在这里。  
  - 本仓库在拉取**完整助手回复**时**优先读全局库**；读不到时再回退到工作区库里的 JSON（可能不完整），对应代码里的 `source: 'global' | 'workspace-fallback'`。

### 1.2 自定义数据根目录

若设置了环境变量 **`CURSOR_DATA_PATH`**，则 **`workspaceStorage` 的根**以此为准（本仓库 `getCursorDataPath()`：自定义参数 > 环境变量 > 系统默认）。  
全局库路径**不**随 `CURSOR_DATA_PATH` 改变，仍按操作系统默认的 `.../Cursor/User/globalStorage`。

---

## 2. SQLite 文件与标准表：`ItemTable`

两个 `state.vscdb` 都是标准 SQLite 文件。VS Code 系应用普遍使用：

### 2.1 `ItemTable`

用于存储字符串键值，本仓库访问方式为：

```sql
SELECT value FROM ItemTable WHERE key = ?;
```

常见列含义（与 VS Code 一致，具体以 `PRAGMA table_info(ItemTable);` 为准）：

| 列名 | 含义 |
|------|------|
| `key` | 逻辑键名（TEXT，主键或唯一） |
| `value` | 键对应内容（TEXT，多为 JSON 字符串） |

Cursor 的对话「索引」侧数据主要通过 **`ItemTable`** 的几类 `key` 读出（见第 4 节）。

---

## 3. 全局库扩展表：`cursorDiskKV`

在 **`globalStorage/state.vscdb`** 中，Cursor 可能创建 **`cursorDiskKV`**（若不存在则说明当前环境未使用此通路或版本不同）。

本仓库使用方式：

```sql
SELECT name FROM sqlite_master WHERE type='table' AND name='cursorDiskKV';
SELECT key, value FROM cursorDiskKV WHERE key LIKE ? ORDER BY rowid ASC;
```

### 3.1 行结构（逻辑上）

| 列名 | 含义 |
|------|------|
| `key` | 分层命名空间 + id，见下文 |
| `value` | 多为 **JSON 字符串**，描述一条 bubble 或一份 composer 会话配置 |

### 3.2 `key` 命名约定（本仓库依赖的）

| 前缀模式 | 含义 |
|----------|------|
| `composerData:<composerId>` | **一个 Composer 会话**对应一条记录。`<composerId>` 为 UUID 风格字符串，与工作区 `composer.composerData` 里 `allComposers[].composerId` 一致。 |
| `bubbleId:<composerId>:<suffix>` | 属于该 `composerId` 的**一条气泡**。`<suffix>` 为第三段（实现里用 `rowid` 排序保证顺序）；**消息顺序**按 `ORDER BY rowid ASC` 与 `listGlobalSessions` / `getSession` 一致。 |

从 `bubbleId:...` 的 `key` 解析末尾段可作为兜底 id：`key.split(':').pop()`（见 `getBubbleRowId`）。

---

## 4. `ItemTable` 中与聊天相关的键

本仓库按**优先级**依次尝试下列键（`CHAT_DATA_KEYS`），**命中第一个非空 `value` 即停止**：

| 优先级 | `key` | 用途简述 |
|--------|-------|----------|
| 1 | `composer.composerData` | **新版**：JSON 内含 `allComposers` 数组，列出各 Composer 会话头信息。 |
| 2 | `workbench.panel.aichat.view.aichat.chatdata` | **旧版 / 兼容** |
| 3 | `workbench.panel.chat.view.chat.chatdata` | **旧版 / 兼容** |

另有两项**辅助**键（在已拿到主聊天 JSON 后额外读取，用于新版解析补充）：

| `key` | 用途 |
|-------|------|
| `aiService.prompts` | 提示相关（本仓库解析链中主要使用 generations 做时间关联） |
| `aiService.generations` | 生成记录数组；`parseComposerFormat` 中按 `unixMs` 与 composer 时间窗尝试配对 |

---

## 5. 新版：`composer.composerData` 的 JSON 形状

当 `ItemTable` 中主数据解析后为**带 `allComposers` 的对象**时，走新版 Composer 路径（`parseComposerFormat`）。

### 5.1 顶层

```json
{
  "allComposers": [ /* ComposerHead */ ],
  "selectedComposerIds": [ "..." ]
}
```

### 5.2 `allComposers[]` 常用字段（`ComposerHead`）

| 字段 | 类型 | 含义 |
|------|------|------|
| `composerId` | string | **会话唯一 id**，与全局 `composerData:<id>`、`bubbleId:<id>:*` 对齐。**无此字段则该条会被跳过。** |
| `name` | string | 会话标题 / 展示名 |
| `createdAt` | number | 创建时间（毫秒时间戳，具体语义以 Cursor 为准） |
| `lastUpdatedAt` | number | 最后更新时间 |
| `type` | string | 内部类型（可选） |
| `unifiedMode` | string | 统一模式标记（可选） |

### 5.3 与 `generations` 的弱关联

`aiService.generations` 解析为数组后，元素大致包含：

| 字段 | 含义 |
|------|------|
| `unixMs` | 时间戳 |
| `generationUUID` | 生成 id |
| `type` | 类型 |
| `textDescription` | 描述文本（解析时当作用户侧提示文本展示用） |

解析逻辑会按 composer 的 `createdAt`～`lastUpdatedAt` 时间窗，把落在窗口内（外加一分钟容差）的 generation 归到该会话，用于**在没有 bubble 明细时的占位展示**。**完整对话仍以全局 `cursorDiskKV` 的 bubble 为准。**

---

## 6. 旧版：`chatdata` 类键的 JSON 形状

当顶层为**带 `chatSessions` 或 `tabs`** 的对象时，走旧版路径。

### 6.1 顶层

```json
{
  "version": 0,
  "chatSessions": [ /* RawChatSession */ ],
  "tabs": [ /* 部分版本把会话放在 tabs */ ]
}
```

### 6.2 单会话 `RawChatSession`

| 字段 | 含义 |
|------|------|
| `id` | 会话 id（**必填**，否则该会话丢弃） |
| `title` | 标题 |
| `createdAt` / `lastUpdatedAt` / `lastSendTime` | 时间相关（毫秒） |
| `messages` 或 `bubbles` | 消息数组（不同版本键名不同） |

### 6.3 单条消息 `RawMessage`

| 字段 | 含义 |
|------|------|
| `role` 或 `type` | `user` / `ai` 等 |
| `content` 或 `text` | 正文 |
| `timestamp` 或 `createdAt` | 时间 |

---

## 7. 全局 `cursorDiskKV`：`composerData` 行（会话级）

`key = composerData:<composerId>` 的 `value` 为 JSON。本仓库显式或隐式使用到的字段包括：

| 字段 | 含义 |
|------|------|
| `name` / `title` | 会话名称 |
| `createdAt` / `updatedAt` | 时间（字符串或可被 `Date` 解析的格式，以实际数据为准） |
| `workspaceUri` | **关联工作区**：多为 `file:///...`；列表全局会话时用于展示「属于哪个文件夹」；会去掉 `file://` 并对 `%20` 做解码 |
| `contextTokensUsed` / `contextTokenLimit` / `contextUsagePercent` | 上下文用量相关（会话级汇总辅助） |
| `fullConversationHeadersOnly` | **数组**：描述当前分支上气泡的**头信息**，用于恢复顺序与分支感知 |

### 7.1 `fullConversationHeadersOnly` 元素

每项一般为对象，本仓库读取：

| 字段 | 含义 |
|------|------|
| `bubbleId` | 气泡 id，与 `bubbleId:<composerId>:<x>` 中的业务 id 对应 |
| `type` | 数字类型码（可选） |
| `serverBubbleId` | 服务端 id（可选） |

---

## 8. 全局 `cursorDiskKV`：`bubbleId` 行（消息级）

`key` 匹配 `bubbleId:<composerId>:%` 的每一行，`value` 为 **JSON 对象**，表示一条对话气泡。本仓库映射为内部 `Message` 时核心逻辑在 `mapBubbleToMessage` + `extractBubbleText`。

### 8.1 角色：`type` 与 `role`

| `type`（数字） | 本仓库映射 |
|----------------|------------|
| `2` | `assistant` |
| 其他或未定义 | `user`（缺省按用户处理） |

### 8.2 正文抽取（`extractBubbleText`）依赖的字段

下列字段名在实现中有**明确优先级与组合规则**（此处只列要点，细节以源码为准）：

| 字段 / 路径 | 含义 |
|-------------|------|
| `toolFormerData` | 工具调用：含 `name`、`params`、`rawArgs`、`result`、`status`、`additionalData` 等；会格式化成可读文本（如读文件、终端命令等） |
| `codeBlocks[]` | 代码块数组；元素常含 `content`、`languageId`；助手侧会与 `text` **拼接** |
| `text` | 助手自然语言正文的主要字段 |
| `thinking.text` / `thinking.signature` | 推理文本；本仓库单独抽出为 `thinking` 字段 |
| `content`、`finalText`、`message`、`markdown`、`textDescription` 等 | 用户或其它结构下的备选文本字段 |
| 嵌套 JSON / diff | `text` 或 tool 结果中可能是 JSON 字符串，内含 `diff` 等，会格式化为 diff 展示 |

### 8.3 Token / 模型 / 耗时（辅助字段）

实现中还读取（用于元数据展示或汇总）：

| 路径 | 含义 |
|------|------|
| `tokenCount.inputTokens` / `outputTokens` | token 计数（camelCase） |
| `usage.input_tokens` / `output_tokens` | token 计数（snake_case 备选） |
| `contextWindowStatusAtCreation` | 上下文窗口状态 |
| `promptDryRunInfo` | 客户端估算类 JSON 字符串 |
| `modelInfo.modelName` | 模型名 |
| `timingInfo.clientStartTime` / `clientEndTime` 等 | 计时；用于推算 `durationMs` |

---

## 9. 如何把数据关联到「某个项目」

Cursor 侧「项目」对应 **VS Code 工作区**：单文件夹或 `.code-workspace` 文件。

### 9.1 工作区存储目录 → 磁盘路径：`workspace.json`

路径模板：

```text
<workspaceStorage>/<随机哈希>/workspace.json
<workspaceStorage>/<随机哈希>/state.vscdb
```

`workspace.json` 本仓库解析字段：

| JSON 字段 | 含义 |
|-----------|------|
| `folder` | 单文件夹工作区，值常为 `file:///path/to/project` |
| `workspace` | 多根目录工作区，值常为 `file:///path/to/foo.code-workspace` |

解析规则：**优先 `workspace`**，否则 **`folder`**；再将 `file://` URI 转为本地路径（`readWorkspaceJson` / `workspaceUriToPath`）。

因此：

- **`workspaceStorage` 下的子目录名（哈希）** = 稳定 id（本仓库 `Workspace.id`）；  
- **`workspace.json` 解析出的路径** = 人类可读的项目路径（本仓库 `Workspace.path` / 会话摘要上的 `workspacePath`）。

### 9.2 会话与项目的两种关联方式

1. **列表 / 索引阶段（工作区 DB）**  
   - 从**该工作区**的 `state.vscdb` → `ItemTable` 读出 `composer.composerData`（或旧版 chatdata），得到 `composerId` 列表。  
   - 该列表所在目录已通过 `workspace.json` 绑定到**你的项目路径**，因此会话在 UI 上可以带 `workspacePath` 展示。

2. **全局 DB 中的显式 URI**  
   - `composerData:<id>` JSON 里的 **`workspaceUri`** 也可指向 `file:///...`，全局列表会话时用于显示「该 composer 属于哪个目录」（可能为 `Global` 占位，视数据而定）。

### 9.3 跨工作区去重与会话列表合并

同一 `composerId` 可能在多个 `workspaceStorage` 副本中出现。本仓库 **`listSessions` 按 `composerId` 去重**（遍历工作区时使用 `seenIds`），并采用**确定性工作区排序**后保留**首次**出现的工作区归属，保证顺序稳定。

此外，**`listSessions` 会合并 `globalStorage` 中 `listGlobalSessions()` 的结果**：仅出现在全局 `cursorDiskKV`（有 `composerData:` + `bubbleId:`）、而工作区 `ItemTable` 里 `composer.composerData` 为空或未包含该会话时，过去会整段丢失；合并后这类会话也会出现在列表里。同一 `composerId` 若工作区与全局都有，**以工作区条目的路径归属为准**。

**`findWorkspaces`** 除「工作区 DB 里 `parseChatData` 会话数 > 0」的目录外，还会根据全局会话里的 **`workspaceUri` 解析出的路径**，把尚未被计入、但磁盘上存在对应 `workspaceStorage/<哈希>/workspace.json` 的文件夹补进列表（`sessionCount` 取该路径在全局侧的会话数），避免「有对话但下拉里没有项目」。

---

## 10. 推荐阅读顺序（SQL + JSON）

若你要手工排查本机数据，建议顺序：

1. 在 **`globalStorage/state.vscdb`** 中确认是否存在 **`cursorDiskKV`**。  
2. 执行：  
   `SELECT key FROM cursorDiskKV WHERE key LIKE 'composerData:%' LIMIT 20;`  
   任选一行的 `composerId`。  
3. 执行：  
   `SELECT key, length(value) FROM cursorDiskKV WHERE key LIKE 'bubbleId:<composerId>:%' ORDER BY rowid ASC LIMIT 5;`  
4. 在**对应工作区**的 **`workspaceStorage/.../state.vscdb`** 中查：  
   `SELECT value FROM ItemTable WHERE key = 'composer.composerData';`  
   在 JSON 里查找同一 `composerId`，核对 `name`、`createdAt` 等。  
5. 读取一条 bubble 的 `value`，对照第 8 节字段理解正文结构。

---

## 11. 与本仓库实现的对应关系

| 主题 | 源码位置（约） |
|------|----------------|
| 路径解析、`CURSOR_DATA_PATH` | `src/cursorHistory/platform.ts` |
| 只读打开 DB | `src/cursorHistory/db.ts` |
| `ItemTable` 键、`cursorDiskKV` 查询、`listSessions` 合并全局、`findWorkspaces` 补全路径、`getSession` 全局优先 | `src/cursorHistory/storage.ts` |
| `composer` / 旧版 chatdata 解析 | `src/cursorHistory/parser.ts` |
| 对外类型定义 | `src/cursorHistory/types.ts` |
| HTTP / CLI 封装 | `src/serve/app.ts`、`src/cli.ts` |

调试存储层可设置环境变量 **`AI2NAO_CURSOR_HISTORY_DEBUG`**，会在控制台输出简要诊断信息（见 `debugLogStorage`）。

---

## 12. 操作注意

- **只读打开**：避免破坏 VS Code/Cursor 状态库。  
- **Cursor 运行时**：Windows/macOS 上可能出现 **`SQLITE_BUSY`**，属文件锁竞争，非逻辑错误。  
- **版本差异**：若某键缺失，可能是 Cursor 版本未写入或已迁移命名；以本机 `sqlite_master` 与 `ItemTable` 实际内容为准。

---

## 13. 为什么列表里「项目」或「会话」不全？

常见原因如下（可与第 1、9 节对照）：

1. **数据源分裂**  
   完整气泡往往在 **`globalStorage/state.vscdb` → `cursorDiskKV`**，而会话索引有时只在 **`workspaceStorage/.../ItemTable`** 里有一份拷贝。若当前 Cursor 版本**几乎只往全局写 bubble**、工作区里 **`composer.composerData` 的 `allComposers` 为空或过时**，仅扫工作区 DB 的列举逻辑就会漏掉大量会话。本仓库已通过 **`listSessions` 合并 `listGlobalSessions()`** 缓解。

2. **工作区目录被过滤**  
   `findWorkspaces` 要求存在 **`state.vscdb`** 且能读出 **`workspace.json` 中的 `folder` / `workspace`**。远程容器、仅 SSH、或路径异常时可能读不到路径，对应文件夹不会进入列表。

3. **`CURSOR_DATA_PATH` / 多用户**  
   若环境变量指向**非当前正在用的** Cursor 数据根，或你看的是**另一个系统用户**的目录，会看到「缺很多」。

4. **数据库被占用**  
   Cursor 正在运行时只读打开可能 **`SQLITE_BUSY`**，接口返回错误或空列表；可关闭 Cursor 再试。

5. **去重**  
   同一 `composerId` 在多个 `workspaceStorage` 哈希目录下重复出现时，列表里**只保留一条**（确定性规则下的首次），不会为每个哈希各显示一条。

6. **UI 条数限制**  
   Web / CLI 默认 **`limit`** 截断最近 N 条；需「列出全部」时打开 **`all`** 或调大 `limit`。

---

*文档版本与仓库 `src/cursorHistory` 实现同步维护；若仅 Cursor 客户端升级导致字段变化，欢迎通过 issue 或 PR 补充勘误。*
