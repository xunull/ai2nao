# ai2nao

本地优先的个人数字痕迹索引器：Git 仓库清单、macOS 应用、Homebrew 包、浏览器历史、Shell 历史（Atuin）、Claude Code 对话，一站检索。

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
# Chrome 浏览器历史
node dist/cli.js chrome-history sync
node dist/cli.js chrome-history watch --interval 30

# GitHub 仓库 & Tags
node dist/cli.js github sync
node dist/cli.js github sync --full
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
- **软件** — macOS 应用、Homebrew 包浏览
- **对话** — Claude Code 对话历史
- **浏览** — Chrome 历史、Atuin Shell 历史日历

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
