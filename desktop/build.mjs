import { build } from "esbuild";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 把「壳」和「daemon」各打成一个自包含产物，放进 out/。
 *
 * ## 为什么要打包，而不是直接 tsc
 *
 * 壳 import 的是仓库根的 `../../dist/`，一条伸出自己包外的相对路径。在一个
 * checkout 里能跑，打进 .app 的那一刻就断 —— `.app` 上面没有 `../../dist`。
 * esbuild 在构建期把这些 import 解析掉，产物自己带着代码走。tsc 做不到这件事，
 * 它原样输出 import。
 *
 * daemon 同理，而且收益更大：`ai2nao` 的 dependencies 里有 37 个包、装出来
 * 948MB，但其中一大半（mermaid / copilotkit / lucide / streamdown …）是**前端**
 * 依赖，早被 Vite 编进 web/dist 了，daemon 运行时根本不碰。打一遍之后整个
 * daemon 是 10MB 一个文件，只剩 5 个真正外部化不掉的原生 / wasm 依赖。
 *
 * ## 为什么两个都出 ESM
 *
 * 产物里含 `src/path/packageRoot.ts`，它靠 `import.meta.url` 定位安装根。
 * esbuild 在 CJS 下无法表达 import.meta，只会警告并生成一旦走到就坏的代码。
 * Electron 自 v28 起原生支持 ESM 主进程，所以没有理由退回 CJS。
 *
 * daemon 的 bundle 需要额外注入一个真的 `require`：commander 这类 CJS 包内部
 * 会 `require("node:events")`，而 esbuild 在 ESM 输出里给的 __require shim 对
 * 内建模块直接抛错。
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..");
const OUT = join(HERE, "out");

/**
 * daemon 里外部化不掉的东西：原生 .node 二进制和 wasm 资产。
 * 它们必须以真实文件的形式躺在 .app 里（且在 asar 之外）。
 */
const DAEMON_EXTERNALS = [
  "better-sqlite3", // 原生
  "@lancedb/lancedb", // 原生（napi-rs）
  "pyodide", // wasm + 一堆运行时资产
  "playwright", // 会起 chromium 读 Cherry Studio 的 IndexedDB
  "@anthropic-ai/sandbox-runtime", // bash 工具的沙箱
];

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

// ---- 壳 ----
await build({
  entryPoints: [join(HERE, "src/main.ts")],
  outfile: join(OUT, "main.js"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  external: ["electron"],
  sourcemap: true,
  logLevel: "info",
});

// ---- daemon ----
await build({
  entryPoints: [join(REPO, "src/cli.ts")],
  outfile: join(OUT, "daemon/daemon.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  external: DAEMON_EXTERNALS,
  banner: {
    js: "import{createRequire as __cr}from'node:module';const require=__cr(import.meta.url);",
  },
  sourcemap: true,
  logLevel: "info",
});

/**
 * daemon 旁边要有一个 name=ai2nao 的 package.json。
 *
 * 不是装饰：`src/path/packageRoot.ts` 靠向上查找 `name === "ai2nao"` 的
 * package.json 来定位安装根，而安装根决定了 `resolveWebDist()` 去哪里找 SPA、
 * `packageVersion()` 报什么版本。少了它，打包后的 daemon 会一路走到文件系统根
 * 也找不到，然后抛错退出。
 *
 * 版本号从仓库根同步过来，避免出现两个各自漂移的版本。
 */
const rootPkg = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8"));
writeFileSync(
  join(OUT, "daemon/package.json"),
  `${JSON.stringify(
    {
      name: "ai2nao",
      version: rootPkg.version,
      private: true,
      type: "module",
      _comment:
        "自动生成。packageRoot() 靠它定位安装根(进而定位 web/dist)。见 desktop/build.mjs。",
    },
    null,
    2
  )}\n`
);

// SPA 必须挨着 daemon 的 package.json，因为 resolveWebDist() 解析的是
// <packageRoot>/web/dist。仓库根先构建过才有这个目录。
cpSync(join(REPO, "web/dist"), join(OUT, "daemon/web/dist"), { recursive: true });

console.log("  out/daemon/  (daemon.mjs + package.json + web/dist)");
