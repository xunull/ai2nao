# ai2nao

本机优先的「数字痕迹」索引器（Wave 1）：在指定根目录下发现 Git 仓库，读取 `remote.origin` 与一组清单文件（README、`package.json`、`go.mod`、`pyproject.toml` 等），写入 **SQLite**，并对正文做 **FTS5** 全文检索。

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

## 使用

```bash
# 扫描当前目录树下所有 git 仓库（默认 DB：~/.ai2nao/index.db）
node dist/cli.js scan

# 指定多个根目录与数据库路径
node dist/cli.js scan --root ~/projects --root ~/work --db ./.ai2nao/index.db

# 查看统计
node dist/cli.js status

# FTS5 检索（查询语法见 SQLite FTS5 文档）
node dist/cli.js search "package.json"
```

`scan` 在部分根路径不可读时会向 stderr 输出警告，并以退出码 **1** 表示存在警告（仍可能已写入部分结果）。

## RAG（本地笔记 / 纯文本）

为 **AI 对话**（`/api/llm-chat`）提供可选的本地检索：把多个目录下的 `.md` / `.txt` 切块写入独立库 **`~/.ai2nao/rag.db`**（**FTS5**；可在 `rag.json` 里打开 **embedding** 做字面 + 向量融合）。

1. 复制 [`rag.config.example.json`](rag.config.example.json) 为 `~/.ai2nao/rag.json`，填写 `corpusRoots`（绝对路径）。开启 `embedding` 时：**OpenAI 官方 API** 请在 `embedding` 里填写 **`apiKey`**（与 `baseURL`、`model` 一致）。若不想把密钥写进文件，可省略 `apiKey`，改由环境变量 **`OPENAI_API_KEY`** / **`AI2NAO_LLM_API_KEY`** 或 `~/.ai2nao/llm-chat.json` 里的 `apiKey` 提供（与 [`src/rag/embeddings.ts`](src/rag/embeddings.ts) 中的回退顺序一致）。本机 LM Studio / Ollama 等通常无需密钥，可参考 [`rag.config.example.local-llm.json`](rag.config.example.local-llm.json)。也可用环境变量 **`AI2NAO_RAG_CORPUS_ROOT`** 追加一个语料根。
2. 建索引：`npm run dev -- rag ingest` 或 `node dist/cli.js rag ingest --root /path/to/notes`
3. 启动 API（`serve` 会打开 `rag.db`）：`node dist/cli.js serve`
4. 在 Web「AI 对话」里勾选 **使用本地 RAG**，或请求体带 `"useRag": true`。

状态：`GET /api/rag/status`。检索用**最后一条用户消息**做查询。`--rag-db` / **`AI2NAO_RAG_DB`** 可改 RAG 库路径。

## Web 界面（只读）

先执行 `npm run build`（编译 CLI + 前端）。默认仅监听本机：

```bash
node dist/cli.js serve
# 浏览器打开终端里打印的地址（含 SPA + /api）
```

开发时前后端分两个进程（Vite 将 `/api` 代理到 API 端口）：

```bash
npm run dev:ui
```

然后打开 Vite 提示的本地地址（一般为 `http://127.0.0.1:5173`）。仅跑 API、不加载页面时：

```bash
node dist/cli.js serve --api-only
```

产品说明与路由见 [`docs/PLAN.md`](docs/PLAN.md)。

## 测试

```bash
npm test
```

export AI2NAO_LLM_BASE_URL=http://127.0.0.1:1234/v1
export AI2NAO_LLM_MODEL="google/gemma-4-26b-a4b"

ai2nao serve --daily-summary

## 许可

MIT（见仓库内 `LICENSE`）。
