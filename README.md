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

## 许可

MIT（见仓库内 `LICENSE`）。
