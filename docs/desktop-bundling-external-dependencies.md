---
title: 桌面版打包:什么算「外部依赖」,以及两处必须对齐
category: 调度与运维
order: 71
---

# 桌面版打包：什么算「外部依赖」，以及两处必须对齐

> **两句话**：`external` 是 **esbuild** 的概念，electron-builder 根本不认识它。
> 打一个 `.app` 要经过两个独立步骤、在两个地方各配一次，**任何一边漏了都会在运行
> 时崩，而且第二种漏法全程绿灯**。
>
> 本文写清判据、失败模式，以及一条实测有效的打包后校验命令。
>
> 不清楚 esbuild 和 electron-builder 各管什么的，先看
> [桌面版构建流水线](./desktop-build-pipeline) —— 本文默认你已经知道它们是流水线上
> 的两个阶段，而不是二选一的同类工具。

## 「外部依赖」的准确定义

esbuild 的 `external`：**不要把这个包的代码内联进 bundle，保留 `import` 语句，运行
时从 `node_modules` 里解析。**

判据只有一条：**这个包必须在运行时以一个真实目录的形式存在于磁盘上。**

daemon 打包时只有 5 个包满足这条（见 `desktop/build.mjs` 的 `DAEMON_EXTERNALS`），
其余 30 多个 —— hono、commander、ai SDK、MCP SDK、better-sqlite3 的所有调用方 ——
全部被压进了那个 10.3MB 的 `out/daemon/daemon.mjs` 单文件。

## 三类判据，外加一条保守

不是一个理由。加新条目之前先确认它属于哪一类，别凭感觉加。

| 包 | 类别 | 依据 |
|---|---|---|
| `better-sqlite3` | **原生二进制** | 8 个 `.node`。编译产物无法内联进 JS |
| `@lancedb/lancedb` | **原生二进制** | 真正的 `.node` 在它的 optionalDependency `@lancedb/lancedb-darwin-arm64` 里（napi-rs 出的） |
| `pyodide` | **自定位资产** | `src/codeRunner/pyodideWorker.ts:54` 用 `import.meta.resolve("pyodide")` 找自己的安装目录，再从那里加载 `pyodide.asm.wasm` 和 python 标准库 |
| `playwright` | **构建期就打不进去** | `playwright-core` 里 `require("chromium-bidi/...")`，那是个未安装的可选依赖，esbuild 直接报 `Could not resolve` 并失败 |
| `@anthropic-ai/sandbox-runtime` | **保守，非技术必然** | 实测**可以**打进去 |

### 「自定位资产」这一类最危险

`pyodide` 属于这一类：**esbuild 能构建成功**，产物也跑得起来，只有在真正执行
Python 代码时 `import.meta.resolve("pyodide")` 才会发现无处可指。构建绿、启动绿、
用到才炸。

判断方法：在包里 grep 自定位调用。

```bash
grep -rhoE "import\.meta\.(url|resolve)|__dirname|require\.resolve" node_modules/<包>/dist/
```

再看它有没有非 JS 的运行时资产（`.wasm` / `.data` / 模板 / 二进制）：

```bash
find node_modules/<包> -type f ! -name "*.js" ! -name "*.ts" ! -name "*.json" ! -name "*.md"
```

两样都没有，多半能安全打进 bundle。

### 关于最后那条保守项

`@anthropic-ai/sandbox-runtime` 实测：无自定位逻辑、无非 JS 资产、包里唯一的
`spawn(` 是去起沙箱命令而不是加载自己的文件。**技术上可以打进 bundle。**

留在外面的真实理由是保守：它是安全相关组件，3.6MB 不值得为一个「有没有我没查到的
动态 require」的可能性冒险。真要减重，这是可以先动的一条 —— 但动之前要跑通 bash
工具的沙箱路径。

## external 的数量 ≠ `.app` 里包的数量

这个区别咬过一次。

```
esbuild external 列表:        5
.app node_modules 实际:      37
```

多出来的 32 个是那 5 个的**传递依赖和 peer**：

```
apache-arrow  playwright-core  commander  zod  ws  node-forge
@swc  flatbuffers  tslib  chalk  shell-quote  reflect-metadata  ...
```

## 两个独立机制，必须对齐

| 步骤 | 工具 | 在哪配 | 决定什么 |
|---|---|---|---|
| 打 bundle | esbuild | `desktop/build.mjs` 的 `external: [...]` | 哪些**代码**不内联进 `daemon.mjs` |
| 打 `.app` | electron-builder | `desktop/package.json` 的 `dependencies` | 哪些**包**被复制进 `.app` |

electron-builder 完全不认识 esbuild 的 external 列表。它自动收录 `dependencies`、
自动排除 `devDependencies` —— 可以验证：`build.files` 里只写了 `out/**`，一个字没提
`node_modules`，但 `.app` 里有 37 个包，而 electron / esbuild / typescript /
electron-builder 一个都没进去。

```
esbuild external: [playwright, ...]
        ↓  bundle 里留下 import "playwright"
        ↓  运行时要能解析到它
package.json dependencies: { playwright: ... }
        ↓  electron-builder 才会把它复制进 .app
```

### 失败模式是不对称的

| 漏在哪 | 什么时候暴露 |
|---|---|
| esbuild 该 external 却没写 | **构建期**报错（`Could not resolve`），或产物一跑就炸 |
| `dependencies` 里漏了 | **构建成功、打包成功**，只在运行到那行 import 时 `Cannot find module` |

第二种更阴，因为一路绿灯。

## peerDependency 陷阱

`apache-arrow` 两边都没写 —— 但它本来不该由我们写：它是 `@lancedb/lancedb` 的依赖，
理应被自动带进来。

问题在于它是 **peerDependency**，而 **electron-builder 的生产依赖遍历不走 peer**。
结果：

```
.app node_modules: 16 个包   ← 而不是 37
启动即 Cannot find module 'apache-arrow'
```

修法是把它**显式提升成 `desktop/package.json` 的直接 dependency**。

新增 external 时先查它的 peer：

```bash
node -e "const p=require('./node_modules/<包>/package.json');
console.log(p.peerDependencies||{}, p.peerDependenciesMeta||{})"
```

`optional: true` 的可以不管，required 的必须显式提升。

## 打包后校验（实测有效）

别等运行时。打完包直接用 Node 自己的解析器，从 `.app` 里 daemon 的**真实位置**
解析每一个 external：

```js
// /tmp/checkext.mjs
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
const daemonDir = process.argv[2];
const externals = process.argv.slice(3);
const require = createRequire(pathToFileURL(daemonDir + "/daemon.mjs"));
let bad = 0;
for (const name of externals) {
  try { require.resolve(name); console.log(`  ok      ${name}`); }
  catch (e) { console.log(`  MISSING ${name}  (${e.code})`); bad++; }
}
process.exit(bad === 0 ? 0 : 1);
```

```bash
APP=desktop/release/mac-arm64/ai2nao.app
node /tmp/checkext.mjs "$APP/Contents/Resources/app/out/daemon" \
  better-sqlite3 @lancedb/lancedb pyodide playwright @anthropic-ai/sandbox-runtime
```

实测输出：

```
  ok      better-sqlite3
  ok      @lancedb/lancedb
  ok      pyodide
  ok      playwright
  ok      @anthropic-ai/sandbox-runtime
exit=0
```

反向验证过它抓得住缺失（喂一个不存在的包名会 `MISSING ... (MODULE_NOT_FOUND)`
并 exit 1），所以这条检查不是摆设。

> **不要用 grep 代替它。** 试过
> `grep -oE 'from"[^"]+"' out/daemon/daemon.mjs`，结果既抓进了代码里的字符串字面量
> （`snapshot present`）和裸的 Node 内建（`fs`、`path`），又**漏掉了 `pyodide` 和
> `playwright`** —— 那两个是动态 `import()`，静态 grep 看不见。用真实解析器，别用
> 文本匹配。

## 相关

- [桌面版运行时与原生模块](./desktop-app-runtime-and-native-modules) —— 为什么不需要额外打一个 Node
- [桌面版手测清单](./desktop-manual-checklist) —— 自动化盖不到的部分
