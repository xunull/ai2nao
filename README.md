# ai2nao

本地优先的个人数字痕迹索引器：Git 仓库清单、macOS 应用、Homebrew 包、Hugging Face 本地模型、浏览器历史、Shell 历史（Atuin）、VS Code / Cursor 打开项目、Claude Code / Codex 对话，一站检索。

数据默认落在 `~/.ai2nao/index.db`（可用 `--db` 覆盖）。

## Showcase

### 对话宇宙 `/dashboard/cosmos`

把本地所有 AI 对话 session（Claude Code + Codex）嵌入 2D 语义空间，渲染成一张
散点图：**颜色 = 来源**（Claude 蓝 / Codex 橙），**大小 = token 量**。一眼看到
"我和 AI 一年聊过的东西在语义空间里长什么样"，一键导出 PNG。

<!-- 截图待手动补：启动 serve → 打开 /dashboard/cosmos → 点"刷新"生成散点 → 导出 PNG → 放到 docs/assets/cosmos.png 并在此处插入 ![](docs/assets/cosmos.png) -->

- embedding 复用 RAG 的 provider 配置（`~/.ai2nao/rag.json`），默认走远端服务，
  页面如实标注 embedding model。想完全 local-only 见 TODOS（本地 embedding fallback）。
- session 内容不全量上传：每个 session 只取"首条实质提问 + 末条实质回复"的原文
  节选（≤2K 字符，剥掉 CLI 控制标签 / ANSI）。数据边界详见
  [Cosmos embedding 数据边界](local-docs/2026-06-14-cosmos-embedding-data-boundary/README.md)。
- 工程细节（数据流、schema、UMAP 投影、API、Phase 2 路线）见
  [Activity Cosmos 技术文档](docs/activity-cosmos.md)。

## 要求

- Node.js **20+**
- 依赖包含原生模块 **better-sqlite3**（安装时需为当前平台编译；CI 覆盖 Linux / macOS）

## 安装与构建

```bash
npm install
npm run build
```

`package.json` 中所有 `scripts` 的用途见：[package.json scripts 说明](docs/package-scripts.md)。

开发时可直接：

```bash
npm run dev -- scan --root .
```

## 快速上手

```bash
# 1. 扫描 Git 仓库
node dist/cli.js scan --root ~/projects

# 2. 同步本地软件（可选）
node dist/cli.js apps sync       # macOS 应用
node dist/cli.js brew sync       # Homebrew 包

# 3. 启动 Web 界面
node dist/cli.js serve
```

## 命令概览

### 仓库索引

```bash
# 扫描多个根目录
node dist/cli.js scan --root ~/projects --root ~/work

# 查看统计
node dist/cli.js status

# FTS5 全文检索
node dist/cli.js search "package.json"
```

### 软件清单

```bash
# macOS 应用
node dist/cli.js apps sync        # 同步已安装应用
node dist/cli.js apps reset --yes  # 清空清单

# Homebrew
node dist/cli.js brew sync        # 同步 formula / cask
node dist/cli.js brew reset --yes # 清空清单
```

### 其他同步

```bash
# VS Code / Cursor 打开项目
node dist/cli.js vscode sync
node dist/cli.js cursor projects sync
node dist/cli.js cursor projects status

# Chrome 浏览器历史
node dist/cli.js chrome-history sync
node dist/cli.js chrome-history watch --interval 30
node dist/cli.js chrome-history domains rebuild

# Atuin 目录活动
node dist/cli.js atuin directories rebuild
node dist/cli.js atuin directories status

# GitHub 仓库 & Tags
node dist/cli.js github sync
node dist/cli.js github sync --full

# GitHub 开源雷达
node dist/cli.js scan --root ~/projects
node dist/cli.js github sync --full

# Hugging Face 本地模型
node dist/cli.js huggingface sync

# LM Studio 本地模型
node dist/cli.js lmstudio sync
```

### 定时任务

`serve` 内置本地 scheduler，用于统一管理本机同步、扫描和派生重建任务。任务注册后默认关闭，不会随服务启动自动扫描 Chrome 历史、Atuin shell history、下载目录或编辑器最近项目。

```bash
# 查看已注册任务和最近运行状态
node dist/cli.js scheduler status

# 手动运行一个任务
node dist/cli.js scheduler run downloads.scan

# 启动 Web 控制台
node dist/cli.js serve
```

打开 `/scheduler` 可以启用/关闭任务、调整 interval、手动 Run now、查看最近运行历史。V1 已注册的任务包括 `downloads.scan`、`mac_apps.sync`、`brew.sync`、`huggingface.models.sync`、`lmstudio.models.sync`、`vscode.recent.sync`、`cursor.projects.sync`、`chrome.history.sync`、`chrome.domains.rebuild` 和 `atuin.directories.rebuild`。更多设计细节见 [Scheduler 设计](docs/scheduler-design.md)。

### RAG 本地笔记

```bash
# 1. 复制配置
cp rag.config.example.json ~/.ai2nao/rag.json
# 编辑 ~/.ai2nao/rag.json，填写 corpusRoots；如需向量召回，启用 embedding 和 vectorStore.provider=lancedb

# 2. 建索引（默认增量；不变文件会跳过，删除文件会从 FTS 和向量库移除）
node dist/cli.js rag ingest --root /path/to/notes

# 3. 可选：先看计划、不写库
node dist/cli.js rag ingest --dry-run

# 4. 可选：修复 partial/error 文件或强制全量重建
node dist/cli.js rag ingest --repair
node dist/cli.js rag ingest --force

# 5. 可选：跑固定问句评测
node dist/cli.js rag eval --cases docs/rag-eval-cases.json

# 6. 启动服务
node dist/cli.js serve
```

### AI 对话本机 LLM 配置

`/ai-chat` 页面不会自动猜模型服务。它只读取一个 JSON 配置文件，然后把模型调用交给 ai2nao 后端执行。

默认配置路径：

```bash
~/.ai2nao/llm-chat.json
```

也可以用环境变量覆盖：

```bash
AI2NAO_LLM_CHAT_CONFIG=/path/to/llm-chat.json node dist/cli.js serve
```

DeepSeek 示例：

```json
{
  "provider": "deepseek",
  "baseURL": "https://api.deepseek.com",
  "model": "deepseek-reasoner",
  "apiKey": "sk-..."
}
```

Ollama / LM Studio / 其他 OpenAI-compatible 服务示例：

```json
{
  "provider": "openai-compatible",
  "baseURL": "http://127.0.0.1:11434/v1",
  "model": "qwen2.5-coder:7b",
  "apiKey": "local-no-key"
}
```

字段要求：

- `provider`: `deepseek` 或 `openai-compatible`
- `baseURL`: 模型服务地址；本地服务通常带 `/v1`
- `model`: 模型名
- `apiKey`: 可选；省略时回退到 `AI2NAO_LLM_API_KEY` 或 `OPENAI_API_KEY`

如果页面提示“请先配置本机 LLM”，先打开 `/api/llm-chat/status` 看后端实际读取的 `configPath`、`configured` 和 `model`。最常见原因是文件不在当前进程的默认路径，或 `provider` / `baseURL` / `model` 字段不符合上面的格式。

## Web 界面

启动服务后打开终端显示的地址（默认仅监听本机）：

```bash
node dist/cli.js serve
```

**Web 功能**：
- **仓库** — 分页浏览、清单正文（JSON 高亮）、全文搜索
- **定时任务** — 在 `/scheduler` 统一管理本机同步任务，支持手动运行、interval 调度、运行锁和历史记录
- **开源雷达** — 在 `/github/radar` 把 GitHub Star 连接到已索引本地项目的 TODO、docs、README 和 manifest，生成可反馈的当前技术线索
- **软件** — macOS 应用、Homebrew 包、Hugging Face 与 LM Studio 本地模型浏览
- **工作区** — VS Code 与 Cursor 最近打开的项目、文件、workspace
- **对话** — Claude Code 与 Codex 本地对话历史
- **浏览** — Chrome 历史、Chrome 域名分析、Atuin Shell 历史日历、Atuin 目录活动

Codex 对话位于 `/codex-history`。它默认只读 `~/.codex/state_5.sqlite` 作为线程列表，
再读取对应的 `~/.codex/sessions/**/rollout-*.jsonl` 作为详情正文；当 SQLite 不可用
时会降级扫描 JSONL，并在页面上显示诊断原因。页面默认隐藏 archived 线程，可按 cwd、
branch、model 过滤。

Chrome 域名分析位于 `/chrome-history/domains`。它基于本地 Chrome History
镜像生成可重建的域名透视表，支持 Top domains、日/周/月时间矩阵和访问记录
钻取，也支持按域名与 URL/标题关键词搜索，并提供微信文章快捷筛选。`chrome-history sync` 会在原始访问写入后重建当前 profile 的域名层；
如果只想重建分析层，可运行 `chrome-history domains rebuild`。原始浏览记录仍
保留在本机 SQLite 中，域名层失败时不会回滚已同步的原始数据。

Atuin 目录活动位于 `/atuin/directories`。它从只读 Atuin `history.db` 全量扫描
并在 ai2nao 主索引库里生成可重建的目录/命令聚合层，Atuin 源库不会被写入。
页面支持 `raw` 与 `filtered` 两种模式：`raw` 统计全部未删除命令，`filtered`
默认排除 `pwd`、`ls`、`git status`、`git diff`、`clear`、`history`、
`atuin search ...` 等低信息命令。可在 `~/.ai2nao/config.json` 覆盖：

```json
{
  "atuin": {
    "directoryActivity": {
      "includeLowInfoCommands": false,
      "lowInfoCommands": [
        { "kind": "exact", "value": "pwd" },
        { "kind": "prefix", "value": "git status" },
        { "kind": "literal", "value": "--help" }
      ]
    }
  }
}
```

配置解析是严格模式：未知字段、非法 JSON 或非法规则类型会让重建失败，并在页面
状态区显示 `config_error`。重建状态会显示 `source_count`、耗时、fresh/stale
原因；旧聚合数据在重建失败时保留。

开发时分两进程（Vite 代理 API）：

```bash
npm run dev:ui
```

## AI 对话模型配置

`/ai-chat` 的模型调用由 ai2nao 后端负责，CopilotKit 只作为 transport/UI。复制示例配置到 `~/.ai2nao/llm-chat.json`：

```bash
cp llm-chat.config.example.json ~/.ai2nao/llm-chat.json
```

DeepSeek 官方 API 使用 first-party provider：

```json
{
  "provider": "deepseek",
  "baseURL": "https://api.deepseek.com",
  "apiKey": "sk-your-deepseek-key-here",
  "model": "deepseek-v4-pro"
}
```

OpenAI-compatible 本地服务继续保留，用于 LM Studio / Ollama / 代理网关：

```json
{
  "provider": "openai-compatible",
  "baseURL": "http://127.0.0.1:1234/v1",
  "apiKey": "local-no-key",
  "model": "local-model"
}
```

更多示例：

- [`llm-chat.config.moonshotai.example.json`](llm-chat.config.moonshotai.example.json) — Moonshot/Kimi
- [`llm-chat.config.alibaba.example.json`](llm-chat.config.alibaba.example.json) — Alibaba Cloud DashScope/Qwen
- [`llm-chat.config.openai-compatible.example.json`](llm-chat.config.openai-compatible.example.json) — LM Studio / Ollama / 代理网关

AI 对话环境变量回退：DeepSeek 使用 `DEEPSEEK_API_KEY` / `AI2NAO_LLM_API_KEY`；Moonshot 使用 `MOONSHOT_API_KEY` / `AI2NAO_LLM_API_KEY`；Alibaba 使用 `ALIBABA_API_KEY` / `AI2NAO_LLM_API_KEY`；OpenAI 使用 `OPENAI_API_KEY` / `AI2NAO_LLM_API_KEY`；OpenAI-compatible 使用 `AI2NAO_LLM_API_KEY` / `OPENAI_API_KEY`，本地服务无 key 时会使用占位 key。

## RAG（本地笔记 / 纯文本）

为 AI 对话提供可选的本地检索：把 `.md` / `.txt` 切块写入 **`~/.ai2nao/rag.db`**（SQLite FTS5），并可在 `rag.json` 里开启 embedding 与 LanceDB 向量库，形成 FTS + vector 双路召回和 RRF 融合。

RAG ingest 是增量索引：`rag_files` manifest 会记录每个文件的状态、mtime/size/hash、FTS 状态、向量状态和错误。普通 `rag ingest` 会跳过健康且未变化的文件；磁盘删除的文件会从 SQLite chunks/FTS 和 LanceDB 中移除，并保留 deleted tombstone 供状态页展示。

常用维护命令：

```bash
node dist/cli.js rag ingest --dry-run       # 只打印计划，不写 SQLite/LanceDB
node dist/cli.js rag ingest --repair        # 只修复 partial/error/unhealthy 文件
node dist/cli.js rag ingest --force         # 当前 corpus 全量重建
node dist/cli.js rag optimize               # 手动触发 LanceDB optimize
node dist/cli.js rag cleanup-tombstones     # 清理过期 deleted manifest
node dist/cli.js rag eval --cases docs/rag-eval-cases.json
```

Web 侧提供两个独立页面：

- `/rag-status` — 查看 manifest、chunk、vector sync、配置路径和 corpus roots。
- `/rag-debug` — 同一查询下对比 FTS、Vector、Hybrid 结果、分数和排名。

配置参考：
- [`rag.config.example.json`](rag.config.example.json) — OpenAI API
- [`rag.config.example.local-llm.json`](rag.config.example.local-llm.json) — LM Studio / Ollama

RAG embedding 环境变量回退：`OPENAI_API_KEY` / `AI2NAO_LLM_API_KEY`。DeepSeek chat 配置不会被自动当作 embedding endpoint；如需向量召回，请在 `rag.json` 的 `embedding` 块里显式配置 embedding provider。

## 测试

```bash
npm test
```

## 许可

MIT（见仓库内 `LICENSE`）。
