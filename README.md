<!-- 语言 / Language --> [English](README.en.md) · **中文**

# ai2nao

**本地优先的个人开发数据驾驶舱。** 把散落在各处的 AI 编程工具历史、token / 成本、外部平台用量、本机软件与模型清单、浏览器 / Shell / Git / GitHub 活动汇聚到**一个本地 SQLite 库**里,再叠一层 Web 界面、RAG、Web Search、AI 对话和 MCP server——让你（和你的 AI 工具）一站看清、查清自己的开发活动。

数据默认落在 `~/.ai2nao/index.db`（可用 `--db` 覆盖）。所有数据留在本机,默认只监听 `127.0.0.1`。

## 功能总览

- **AI 用量与成本** — 汇总 Claude Code / Codex 的 token 用量,按项目 / 日期 / 模型拆分,显示等价 API 成本（价格可从 [models.dev](https://models.dev) 定时同步）。页面:`/dashboard/tokens`（排行）、`/dashboard/tokens-trend`（趋势 + 成本）。
- **最近工作** — `/dashboard` 把 Claude Code / Codex 等本地会话聚成「最近在做什么」;`/work-recap` 串成工作回看。
- **对话宇宙** — `/dashboard/cosmos` 把所有 AI 对话嵌入 2D 语义空间渲染成散点图（详见下方 Showcase）。
- **外部平台用量** — `/providers` 以插件方式同步外部 AI 平台（如 MiniMax）的剩余额度,可逐个启用 / 禁用,API key 只写本机、不回传。
- **本机资产** — Git 仓库清单 + FTS5 全文检索、macOS 应用、Homebrew 包、Hugging Face / LM Studio 本地模型、下载目录、VS Code / Cursor 最近项目。
- **AI 对话历史** — Claude Code、Codex、Cursor、Cherry Studio 的本地对话,只读浏览、过滤、检索。
- **浏览器 / Shell** — Chrome 历史、Chrome 域名透视、Chrome 下载、Atuin Shell 历史与目录活动。
- **GitHub / 开源雷达** — GitHub 仓库 & Star、`/github/radar` 把 Star 连回本地项目的 TODO/docs/README。
- **AI 对话 + RAG** — `/ai-chat` 由 ai2nao 后端掌控模型调用,可挂本地 RAG（FTS + 向量双路召回）。
- **MCP 记忆器官** — `serve` 在 `/mcp` 暴露只读 MCP server,让 Claude Code / Codex 等 agent 当场查你的开发数据（见 [MCP 记忆器官](#mcp-记忆器官)）。
- **定时任务** — `serve` 内置本地 scheduler,统一管理同步 / 扫描 / 派生重建任务(默认全部关闭)。

## Showcase

### 对话宇宙 `/dashboard/cosmos`

把本地所有 AI 对话 session（Claude Code + Codex）嵌入 2D 语义空间,渲染成一张散点图:**颜色 = 来源**（Claude 蓝 / Codex 橙）,**大小 = token 量**。一眼看到"我和 AI 一年聊过的东西在语义空间里长什么样",一键导出 PNG。

<!-- 截图待手动补：启动 serve → 打开 /dashboard/cosmos → 点"刷新"生成散点 → 导出 PNG → 放到 docs/assets/cosmos.png 并在此处插入 ![](docs/assets/cosmos.png) -->

- embedding 复用 RAG 的 provider 配置（`~/.ai2nao/rag.json`）,默认走远端服务,页面如实标注 embedding model。想完全 local-only 见 TODOS（本地 embedding fallback）。
- session 内容不全量上传:每个 session 只取"首条实质提问 + 末条实质回复"的原文节选（≤2K 字符,剥掉 CLI 控制标签 / ANSI）。数据边界详见 [Cosmos embedding 数据边界](local-docs/2026-06-14-cosmos-embedding-data-boundary/README.md)。
- 工程细节（数据流、schema、UMAP 投影、API、Phase 2 路线）见 [Activity Cosmos 技术文档](docs/activity-cosmos.md)。

## 要求

- Node.js **20+**
- 依赖包含原生模块 **better-sqlite3**（安装时需为当前平台编译;CI 覆盖 Linux / macOS）

## 安装与构建

```bash
npm install
npm run build
```

`package.json` 中所有 `scripts` 的用途见:[package.json scripts 说明](docs/package-scripts.md)。

开发时可直接:

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

# 3. 启动 Web 界面（默认 http://127.0.0.1:8787）
node dist/cli.js serve
```

## 命令概览

### 仓库索引

```bash
node dist/cli.js scan --root ~/projects --root ~/work   # 扫描多个根目录
node dist/cli.js status                                 # 查看统计
node dist/cli.js search "package.json"                  # FTS5 全文检索
```

### 软件清单

```bash
node dist/cli.js apps sync          # 同步已安装 macOS 应用
node dist/cli.js apps reset --yes   # 清空清单
node dist/cli.js brew sync          # 同步 Homebrew formula / cask
node dist/cli.js brew reset --yes   # 清空清单
```

### 其他同步

```bash
# VS Code / Cursor 打开项目
node dist/cli.js vscode sync
node dist/cli.js cursor projects sync

# Chrome 浏览器历史
node dist/cli.js chrome-history sync
node dist/cli.js chrome-history watch --interval 30
node dist/cli.js chrome-history domains rebuild

# Atuin 目录活动
node dist/cli.js atuin directories rebuild

# GitHub 仓库 & Tags
node dist/cli.js github sync
node dist/cli.js github sync --full

# Hugging Face / LM Studio 本地模型
node dist/cli.js huggingface sync
node dist/cli.js lmstudio sync
```

## 定时任务

`serve` 内置本地 scheduler,统一管理本机同步、扫描和派生重建任务。任务注册后**默认关闭**,不会随服务启动自动扫描。

```bash
node dist/cli.js scheduler status              # 已注册任务和最近运行状态
node dist/cli.js scheduler run downloads.scan  # 手动运行一个任务
node dist/cli.js serve                         # 启动 Web 控制台
```

打开 `/scheduler` 可启用 / 关闭任务、调整 interval、手动 Run now、查看运行历史。已注册任务含 `downloads.scan`、`mac_apps.sync`、`brew.sync`、`huggingface.models.sync`、`lmstudio.models.sync`、`vscode.recent.sync`、`cursor.projects.sync`、`chrome.history.sync`、`chrome.domains.rebuild`、`atuin.directories.rebuild`、以及 token/价格同步类任务。更多见 [Scheduler 设计](docs/scheduler-design.md)。

## MCP 记忆器官

`serve` 跑着时会在 `/mcp` 暴露一个本地 MCP server（只读、绑 `127.0.0.1`）,把 ai2nao 的数据当成 tool 给 Claude Code / Codex 等 agent 调用。在 Claude Code 里注册一次:

```bash
claude mcp add --transport http ai2nao http://127.0.0.1:8787/mcp
```

注册后即可在对话里直接问,例如「这个 repo 这周烧了多少 token」「我在哪个项目花的时间最多」。首版 tool:

- `project_tokens` — 各项目 Claude Code token 用量（可按项目 / 起始日期过滤）
- `time_spent` — 各项目诚实活跃工时
- `external_usage` — 外部平台（MiniMax 等）剩余额度（不返回 API key）

只读:MCP 用独立的只读句柄打开 index DB,任何 tool 都改不了库。`serve` 没起时连接失败属预期。

## AI 对话本机 LLM 配置

`/ai-chat` 的模型调用由 ai2nao 后端负责（CopilotKit 只作为 transport/UI）。它不会自动猜模型服务,只读取一个 JSON 配置文件。复制示例后编辑:

```bash
cp llm-chat.config.example.json ~/.ai2nao/llm-chat.json
# 也可用环境变量覆盖路径：
AI2NAO_LLM_CHAT_CONFIG=/path/to/llm-chat.json node dist/cli.js serve
```

DeepSeek 官方 API:

```json
{
  "provider": "deepseek",
  "baseURL": "https://api.deepseek.com",
  "model": "deepseek-reasoner",
  "apiKey": "sk-..."
}
```

Ollama / LM Studio / 其他 OpenAI-compatible 本地服务:

```json
{
  "provider": "openai-compatible",
  "baseURL": "http://127.0.0.1:11434/v1",
  "model": "qwen2.5-coder:7b",
  "apiKey": "local-no-key"
}
```

字段:`provider`（`deepseek` 或 `openai-compatible`）、`baseURL`（本地服务通常带 `/v1`）、`model`、`apiKey`（可选,省略时回退到 `AI2NAO_LLM_API_KEY` / `OPENAI_API_KEY`）。

更多示例:[Moonshot/Kimi](llm-chat.config.moonshotai.example.json) · [Alibaba DashScope/Qwen](llm-chat.config.alibaba.example.json) · [OpenAI-compatible](llm-chat.config.openai-compatible.example.json)。各 provider 的环境变量回退:DeepSeek `DEEPSEEK_API_KEY`、Moonshot `MOONSHOT_API_KEY`、Alibaba `ALIBABA_API_KEY`、OpenAI `OPENAI_API_KEY`,统一回退到 `AI2NAO_LLM_API_KEY`。

> 页面提示「请先配置本机 LLM」时,先看 `/api/llm-chat/status` 返回的 `configPath` / `configured` / `model`,确认文件路径与字段格式。

## RAG（本地笔记 / 纯文本）

为 AI 对话提供可选的本地检索:把 `.md` / `.txt` 切块写入 **`~/.ai2nao/rag.db`**（SQLite FTS5）,并可在 `rag.json` 里开启 embedding 与 LanceDB 向量库,形成 FTS + vector 双路召回和 RRF 融合。

```bash
cp rag.config.example.json ~/.ai2nao/rag.json   # 编辑，填 corpusRoots；需向量召回则启用 embedding + vectorStore
node dist/cli.js rag ingest --root /path/to/notes  # 增量索引（不变文件跳过，删除文件移除）
node dist/cli.js rag ingest --dry-run              # 只打印计划，不写库
node dist/cli.js rag ingest --repair               # 只修复 partial/error 文件
node dist/cli.js rag ingest --force                # 当前 corpus 全量重建
node dist/cli.js rag eval --cases docs/rag-eval-cases.json  # 固定问句评测
```

Web 侧:`/rag-status`（manifest / chunk / vector sync / 配置路径）、`/rag-debug`（同一查询对比 FTS / Vector / Hybrid 结果与排名）。配置示例:[OpenAI](rag.config.example.json)。RAG embedding 环境变量回退 `OPENAI_API_KEY` / `AI2NAO_LLM_API_KEY`;DeepSeek chat 配置不会被自动当作 embedding endpoint,需在 `rag.json` 的 `embedding` 块显式配置。

## Web 界面

启动服务后打开终端显示的地址（默认 `http://127.0.0.1:8787`,仅监听本机）。开发时分两进程（Vite 代理 API）:

```bash
npm run dev:ui
```

导航分组:

- **AI 对话** — `/ai-chat`
- **工作台** — 最近工作 `/dashboard`、Token 排行 `/dashboard/tokens`、Token 趋势 + 成本 `/dashboard/tokens-trend`、工作回看 `/work-recap`、对话宇宙 `/dashboard/cosmos`、外部平台 `/providers`
- **本机资产** — 仓库、定时任务、下载、Mac 应用、VS Code、Cursor 项目、Homebrew、HF 模型、LM Studio、Atuin、Atuin 目录
- **浏览器** — Chrome 历史 `/chrome-history`、Chrome 域名 `/chrome-history/domains`、Chrome 下载
- **AI 记录** — Cherry / Cursor / Claude / Codex 本地对话
- **AI 工具** — Shell 权限 / 沙箱、RAG 状态 / 调试
- **GitHub / 开源** — GitHub、开源雷达 `/github/radar`、Star Tag

几个页面的数据边界值得留意:

- **Codex 对话** `/codex-history`:默认只读 `~/.codex/sqlite/state_5.sqlite`（旧版回退顶层 `state_5.sqlite`）作为线程列表,再读对应 `~/.codex/sessions/**/rollout-*.jsonl` 作为详情;SQLite 不可用时降级扫描 JSONL 并显示诊断。默认隐藏 archived,可按 cwd / branch / model 过滤。
- **Chrome 域名分析** `/chrome-history/domains`:基于本地 Chrome History 镜像生成可重建的域名透视表（Top domains、日/周/月矩阵、访问钻取、关键词搜索、微信文章筛选）。原始浏览记录保留在本机 SQLite,域名层失败不回滚原始数据。
- **Atuin 目录活动** `/atuin/directories`:从只读 Atuin `history.db` 全量扫描,在 ai2nao 库里生成可重建的目录/命令聚合层(不写 Atuin 源库)。支持 `raw` / `filtered` 两种模式,低信息命令过滤可在 `~/.ai2nao/config.json` 覆盖:

  ```json
  {
    "atuin": {
      "directoryActivity": {
        "includeLowInfoCommands": false,
        "lowInfoCommands": [
          { "kind": "exact", "value": "pwd" },
          { "kind": "prefix", "value": "git status" }
        ]
      }
    }
  }
  ```

  配置解析是严格模式:未知字段 / 非法 JSON / 非法规则会让重建失败并在状态区显示 `config_error`,旧聚合数据保留。

## 测试

```bash
npm test
```

## 文档

成本与 Token:

- [Session 文件的 Token 字段参考](docs/session-token-fields.md) — Claude Code 与 Codex session 里**所有** token 字段的完整枚举
- [Token 计算管线](docs/token-usage-pipeline.md) — ai2nao 如何解析、聚合、落库 token
- [成本计费逻辑](docs/cost-billing.md) — 输入 / cache / 输出分段计价、等价 API 成本如何算

可视化:

- [Activity Cosmos 技术文档](docs/activity-cosmos.md) — 对话宇宙的数据流、schema、UMAP、API

## 许可

MIT（见仓库内 `LICENSE`）。
