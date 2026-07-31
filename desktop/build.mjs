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
 * 不打进 bundle、留给运行时从 node_modules 解析的包。
 *
 * 判据只有一条:**这个包必须在运行时以一个真实目录的形式存在于磁盘上。**
 * 下面每一条都注明了它属于哪种情况 —— 有的是物理上打不进去,有的是打得进去但
 * 打进去就会坏,还有一条纯粹是保守。加新条目前先确认属于哪一类,别凭感觉加。
 */
const DAEMON_EXTERNALS = [
  // 【原生二进制】.node 是编译产物,没法内联进 JS。
  "better-sqlite3",
  // 【原生二进制】同上,真正的 .node 在它的 optionalDependency
  // @lancedb/lancedb-darwin-arm64 里(napi-rs 出的)。
  "@lancedb/lancedb",
  // 【自定位资产】src/codeRunner/pyodideWorker.ts:54 用
  // `import.meta.resolve("pyodide")` 找自己的安装目录,再从那里加载
  // pyodide.asm.wasm 和 python 标准库。打进 bundle 之后这个 resolve 就没有
  // 目录可指 —— esbuild 能构建成功,但跑 Python 的时候才炸。
  "pyodide",
  // 【构建期就打不进去】playwright-core 里 require 了 chromium-bidi,而那是个
  // 没被安装的可选依赖,esbuild 直接报 Could not resolve 并失败。
  "playwright",
  // 【保守】实测它其实**可以**打进去:没有自定位逻辑,没有非 JS 资产,唯一的
  // spawn 是去起沙箱命令而不是自己的文件。留在外面只为省事和稳妥 —— 它是安全
  // 相关组件,而 3.6MB 不值得为它冒一个「有没有我没查到的动态 require」的险。
  // 要减重的话这是可以先动的一条。
  "@anthropic-ai/sandbox-runtime",
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
