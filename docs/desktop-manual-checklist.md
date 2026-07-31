---
title: 桌面版手测清单
category: 调度与运维
order: 72
---
# 桌面壳手测清单

自动化盖不到的部分。`desktop/e2e/smoke.spec.ts` 覆盖了启动、引导页、沙箱、单实例；
下面这些要么依赖真实的系统 UI（托盘、通知中心、Cmd+Tab），要么依赖只有真人能造出来的
时序，只能手跑。

改动 `desktop/` 之后跑一遍。约 5 分钟。

## 准备

```bash
make shell-package            # 构建 dist/ + 打一个本地 .app（约 514MB）
open desktop/release/mac-arm64/ai2nao.app
```

**现在它是一个程序。** `.app` 里带着后台服务（`out/daemon/daemon.mjs` + 原生依赖），
启动时如果 8787 上没人在听，会自己 detached spawn 一个。你不需要先去终端敲
`ai2nao serve`。

两个环境变量，测试和排查都会用到：

| 变量 | 作用 |
|---|---|
| `AI2NAO_SHELL_NO_AUTOSTART=1` | 关掉自动启动（自己用 launchd 管服务时用） |
| `AI2NAO_SHELL_PORT=8788` | 固定探这个端口，跳过实例记录（配合 `serve --port`） |

> **一定要用打包版测通知。** macOS 的通知授权是按 bundle id 走的。开发模式
> （`make shell` / `npx electron out/main.js`）跑的是 Electron 自己的 bundle
> （`com.github.Electron`，显示名 `Electron`），系统从没问过你要不要允许它，
> 所以通知**根本不会出现**；就算你手动授权了，署名也是「Electron」而不是
> 「ai2nao」。打包版的 bundle id 是 `com.xunull.ai2nao`，这才是真身份。
>
> 只测启动/托盘/快捷键的话 `make shell` 就够了，快得多。

---

## 1. 单实例：双击两次只出一个

在壳已经跑着的情况下，再执行一次 `npx electron out/main.js`。

- [ ] 第二个进程立刻退出，**没有**出现第二个窗口
- [ ] 菜单栏只有一个 `ai2nao`
- [ ] 已有的窗口被唤到前面

> 为什么值得手测：`globalShortcut.register()` 在第二个进程里返回 `false` 但**不报错**。
> 症状是「快捷键有时候不灵」，而你会以为是壳写得不稳。

## 2. 全局快捷键：在别的 app 前台时也生效

切到浏览器或编辑器（**不要**让 ai2nao 在前台），按 `Cmd+Shift+Space`。

- [ ] 窗口从任意 app 前台被唤起
- [ ] 再按一次收起（toggle，不是只会弹出）
- [ ] 如果启动日志里有 `Could not register ...`，说明这个组合被别的 app 占了 —— 换一个再测

## 3. 身份：它是一个装在机器上的东西

- [ ] Dock 里有图标
- [ ] `Cmd+Tab` 能切到它
- [ ] 有自己的窗口标题和菜单，不共享浏览器的历史/缩放/扩展

## 4. 一体化：只启动 .app，整套起来

先确认 8787 上什么都没有（`lsof -ti tcp:8787 -sTCP:LISTEN` 输出为空），然后只双击 `.app`。

- [ ] 不用手动敲任何命令，界面里就有数据
- [ ] `lsof -ti tcp:8787 -sTCP:LISTEN | wc -l` 是 **1**（没起出两个）
- [ ] 再启动一次 `.app`：不会起第二个后台服务，pid 不变

## 5. 常驻：退出 app 之后后台还活着

**这条是整个设计的红线。** 从菜单栏选「退出 ai2nao（后台服务继续运行）」。

- [ ] `curl 127.0.0.1:8787/api/health` 仍然 200，**pid 不变**
- [ ] MCP 端点仍然可连：`npx @modelcontextprotocol/inspector`，或直接让 Claude Code 连一次 `tools/list`
- [ ] `curl 127.0.0.1:8787/api/scheduler/runs?limit=1` 仍然 200（定时任务宿主还在）
- [ ] 再打开 `.app`：直接连回同一个 pid，不新起

> 别用 `pkill -f "MacOS/ai2nao"` 来测这一条 —— 后台服务是用 `ELECTRON_RUN_AS_NODE`
> 跑的，进程名和壳一模一样，那条命令会把两个一起杀掉，然后你会以为红线破了。
> 用菜单栏退出，或者按 pid 精确杀。

## 6. 对称性：能停掉自己启动的东西

菜单栏 →「停止后台服务」。

- [ ] `/api/health` 不再应答
- [ ] `ls ~/.ai2nao/run/*.json` 为空（实例记录被撤回了，不是 SIGKILL 留下的残骸）

## 7. 端口被别人占：说得出是谁

```bash
# 先停掉 daemon，然后用别的东西占住端口
python3 -m http.server 8787
```

启动壳。

- [ ] 显示的是「端口被占用」页，**不是**「daemon 没在跑」
- [ ] 页面上给出了 `lsof -ti tcp:8787 -sTCP:LISTEN`
- [ ] 菜单栏 tooltip 写着 `8787 被别的程序占用`

## 8. 通知：署名是 ai2nao，不是 Script Editor

daemon 跑着、壳连上之后，造一条失败：

```bash
sqlite3 ~/.ai2nao/index.db "INSERT INTO scheduled_task_runs
  (task_key,trigger,started_at,finished_at,status,summary_json,error_summary)
  VALUES ('repos.scan','scheduled',datetime('now'),datetime('now'),'failed','{}','手测造的失败');"
```

等一个轮询周期（30 秒）。

- [ ] 通知弹出来了
- [ ] **署名是 ai2nao**（这一条是四个诉求里的「身份」，署名错了等于没做）
- [ ] 正文里有 `手测造的失败`，不是笼统的「有任务失败了」
- [ ] 首次启动壳时**没有**被历史通知刷屏（`scheduled_task_runs` 有十万行）

> macOS 第一次可能要在「系统设置 → 通知」里允许。这也是要手测的一部分 ——
> 一个默认被静音的通知等于没有通知。

---

## 已知不覆盖

- **签名与公证没做。** `.app` 是未签名的，只能自己用。发给别人会被 Gatekeeper 拦，
  那需要 Apple Developer Program（$99/年）。
- **只打了 arm64。** Intel Mac 要另加 target。
- **Cherry Studio 数据源在 `.app` 里用不了。** 它靠 `playwright` 起 chromium 读
  IndexedDB，而 chromium 是单独下载到 `~/Library/Caches` 的（约 150MB），没打进
  `.app`。机器上装过 playwright 浏览器的话它能用，否则会失败。
- **`.app` 是 514MB**，其中 `@lancedb/lancedb-darwin-arm64` 一个就 91MB（RAG 的
  向量库）。真要瘦身，那是第一个该看的地方。
- **自动启动路径没有自动化测试。** 烟雾测试全程 `AI2NAO_SHELL_NO_AUTOSTART=1`，
  因为让测试真的 spawn 一个 detached daemon 去动开发者的 `~/.ai2nao` 是不能接受的。
  这条靠上面第 4、5 节手测。

> 两颗打包地雷已拆除，记在这里免得重踩：
> 1. 壳原先 import `../../dist/serve/probeDaemon.js`，一个跨出自己包的相对路径，
>    在 `.app` 里必断。现在主进程和后台服务都由 esbuild 打成自包含产物
>    （`desktop/build.mjs`），构建期就解析掉了。
> 2. commander 看到 `process.versions.electron` 会自动切到 electron 解析模式，把
>    脚本路径当成子命令 —— 而后台服务正是用 `ELECTRON_RUN_AS_NODE` 跑的。已在
>    `src/cli.ts` 显式 `parseAsync(process.argv, { from: "node" })` 关掉。
