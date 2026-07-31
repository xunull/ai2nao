---
title: 桌面版构建流水线:Vite / esbuild / electron-builder 各管什么
category: 调度与运维
order: 69
---

# 桌面版构建流水线：Vite / esbuild / electron-builder 各管什么

> **一句话**：它们不是二选一的同类工具，是流水线上的三个阶段。前两个是**打包代码**
> 的，最后一个是**打包应用**的 —— 中文都叫「打包」，但处理对象完全不同。
>
> 搞混这一层，就会问出「electron-builder 里怎么配 external」这种没有答案的问题
> （`external` 是 esbuild 的概念，electron-builder 根本不认识它）。

## 三层的真实数据

以下数字都是这个仓库实测的，不是估算。

```
web/src/**            96 个 ts/tsx
      │
      │  Vite                14 秒
      │  打前端:JSX、CSS、按需分包、生成 hash 文件名
      ▼
web/dist/             18 MB, 507 个文件
      │
      │                     ┐
src/**/*.ts   362 个 .ts     │
desktop/src/**              │
      │                     │
      │  esbuild        1.1 秒
      │  打后端:解析 import、内联依赖、tree-shake、转译 TS
      ▼                     │
desktop/out/                │
  ├── main.js       31.9 KB │ ← 壳(Electron 主进程)
  └── daemon/               │
      ├── daemon.mjs 10.3 MB│ ← 整个 daemon,一个文件
      └── web/dist/  ←──────┘   (从上面拷进来)
      │
      │  electron-builder    5 秒
      │  打应用:下载 Electron 运行时、造 .app 骨架、拷 node_modules、
      │         写 Info.plist、装 icon.icns、@electron/rebuild、签名
      ▼
ai2nao.app            509 MB, 3237 个文件
```

**362 个 `.ts` → 1 个 `.mjs` → 3237 个文件的 `.app`。** 中间那步是 esbuild，后一步是
electron-builder。

## 逐项对比

| | esbuild | electron-builder |
|---|---|---|
| 处理对象 | JS / TS **源码** | **文件和目录** |
| 认识 `import` 语句吗 | 认识 —— 这是它全部的工作 | 不认识 |
| 认识 `dependencies` 字段吗 | 不认识 | 认识 —— 这是它决定拷什么的依据 |
| 认识 `external` 吗 | 认识 | **不认识** |
| 知道 Electron 是什么吗 | **完全不知道** | 全部工作都围绕它 |
| 输出 | `.js` 文件 | `.app` / `.dmg` / `.exe` / `.deb` |
| 本项目耗时 | 1.1 秒 | 5 秒 |
| 配置在哪 | `desktop/build.mjs` | `desktop/package.json` 的 `build` 段 |

**esbuild 对 Electron 一无所知**这点值得强调。用它打 daemon 的 bundle 时，它跟
Electron 半点关系没有 —— 纯粹是「把 362 个 TS 文件压成一个 JS 文件」，换成打一个
普通 Node CLI 也是同一套配置。

## 为什么「两处必须对齐」是必然的

因为**两个工具互相看不见对方的配置**：

- esbuild 留下一句 `import "playwright"`，它**不知道** playwright 会不会出现在
  `.app` 里 —— 那不归它管
- electron-builder 按 `dependencies` 拷包，它**不知道** bundle 里到底 import 了
  什么 —— 它没读过那个文件

中间没有任何一方在校验。所以 `dependencies` 漏一个，两边都不报错，只有运行到那行
import 才 `Cannot find module`。

**这不是谁的 bug，是分层的必然代价。** 详细的判据、失败模式和一条实测有效的校验
命令，见 [桌面版打包：什么算「外部依赖」](./desktop-bundling-external-dependencies)。

## 一个容易误解的地方：`build.files`

`desktop/package.json` 里：

```json
"files": ["out/**"]
```

看起来像是「只打包 out/」，但 `.app` 里明明有 37 个 npm 包。因为 `files` 管的是
**应用自己的源文件**，`node_modules` 走的是另一条完全独立的规则：
electron-builder **自动收录 `dependencies`、自动排除 `devDependencies`**。

可以直接验证 —— `.app` 里有 `better-sqlite3`、`apache-arrow`、`playwright-core`，
而 `electron` / `esbuild` / `typescript` / `electron-builder` 一个都没有：

```bash
ls release/mac-arm64/ai2nao.app/Contents/Resources/app/node_modules
```

## 为什么前端用 Vite、后端用 esbuild

两者都能打包，分工的理由是各自的强项：

- **Vite** 打前端。它管的是 JSX、CSS、静态资源、代码分割、hash 文件名、
  `index.html` 注入 —— 这些 esbuild 要自己拼装。而且 `web/` 本来就是个 Vite 项目
  （`web/vite.config.ts`），开发时的 HMR 也靠它。
- **esbuild** 打后端。壳和 daemon 都是纯 Node 代码，不需要 CSS、不需要分包、不需要
  HTML —— 只要「解析 import，输出一个文件」，而这正是 esbuild 最快的场景（1.1 秒
  对 362 个文件）。

顺带一提：Vite 内部本来就用 esbuild 做转译，所以这不是两套技术，是同一套的不同封装
层级。

## 同类工具

分清代际有助于判断该找哪个：

| 层 | 同类工具 |
|---|---|
| **打包代码** | esbuild、webpack、rollup、Vite、parcel；`tsc`（只转译，不打包） |
| **打包应用** | electron-builder、Electron Forge、`@electron/packager` |

「我要减小 bundle 体积」找上面一层；「我要出 `.dmg` / 签名 / 自动更新」找下面一层。

## 相关

- [桌面版打包：什么算「外部依赖」](./desktop-bundling-external-dependencies) ——
  esbuild 的 `external` 判据，以及两处配置对齐的失败模式
- [桌面版运行时与原生模块](./desktop-app-runtime-and-native-modules) ——
  原生模块的 ABI 问题，为什么不需要额外打一个 Node
- [桌面版手测清单](./desktop-manual-checklist)
