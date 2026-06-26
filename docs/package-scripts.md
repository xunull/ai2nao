---
title: package.json scripts 说明
category: 调度与运维
order: 40
---
# package.json scripts 说明

本文记录 `package.json` 中 `scripts` 字段的各项命令用途。

这些命令主要分为五类：

- 构建与启动
- 开发服务
- 本地数据同步
- RAG 索引
- 测试

## 构建与启动

| 命令 | 底层命令 | 作用 |
|---|---|---|
| `npm run build` | `npm run build:server && npm run build:web` | 一次性构建后端 TypeScript 和前端 Web 产物。发布或验证完整构建时使用。 |
| `npm run build:server` | `tsc` | 只编译后端和共享 TypeScript 代码，输出到 `dist/`。适合快速检查服务端类型错误。 |
| `npm run build:web` | `vite build --config web/vite.config.ts` | 只构建前端 Web UI。适合检查 Vite 打包、路由懒加载和前端类型/模块问题。 |
| `npm run start` | `node dist/cli.js` | 使用已构建的 CLI 入口运行 ai2nao。需要先执行 `npm run build`。 |

常见用法：

```bash
npm run build
npm run start -- serve
```

## 开发服务

| 命令 | 底层命令 | 作用 |
|---|---|---|
| `npm run dev` | `tsx src/cli.ts` | 直接用源码运行 CLI，跳过构建步骤。适合开发时执行任意 ai2nao 子命令。 |
| `npm run dev:api` | `tsx watch src/cli.ts serve --daily-summary --port 8787` | 启动开发 API 服务，并监听源码变化自动重启。默认启用 daily-summary，端口为 `8787`。 |
| `npm run dev:api:debug` | `env AI2NAO_LLM_CHAT_DEBUG=1 npm run dev:api` | 启动带 LLM Chat 调试日志的开发 API 服务。排查 AI Chat / CopilotKit 请求时使用。 |
| `npm run dev:web` | `vite --config web/vite.config.ts --port 5173` | 启动前端 Vite 开发服务，端口为 `5173`。 |
| `npm run dev:ui` | `concurrently -k "npm run dev:api" "npm run dev:web"` | 同时启动开发 API 和前端 Web。日常开发 Web UI 时最常用。 |
| `npm run dev:ui:debug` | `concurrently -k "npm run dev:api:debug" "npm run dev:web"` | 同时启动调试版 API 和前端 Web。排查 AI Chat、RAG 上下文、接口日志时使用。 |

常见用法：

```bash
npm run dev -- scan --root .
npm run dev:ui
npm run dev:ui:debug
```

## 本地数据同步

这些脚本都是对 `tsx src/cli.ts ...` 的快捷封装，用于同步本机数据到 ai2nao 的本地索引库。

| 命令 | 底层命令 | 作用 |
|---|---|---|
| `npm run downloads:watch` | `tsx src/cli.ts downloads watch --interval 30` | 每 30 秒监听并同步 Chrome 下载记录。 |
| `npm run apps:sync` | `tsx src/cli.ts apps sync` | 同步 macOS 已安装应用清单。 |
| `npm run apps:reset` | `tsx src/cli.ts apps reset --yes` | 清空 macOS 应用清单数据。带 `--yes`，会直接执行重置。 |
| `npm run brew:sync` | `tsx src/cli.ts brew sync` | 同步 Homebrew formula 和 cask 清单。 |
| `npm run brew:reset` | `tsx src/cli.ts brew reset --yes` | 清空 Homebrew 清单数据。带 `--yes`，会直接执行重置。 |
| `npm run vscode:sync` | `tsx src/cli.ts vscode sync` | 同步 VS Code 最近打开项目、文件和 workspace。 |
| `npm run vscode:windows` | `tsx src/cli.ts vscode windows` | 输出 VS Code window state 中记录的项目窗口信息。 |
| `npm run vscode:reset` | `tsx src/cli.ts vscode reset --yes` | 清空 VS Code 最近项目镜像数据。带 `--yes`，会直接执行重置。 |
| `npm run chrome-history:sync` | `tsx src/cli.ts chrome-history sync` | 同步 Chrome 浏览历史到本地索引库。 |
| `npm run chrome-history:watch` | `tsx src/cli.ts chrome-history watch --interval 30` | 每 30 秒监听并同步 Chrome 浏览历史。 |
| `npm run github:sync` | `tsx src/cli.ts github sync` | 同步 GitHub 数据，通常用于刷新已知仓库、stars 或相关本地镜像。 |
| `npm run github:sync:full` | `tsx src/cli.ts github sync --full` | 执行完整 GitHub 同步，比普通同步覆盖范围更大。 |
| `npm run github:tags:rebuild` | `tsx src/cli.ts github tags rebuild` | 重建 GitHub Star Tag 数据。 |
| `npm run github:tags:alias:seed` | `tsx src/cli.ts github tags alias seed` | 初始化或补齐 GitHub tag alias 种子数据。 |

## RAG 索引

| 命令 | 底层命令 | 作用 |
|---|---|---|
| `npm run rag:ingest` | `tsx src/cli.ts rag ingest` | 使用源码入口运行 RAG ingest。会按 `rag.json` 或命令行参数扫描语料、切块并写入 RAG 索引。 |

常见扩展参数：

```bash
npm run rag:ingest -- --root /path/to/notes
npm run rag:ingest -- --dry-run
npm run rag:ingest -- --repair
npm run rag:ingest -- --force
```

注意：通过 `npm run` 透传参数时，需要在脚本名后加 `--`。

## 测试

| 命令 | 底层命令 | 作用 |
|---|---|---|
| `npm test` | `vitest run` | 运行全部 Vitest 测试，适合提交前验证。 |
| `npm run test:e2e` | `playwright test` | 运行 Playwright E2E 测试。适合验证真实浏览器交互。 |
| `npm run test:watch` | `vitest` | 以 watch 模式运行 Vitest。适合开发时边改边跑。 |

常见用法：

```bash
npm test
npm run test:watch
npm run test:e2e
```

## 文档站（VitePress）

把 `docs/` 下的设计笔记构建成可浏览、可搜索的静态站点，发布到 GitHub Pages。

| 命令 | 底层命令 | 作用 |
|---|---|---|
| `npm run docs:dev` | `vitepress dev docs --port 5180` | 本地启动文档站开发服务，端口 `5180`（特意避开 `dev:web` 的 `5173`）。改 `docs/` 下 markdown 时实时预览。 |
| `npm run docs:build` | `vitepress build docs` | 构建文档站，产物在 `docs/.vitepress/dist`（已 gitignore）。CI 与发布前验收用。 |
| `npm run docs:preview` | `vitepress preview docs` | 本地预览已构建的产物（端口默认 `4173`），用于核对最终静态站。 |

侧边栏由 `docs/.vitepress/sidebar.ts` 按每篇 markdown 的 `category` / `order` frontmatter 自动分组生成；加新文档只需写 frontmatter，无需手改配置。

## 使用建议

- 日常开发 Web UI：优先用 `npm run dev:ui`。
- 排查 AI Chat 或 CopilotKit：用 `npm run dev:ui:debug`。
- 提交前验证：至少运行 `npm test`，涉及构建或前端路由时再运行 `npm run build`。
- 本地数据刷新：优先使用具体 sync 脚本，例如 `npm run chrome-history:sync`、`npm run github:sync:full`。
- RAG 调试：先用 `npm run rag:ingest -- --dry-run` 查看计划，再执行真实 ingest。
