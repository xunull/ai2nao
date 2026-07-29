# 桌面壳手测清单

自动化盖不到的部分。`desktop/e2e/smoke.spec.ts` 覆盖了启动、引导页、沙箱、单实例；
下面这些要么依赖真实的系统 UI（托盘、通知中心、Cmd+Tab），要么依赖只有真人能造出来的
时序，只能手跑。

改动 `desktop/` 之后跑一遍。约 5 分钟。

## 准备

```bash
npm run build:server          # 仓库根：壳 import 的是 dist/
cd desktop && npm run build && npx electron out/main.js
```

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

## 4. 常驻：关掉窗口它还活着

关掉窗口（**不是**退出 app）。

- [ ] 菜单栏图标还在
- [ ] `curl 127.0.0.1:8787/api/health` 仍然 200，pid 不变
- [ ] MCP 端点仍然可连：`npx @modelcontextprotocol/inspector` 或直接让 Claude Code 连一次 `tools/list`
- [ ] 点菜单栏「显示窗口」，窗口回来

> 这条是整个设计的红线：壳退出**绝不能**带走 daemon。它同时是别的 agent 的记忆器官。

## 5. 端口被别人占：说得出是谁

```bash
# 先停掉 daemon，然后用别的东西占住端口
python3 -m http.server 8787
```

启动壳。

- [ ] 显示的是「端口被占用」页，**不是**「daemon 没在跑」
- [ ] 页面上给出了 `lsof -ti tcp:8787 -sTCP:LISTEN`
- [ ] 菜单栏 tooltip 写着 `8787 被别的程序占用`

## 6. 通知：署名是 ai2nao，不是 Script Editor

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

**打包后的 `.app` 完全没有验证过。** Approach A 明确不分发（「壳只给自己用，本地构建」），
所以现在没有 `.app` 可测。

真要打包之前必须先解决一件事：`desktop/src/main.ts` import 的是 `../../dist/serve/probeDaemon.js`
—— 一个跨出自己包的相对路径。在仓库里能跑，**在任何打包形态下都会断**。届时要么把
`ai2nao` 作为真实依赖装进 `desktop/`，要么把用到的模块打进壳的产物里。
