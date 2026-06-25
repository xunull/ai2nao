# MCP 记忆器官（ai2nao MCP server）

把 ai2nao 暴露成一个本地 **MCP（Model Context Protocol）server**，让 Claude Code / Codex 这类 agent 在写代码的当下**直接查询你的开发数据**——token 用量、活跃工时、外部平台额度等。ai2nao 从「你打开网页去看的看板」升维成「你的 AI 工具共享的记忆层」。

- 传输：**HTTP（Streamable HTTP）**，挂在现有 `serve` 进程上，路径 `/mcp`，仅监听 `127.0.0.1`。
- 只读：用独立的只读 SQLite 句柄打开 index DB，任何 tool 都改不了库。
- 数据全程留在本机；任何 tool 输出都不含 API key。

---

## 快速上手（How-to）

### 前置

- 已 `npm run build`，并能正常启动 `serve`。
- 安装了 Claude Code CLI（`claude`）。

### 1. 启动 serve

```bash
node dist/cli.js serve            # 默认 http://127.0.0.1:8787
```

`serve` 跑着时，`/mcp` 就已经在了。`serve` 没起时，下面的注册仍能加，但调用会连接失败（属预期）。

### 2. 在 Claude Code 里注册一次

```bash
claude mcp add --transport http ai2nao http://127.0.0.1:8787/mcp
```

> 端口跟着 `serve --port` 走；改了端口，URL 也要同步改。

### 3. 在对话里直接问

注册后，agent 会自动发现这三个 tool，你用自然语言问即可：

- 「这个 repo 这周烧了多少 token？」→ agent 调 `project_tokens`
- 「我最近在哪个项目花的时间最多？」→ agent 调 `time_spent`
- 「我外部平台（MiniMax）还剩多少额度？」→ agent 调 `external_usage`

### 验证

```bash
claude mcp list            # 应能看到 ai2nao
```

或在对话里让 agent「列出 ai2nao 的 tool」，应返回 `project_tokens` / `time_spent` / `external_usage` 三个。

---

## 架构与数据流（Explanation）

```
Claude Code / Codex
      │  MCP over HTTP（127.0.0.1:8787/mcp，带 Mcp-Session-Id）
      ▼
Hono 路由  app.all("/mcp", c => handler(c.req.raw))   ──>  Promise<Response>
      │   （WebStandardStreamableHTTPServerTransport，fetch 原生，自管 session）
      ▼
McpServer（注册 3 个 tool）
      │   tool 调用：zod 校验入参 → project 归一匹配 → 字段裁剪/MAX_ITEMS 截断
      ▼
现有只读 SELECT 查询（独立 openReadOnlyDatabase 句柄）──> JSON ──> 返回 agent
```

几个关键设计：

- **transport = WebStandard。** 用 MCP SDK 自带的 `WebStandardStreamableHTTPServerTransport`，它吃 Web `Request`、返回 `Response`，正是 Hono 原生模型，所以路由就一行 `c => handler(c.req.raw)`，不需要裸 Node req/res 桥接。
- **条件挂载。** 只有 `serve` 用 `openReadOnlyDatabase(dbPath)` 开了独立只读句柄并传进 `createApp({ mcpDb })` 时，`/mcp` 才注册；否则该路径不存在（返回 404）。这保证测试/库调用方不受影响。
- **只读强制。** MCP 用的句柄与 `serve` 写库用的句柄是两个；MCP 这个是 `openReadOnlyDatabase`，SQLite 层就拒绝写。

---

## Tool 参考（Reference）

server 标识：`{ name: "ai2nao", version: "0.1.0" }`。所有 tool 均为只读、同步 SELECT。

### `project_tokens`

各项目的 Claude Code token 用量。

**入参**

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `project` | string | 否 | repo 名或路径的子串（大小写不敏感包含匹配）；省略则返回全部 |
| `since` | string | 否 | ISO 日期；只统计该时间之后更新的 session |

**返回**

- 不带 `project`：`{ items: ProjectTokens[], total, truncated }`
- 带 `project` 且命中：`{ found: true, items, total, truncated }`
- 带 `project` 未命中：`{ found: false, candidates: string[] }`（candidates 为前若干个 `projectKey`，供 agent 自我纠正）

`ProjectTokens` 字段：`projectKey`、`projectPath`、`inputTokens`、`outputTokens`、`totalTokens`、`coveredSessions`、`totalSessions`、`errorSessions`、`coverage`（`full` / `partial` / `unknown`）。

### `time_spent`

各项目的诚实活跃工时（去重后的活跃时长，非墙钟时间）。

**入参**：同 `project_tokens`（`project?`、`since?`）。

**返回**：结构同上（`{items,total,truncated}` 或 `{found:false,candidates}`）。

`ProjectDuration` 字段：`projectKey`、`projectPath`、`activeMs`（活跃毫秒）、`wallMs`（墙钟毫秒）、`knownSessions`、`totalSessions`、`errorSessions`、`coverage`。

### `external_usage`

外部 AI 平台（如 MiniMax）的剩余额度快照。**不返回 API key。**

**入参**：无。

**返回**：`{ items: ProviderView[], total, truncated }`。

`ProviderView` 字段：`id`、`label`、`enabled`、`hasKey`（布尔，**不含 key 本身**）、`lastSyncAt`、`lastStatus`、`lastError`、`items[]`（每项 `key` / `label` / `remainingPercent` / `resetAt` / `detail` / `syncedAt`）。

---

## 通用约定

- **payload 控制。** 每个列表返回都被截断到 `MAX_ITEMS = 50` 条，并带 `truncated: true/false` 标志，避免把大结果整块灌进 agent 上下文烧 token。
- **project 匹配。** `project` 入参对每个项目的 `projectKey` / `projectPath` 做大小写不敏感**包含**匹配；查不到返回 `{ found: false, candidates }` 而非空，方便 agent 换个写法重试。
- **入参校验。** 每个 tool 用 zod 定义入参 schema，坏入参由 SDK 拒绝。

---

## 安全与边界

- **只监听 `127.0.0.1`。** 与现有 `/api/*` 同信任边界，不对外暴露；首版无鉴权（本机任何进程可访问，与现有 API 一致）。**不要**把 MCP 暴露到 `0.0.0.0`。
- **只读。** 独立 `openReadOnlyDatabase` 句柄，tool 路径尝试写库会抛错（有测试覆盖）。
- **不泄密。** `external_usage` 只返回 `hasKey` 布尔，绝不返回 API key 本身。
- **serve 未起 = 连接失败。** 这是预期行为，不是 bug。

---

## 故障排查

| 现象 | 原因 / 处理 |
|------|------------|
| `claude` 调用 ai2nao 连接失败 | `serve` 没在跑，或端口与注册 URL 不一致。先 `node dist/cli.js serve`，确认终端打印的端口 |
| `/mcp` 返回 404 | 该实例没传只读句柄（例如不是通过 `serve` 启动）。MCP 只在 `serve` 下挂载 |
| `project_tokens` 返回 `{found:false}` | 传的 `project` 没匹配到任何 `projectKey`/`projectPath`。看返回的 `candidates` 换个子串重试，或先 `serve` 打开 `/dashboard/tokens` 确认项目名 |
| token/工时数为空 | token 落库依赖定时任务 `work.tokens.refresh`（默认每小时）。可在 `/scheduler` 手动 Run now |

---

## 路线图（v2，尚未实现）

首版只上 3 个稳定的同步 SELECT tool。以下延后到 v2（见仓库 `TODOS.md` 第 32 项）：

- `search_history` — 语义/文本搜过去会话（「我上次怎么解决 X」）。依赖 session memory 服务装配。
- `project_overview` — 某 repo 的 token/时间/session 快照。底层 `buildWorkDashboard` 读文件系统、慢，需配超时/降级/缓存。
- 按项目的 **USD 成本**（现成函数只给全局/分桶成本）。

---

## 实现位置

| 文件 | 作用 |
|------|------|
| `src/mcp/server.ts` | `createMcpHandler(db)`：WebStandard transport + session 管理，返回 `(Request)=>Promise<Response>` |
| `src/mcp/tools.ts` | 3 个 tool 的 zod schema + 薄包装现有 query + payload 截断 |
| `src/serve/app.ts` | `ServeOptions.mcpDb` 可选；传了才注册 `/mcp` 路由 |
| `src/serve/runServe.ts` | 把只读句柄传进 `createApp`，并在 `close()` 里关掉它 |
| `src/cli.ts`（`serve` 命令） | 用 `openReadOnlyDatabase(dbPath)` 开独立只读句柄 |
| `test/mcp.routes.test.ts` | 集成往返 + 无 dbPath 时 404 + 只读写抛错 + `{found:false}` 契约 |
