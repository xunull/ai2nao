# ai2nao 常用开发命令。用法:make <目标>(直接 make 看帮助)。
# 说明:全局 `ai2nao` 命令跑的是编译产物 dist/cli.js,所以 link 依赖 build;
# 改了 src/ 后要重新 `make link`(或 make build)才生效。详见 local-docs/npm-link.md。

.DEFAULT_GOAL := help
.PHONY: help install build build-web build-all link unlink dev test card card-calendar card-bundle \
        shell shell-test shell-package app app-restart

# 打包产物路径,与 desktop/package.json 的 build.directories.output(release)+
# build.productName(ai2nao)对应。换架构或改了 productName 要同步。
APP_PATH ?= desktop/release/mac-arm64/ai2nao.app
PORT ?= 8787

# 卡片输出路径可覆盖:make card OUT=x.svg / make card-calendar OUT=y.svg
# 整套发布包目录可覆盖:make card-bundle OUT_DIR=~/ai2nao-cards

help: ## 列出所有命令
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
		| awk 'BEGIN{FS=":.*?## "}{printf "  \033[36m%-14s\033[0m %s\n", $$1, $$2}'

install: ## 安装依赖(npm install)
	npm install

build: ## 编译后端 CLI/服务(tsc → dist/)
	npm run build:server

build-web: ## 构建前端(vite)
	npm run build:web

build-all: ## 前后端全构建
	npm run build

link: build ## 构建并全局链接 ai2nao 命令(先 build 再 npm link)
	npm link
	@echo "已链接:任何目录可用 ai2nao …(改了 src/ 记得重跑 make link)"

unlink: ## 取消全局链接
	npm unlink -g ai2nao || true

dev: ## 起本地服务(tsx watch,:8787)
	npm run dev:api

test: ## 跑测试(vitest run)
	npm test

# 桌面壳是独立包(desktop/,自己的 package.json + electron)。首次要先 cd desktop && npm install。
#
# 三个目标的前置都必须是 build-all,不能是 build。
# 原因:desktop/build.mjs 是把仓库根的 web/dist **拷贝**进 .app(那一行是
# `cpSync(join(REPO, "web/dist"), join(OUT, "daemon/web/dist"))`),它自己不构建前端。
# 前置写成只编后端的 build,打出来的 .app 里就是上次不知何时留下的旧前端 —— 2026-08 那个
# 停在 8-01、三重过期的 .app 就是这么来的:不是谁忘了跑命令,是命令本身不含前端。
shell: build-all ## 起桌面壳的开发模式(前后端全构建,再跑 Electron)
	cd desktop && npm run start

shell-test: build-all ## 跑桌面壳的烟雾测试(Playwright + Electron)
	cd desktop && npm run build && npm run test:e2e
	@echo "手测清单(自动化盖不到的托盘/快捷键/通知):docs/desktop-manual-checklist.md"

# 未签名、未公证、不发布 —— 只为拿到自己的 bundle id(com.xunull.ai2nao)。
# macOS 的通知授权按 bundle id 走:开发模式跑的壳身份是 com.github.Electron,
# 通知会署名 "Electron" 甚至根本不显示。
shell-package: build-all ## 打一个本地 .app(desktop/release/,不签名不分发)
	cd desktop && npm run package
	@echo "产物:desktop/release/mac-arm64/ai2nao.app —— 双击即可,首次会问通知权限。"

# 一条龙:重新构建 → 重新打包 → 打开。改完代码想在桌面版上看效果就跑这个。
#
# 关旧壳用 osascript 而**不是** pkill -f。壳和 daemon 是同一个可执行文件
# (desktop/src/daemonProcess.ts 用 ELECTRON_RUN_AS_NODE=1 把它当纯 Node 跑),
# `pkill -f .../MacOS/ai2nao` 会把常驻 daemon 一起杀掉。osascript 发的是 GUI quit 事件,
# daemon 没有 GUI,收不到 —— 正好只关壳。
# 不先关的话 open 只会把旧窗口拉到前台,你会以为新代码没生效。
app: shell-package ## 重新构建 + 打包 + 打开 .app(只换壳,daemon 复用)
	-osascript -e 'quit app "ai2nao"' 2>/dev/null || true
	open "$(APP_PATH)"
	@echo "已打开 $(APP_PATH)"

# daemon 是 detached 的,关壳不会带走它 —— 所以改了后端(src/)光 make app 看不到效果。
# 按端口杀而不是按进程名:进程名和壳一模一样,按名字杀会误伤(见上)。
app-restart: ## 连 daemon 一起换掉(适用于改了 src/ 后端)
	-osascript -e 'quit app "ai2nao"' 2>/dev/null || true
	-lsof -ti tcp:$(PORT) | xargs kill 2>/dev/null || true
	@$(MAKE) --no-print-directory app

card: ## 生成作息热力图 SVG(默认 rhythm.svg;make card OUT=xx.svg)
	npm run card:rhythm -- --out $(or $(OUT),rhythm.svg)

card-calendar: ## 生成活动日历 SVG(GitHub 贡献图式,默认 calendar.svg)
	npm run card:calendar -- --out $(or $(OUT),calendar.svg)

card-bundle: ## 生成全部卡片 SVG + README 到目录(默认 ./cards;make card-bundle OUT_DIR=~/x)
	npm run card:bundle -- --out-dir $(or $(OUT_DIR),cards)
