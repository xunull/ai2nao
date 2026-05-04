# ai2nao

本地优先的个人数字痕迹索引器：Git 仓库清单、macOS 应用、Homebrew 包、Hugging Face 本地模型、浏览器历史、Shell 历史（Atuin）、VS Code / Cursor 打开项目、Claude Code / Codex 对话，一站检索。

数据默认落在 `~/.ai2nao/index.db`（可用 `--db` 覆盖）。

## 要求

- Node.js **20+**
- 依赖包含原生模块 **better-sqlite3**（安装时需为当前平台编译；CI 覆盖 Linux / macOS）

## 安装与构建

```bash
npm install
npm run build
```

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

### RAG 本地笔记

```bash
# 1. 复制配置
cp rag.config.example.json ~/.ai2nao/rag.json
# 编辑 ~/.ai2nao/rag.json，填写 corpusRoots

# 2. 建索引
node dist/cli.js rag ingest --root /path/to/notes

# 3. 启动服务
node dist/cli.js serve
```

## Web 界面

启动服务后打开终端显示的地址（默认仅监听本机）：

```bash
node dist/cli.js serve
```

**Web 功能**：
- **仓库** — 分页浏览、清单正文（JSON 高亮）、全文搜索
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
钻取。`chrome-history sync` 会在原始访问写入后重建当前 profile 的域名层；
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

## RAG（本地笔记 / 纯文本）

为 AI 对话提供可选的本地检索：把 `.md` / `.txt` 切块写入 **`~/.ai2nao/rag.db`**（FTS5；可在 `rag.json` 里开启 embedding 做字面 + 向量融合）。

配置参考：
- [`rag.config.example.json`](rag.config.example.json) — OpenAI API
- [`rag.config.example.local-llm.json`](rag.config.example.local-llm.json) — LM Studio / Ollama

环境变量回退：`OPENAI_API_KEY` / `AI2NAO_LLM_API_KEY`。

## 测试

```bash
npm test
```

## 许可

MIT（见仓库内 `LICENSE`）。
