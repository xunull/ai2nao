import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { app } from "electron";

/**
 * 启动 daemon —— 但不拥有它。
 *
 * ## 为什么是「启动但不拥有」
 *
 * 这两件事经常被当成一件:
 *   - **启动一体化**:双击一个图标,整套东西起来。这是产品体验,应该做。
 *   - **生命周期一体化**:退出 app 就把后台一起杀掉。这个不能做。
 *
 * `serve` 不只是界面的后端。它同时托管着 `/mcp`(Claude Code / Codex 这些 agent
 * 连着它查你的开发数据)和 27 个定时任务。关掉窗口就把它们带走,「常驻」这条诉求
 * 当场消失 —— 而那是做这个壳的头号理由。
 *
 * 所以:`detached: true` + `unref()`,让 daemon 脱离壳的进程组。壳被 kill、被
 * 退出、被崩溃,daemon 都照常活着。真要停它,托盘里有单独一条。
 *
 * ## 为什么用 ELECTRON_RUN_AS_NODE 而不是带一个 node 二进制
 *
 * Electron 自己就带 Node。`ELECTRON_RUN_AS_NODE=1` 让同一个可执行文件以纯 Node
 * 语义运行,省掉一个 ~110MB 的二进制。代价是原生模块要匹配 Electron 的 ABI ——
 * electron-builder 会自动跑 @electron/rebuild 处理这件事(better-sqlite3 因此从
 * v11 升到了 v13:v11 的 C++ 编不过 Electron 43 的 V8)。
 *
 * 顺带一个坑:commander 看到 `process.versions.electron` 会自动切到 electron 解析
 * 模式,把脚本路径当成子命令。已在 src/cli.ts 里显式 `from: "node"` 关掉。
 */

const HERE = dirname(fileURLToPath(import.meta.url));

export type DaemonLaunchTarget = {
  /** 要执行的脚本 */
  script: string;
  /** 打包版用 Electron-as-Node,开发模式用外部 node */
  execPath: string;
  useElectronAsNode: boolean;
};

/**
 * 找到该跑哪个 daemon。
 *
 * 打包版:`.app` 里那份自包含 bundle,和壳同版本、同一次构建产出,不会漂移。
 * 开发模式:仓库的 `dist/cli.js`,这样改了 src/ 重新 build 就能试,不用打包。
 *
 * 两者都不去 PATH 里找 `ai2nao` —— 那可能是另一个版本,而版本错配的症状
 * (schema 不一致、接口对不上)排查起来远比「没找到」贵。
 */
export function resolveDaemonTarget(): DaemonLaunchTarget | null {
  if (app.isPackaged) {
    // out/daemon/daemon.mjs,和 out/main.js 是同一次 esbuild 的产物。
    const script = join(HERE, "daemon", "daemon.mjs");
    return existsSync(script)
      ? { script, execPath: process.execPath, useElectronAsNode: true }
      : null;
  }
  // 开发:desktop/ 的上一级就是仓库根。
  const script = join(HERE, "..", "..", "dist", "cli.js");
  return existsSync(script) ? { script, execPath: "node", useElectronAsNode: false } : null;
}

/**
 * 拉起一个 daemon,立刻返回(不等它监听成功)。
 *
 * 不等待是刻意的:调用方本来就要靠 `probeDaemon` 轮询确认,而 daemon 起来要跑迁移、
 * 开 898MB 的库,时间不定。用 probe 作为唯一的「活了没有」判据,比在这里猜一个超时
 * 更诚实,也少一处会撒谎的状态。
 *
 * 返回是否**尝试**了启动。真正是否成功由后续 probe 决定。
 */
/**
 * 关掉自动启动。
 *
 * 给两种人用:一种是自己用 launchd 管 daemon 的,不想让壳跟 launchd 抢着起第二个;
 * 一种是想先手动起一个带特定参数(`--db` / `--port` / `--api-only`)的实例再开壳。
 * 烟雾测试也靠它 —— 否则测试会真的拉起一个 daemon 去动开发者的 `~/.ai2nao`。
 */
export function autoStartDisabled(): boolean {
  return (process.env.AI2NAO_SHELL_NO_AUTOSTART ?? "").trim() !== "";
}

export function spawnDaemon(opts: { port: number }): boolean {
  if (autoStartDisabled()) return false;
  const target = resolveDaemonTarget();
  if (target === null) return false;

  const child = spawn(target.execPath, [target.script, "serve", "--port", String(opts.port)], {
    detached: true, // 脱离壳的进程组:壳死了它不跟着死
    stdio: "ignore", // 不持有管道,否则壳退出时它会拿到 EPIPE
    env: target.useElectronAsNode
      ? { ...process.env, ELECTRON_RUN_AS_NODE: "1" }
      : { ...process.env },
  });
  // 不让壳的事件循环因为这个子进程而不肯退出。
  child.unref();
  child.on("error", (e) => {
    console.error(`[ai2nao] 启动 daemon 失败: ${String(e)}`);
  });
  return true;
}

/**
 * 停掉一个 daemon(托盘里的「彻底停掉」)。
 *
 * 用 SIGTERM 而不是 SIGKILL:daemon 的关闭路径要停 scheduler、撤回
 * `~/.ai2nao/run/` 里的实例记录。SIGKILL 会留下一条指向死进程的记录,让下一次探活
 * 先走一遍「连不上 → 清理陈旧记录」的弯路。
 */
export function stopDaemon(pid: number): boolean {
  try {
    process.kill(pid, "SIGTERM");
    return true;
  } catch {
    return false; // 已经不在了
  }
}
