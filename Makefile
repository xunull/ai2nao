# ai2nao 常用开发命令。用法:make <目标>(直接 make 看帮助)。
# 说明:全局 `ai2nao` 命令跑的是编译产物 dist/cli.js,所以 link 依赖 build;
# 改了 src/ 后要重新 `make link`(或 make build)才生效。详见 local-docs/npm-link.md。

.DEFAULT_GOAL := help
.PHONY: help install build build-web build-all link unlink dev test card

# 作息卡输出路径,可覆盖:make card OUT=~/Desktop/rhythm.svg
OUT ?= rhythm.svg

help: ## 列出所有命令
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
		| awk 'BEGIN{FS=":.*?## "}{printf "  \033[36m%-11s\033[0m %s\n", $$1, $$2}'

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

card: ## 生成作息热力图 SVG(默认 rhythm.svg;make card OUT=xx.svg 指定)
	npm run card:rhythm -- --out $(OUT)
