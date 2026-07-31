---
title: 桌面版运行时与原生模块:要不要额外打一个 Node
category: 调度与运维
order: 70
---

# 桌面版运行时与原生模块：要不要额外打一个 Node

> **一句话结论**：不用。ABI 不兼容的问题在 `better-sqlite3` 升到 v13（N-API）之后
> 已经从根上消失了，实测**完全不跑 `@electron/rebuild`** 也能正常工作。为它额外打
> 一个 Node 运行时要多付约 110MB，换不来任何东西。
>
> 本文记录这个结论是怎么验出来的，以及**什么情况下它会失效** —— 那才是这篇文档
> 真正的价值。

## 起因

桌面版把 daemon 装进了 `.app`（见 [Approach B 的落地](#附打包形态回顾)）。于是有一个
很自然的疑问：

> daemon 用的是 Electron 自带的 Node（`ELECTRON_RUN_AS_NODE`），所以 sqlite 这些
> 原生模块必须按 Electron 的 ABI 编。那能不能额外打一个标准 Node 运行时进去，让
> 原生模块用普通 Node ABI，彻底绕开兼容问题？

这个推理方向是对的，而且在 2026-07-31 之前它**是**成立的 —— 我们确实为此把
`better-sqlite3` 从 v11 升到了 v13。但升级之后前提就变了。

## 先纠正一个因果

「用 Electron 的 Node → 必须打包 sqlite」，因果是反的。

- **sqlite 无论如何都要打包**：daemon 要读写 `~/.ai2nao/index.db`，这与用哪个 Node
  运行时无关。
- Electron 的 Node 强加的是另一件事：**打进去的原生二进制必须能被 Electron 的
  Node 加载**。

后者才是「ABI 兼容」这个词指的东西。

## 到底有几个依赖受影响

daemon 打包时有 5 个外部依赖（其余全部被 esbuild 打进了 10MB 的单文件）：

| 依赖 | `.node` 文件数 | 性质 | 受 ABI 影响？ |
|---|---:|---|---|
| `better-sqlite3` | 8（全平台 prebuild） | **N-API** | 否 |
| `@lancedb/lancedb` | 0（在 optionalDependency 里） | napi-rs → **N-API** | 否 |
| `pyodide` | 0 | WebAssembly | 否 |
| `playwright` | 0 | 纯 JS（浏览器另行下载） | 否 |
| `@anthropic-ai/sandbox-runtime` | 0 | 纯 JS | 否 |

**两个原生依赖，两个都是 N-API。** N-API（Node-API）的整个设计目的就是 ABI 稳定：
一份编译产物，跨 Node 大版本、跨 Electron 通用，不需要 rebuild。

## 证据一：源码用的是哪套 API

```bash
$ grep -rho "v8::\|napi_" node_modules/better-sqlite3/src/ | sort | uniq -c
 101 napi_
   3 v8::
```

v11 是 V8 API 实现（所以对着 Electron 43 的 V8 编译会失败，报
`too few arguments to function call, single argument 'tag' was not specified`）。
v13 已经迁到 N-API。

## 证据二：prebuild 的命名方式

这是**最快的判断方法**，不用读源码：

```bash
$ ls node_modules/better-sqlite3/prebuilds/
darwin-arm64.node       linux-arm64.node        win32-arm64.node
darwin-x64.node         linux-x64.node          win32-x64.node
linuxmusl-arm64.node    linuxmusl-x64.node
```

| 文件名形态 | 含义 |
|---|---|
| `darwin-arm64.node` | **N-API** —— 不带 ABI 版本号，跨运行时通用 |
| `node-v115-darwin-arm64.node` | **V8 API** —— `v115` 是 `NODE_MODULE_VERSION`，换运行时就要重编 |

## 证据三：关掉 rebuild 直接跑（决定性实验）

前两条是间接推断，这条是直接验证。在 `desktop/package.json` 的 `build` 段临时加上
`"npmRebuild": false`，重新打包：

```
• skipped dependencies rebuild  reason=npmRebuild is set to false
```

然后用 `.app` 里的 Electron 以 Node 模式跑内嵌 daemon：

```bash
ELECTRON_RUN_AS_NODE=1 ai2nao.app/Contents/MacOS/ai2nao \
  ai2nao.app/Contents/Resources/app/out/daemon/daemon.mjs serve --db /tmp/x.db --port 8394
```

结果：

```json
{"version":"0.4.0","apiVersion":1,"schemaVersion":50,"pid":96971,...}
```

`schemaVersion: 50` 是从 `meta_schema` 表读出来的 —— 意味着**建库、跑完全部 50 个
迁移、读写都成功了**，用的是一份从未经过 `@electron/rebuild` 的 npm 预编译二进制。

ABI 问题不存在。

> 实验结束后 `npmRebuild` 已改回默认（`true`）。它现在虽然是多余的，但留着能当早期
> 预警：万一将来引入一个 V8 API 的原生依赖，它会在**构建期**失败，而不是等到运行
> 时崩溃。多花的构建时间换一个更早的报错位置，划算。

## 成本对比

| 方案 | `.app` 体积 | 解决的问题 |
|---|---:|---|
| 现状（用 Electron 的 Node） | 519 MB | — |
| 额外打官方 Node 运行时 | ~630 MB | 一个已经不存在的问题 |

官方 Node darwin-arm64 压缩包 48MB，解压后约 110MB。

## 什么时候这个结论会失效

**引入一个使用 V8 API（而非 N-API）的原生依赖时。** 那时 ABI 问题会立刻回来，
「独立 Node 运行时」就变成正确答案 —— 它让 daemon 与 Electron 的版本彻底解耦，
以后升 Electron 再也不用担心原生模块编不过。

判断新依赖属于哪一类，用上面**证据二**的方法：看 `prebuilds/` 里的文件名带不带
`node-vNNN-` 前缀。带就是 V8 API，会咬人。

另外两种会让结论失效的情况：

- **依赖只提供源码、不提供 prebuild**。那每次打包都要现编，Electron 的 V8 版本
  就重新成为变量。
- **需要在 Electron 主进程里直接 `require` 原生模块**。目前不需要 —— 壳侧零原生
  依赖，所有原生模块都只在 daemon 进程里加载。

## 顺带记下的减重线索

真要压 519MB，按收益排序：

| 项 | 大小 | 说明 |
|---|---:|---|
| `@lancedb/lancedb-darwin-arm64` | 96 MB | RAG 的向量库。砍掉意味着放弃向量检索、退回 FTS |
| `better-sqlite3` 的无用 prebuild | ~17 MB | 只打 macOS arm64，另外 7 个平台是死重 |
| Electron 运行时本身 | ~276 MB | 动不了 |

**数据不在 `.app` 里**：`~/.ai2nao/index.db`（862MB）在家目录下。删掉 `.app` 或者
换版本重装，数据一条都不会丢。这也是 `.app` 是 519MB 而不是 1.4GB 的原因。

## 附：打包形态回顾

```
ai2nao.app/Contents/
├── MacOS/ai2nao                      Electron 二进制,同时也是 daemon 的运行时
└── Resources/app/
    ├── out/main.js                   壳(esbuild 打包,零原生依赖)
    ├── out/daemon/
    │   ├── daemon.mjs                daemon(esbuild 打包,10.3MB 单文件)
    │   ├── package.json              name=ai2nao,给 packageRoot() 定位用
    │   └── web/dist/                 SPA
    └── node_modules/                 5 个外部依赖 + apache-arrow
```

daemon 由壳 detached spawn，脱离壳的进程组 —— **退出 app 后台服务继续运行**，因为
它同时托管 `/mcp`（供 Claude Code / Codex 查询）和 27 个定时任务。详见
[桌面壳手测清单](./desktop-manual-checklist)。

## 相关

- [桌面版打包：什么算「外部依赖」](./desktop-bundling-external-dependencies) ——
  本文讲的是「这 5 个包的 ABI 会不会出问题」；那篇讲的是「为什么恰好是这 5 个，以及
  esbuild 和 electron-builder 两处配置必须对齐」
- [桌面版手测清单](./desktop-manual-checklist) —— 自动化盖不到的部分怎么验
- 设计文档：`~/.gstack/projects/xunull-ai2nao/quincy-main-design-20260729-111531.md`
