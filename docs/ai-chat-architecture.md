---
title: AI 对话架构
category: 架构与 AI 对话
order: 10
---
# AI 对话架构

本文记录 `/ai-chat` 的当前实现边界。AI 对话已经从 assistant-ui 切换为 CopilotKit，历史协议统一为 CopilotKit / AG-UI，旧 assistant-ui 数据在 schema v18 迁移中被主动清空。

## 目标

- 前端只使用 CopilotKit 的 `CopilotChat` 组件和 CopilotKit / AG-UI transport，不再维护影子消息、前端 sync 或 assistant-ui codec。
- SQLite 保存 AG-UI 原始消息，后端按 `threadId` 做会话隔离、恢复和持久化。
- 模型调用由 `/api/copilotkit` 承担，旧 `POST /api/llm-chat` 流式接口已删除。
- AI-callable tools 只允许在后端构建；前端 actions、前端 tools、页面 context、shared state 和生成式 UI 显式拒绝。
- 输入框固定在对话工作台底部，长回答只滚动消息区，不推动页面布局。

## 前端边界

`web/src/pages/AiChat.tsx` 是唯一的 AI 对话页面：

- 通过 `/api/llm-chat/status`、`/api/rag/status` 和 `/api/web-search/status` 展示本地模型、RAG 与 Web Search 状态。
- 通过 `/api/llm-chat/sessions` 做会话列表、创建、详情和删除。
- 顶栏只传能力开关：RAG、Web Search、Memory、Code。业务 tool 执行仍由后端 runner 决定。
- 使用 `CopilotKit runtimeUrl="/api/copilotkit"` 和 `CopilotChat threadId={activeSessionId}` 绑定当前会话。
- 切换会话时用 `key={activeSessionId}` 重建 CopilotKit chat，避免旧 thread 状态泄漏。
- 页面根容器固定 PC 桌面高度，`ai-chat-thread-shell` 承载滚动消息区和底部 composer。

`web/src/aiChat/sessionApi.ts` 只保留 session CRUD。不存在前端消息同步接口，消息持久化由 ai2nao 后端 turn runner 完成；CopilotKit runtime 只负责 transport 层生命周期和 SSE 输出。

## 后端边界

`src/llmChat/routes.ts` 负责聚合路由：

- `src/llmChat/chatRoutes.ts`：只保留 `GET /api/llm-chat/status`。
- `src/llmChat/sessionRoutes.ts`：session CRUD。
- `src/llmChat/copilotRuntime.ts`：注册 `/api/copilotkit`，用 CopilotKit runtime 做最薄 transport adapter，并把实际模型调用、server-side tools、RAG/Web Search/Session Memory、最终回答兜底和 SQLite 持久化交给 ai2nao 自己的 turn runner。
- `src/llmChat/model.ts`：根据 `~/.ai2nao/llm-chat.json` 里的 `provider` 显式选择 AI SDK provider。DeepSeek 官方 API 走 `@ai-sdk/deepseek`，Moonshot/Kimi 走 `@ai-sdk/moonshotai`，Alibaba Cloud DashScope/Qwen 走 `@ai-sdk/alibaba`，OpenAI 走 `@ai-sdk/openai`，LM Studio/Ollama/代理网关等通用接口走 `@ai-sdk/openai-compatible`。
- `src/llmTools/`：按 `forwardedProps` 构建后端 AI SDK tools，目前包括 `ai2nao_search_rag_evidence`、`ai2nao_web_search`、`ai2nao_search_session_memory` 和 `ai2nao_run_code`。这里是 LLM tool adapter/registry 层，不承载完整业务能力实现。
- `src/sessionMemory/service.ts`：只读搜索现有 AI Chat、Codex、Claude Code、Cursor 会话来源，返回短 evidence snippets；不新增索引、不回传完整 transcript。
- Session Memory tool 的实现细节、查询范围和触发规则见 [`docs/ai-chat-session-memory-tool.md`](ai-chat-session-memory-tool.md)。
- `src/codeRunner/service.ts`：通过短生命周期 Worker 启动 Pyodide/WASM Python 沙盒，只允许内联代码和内联小文件，不开放 shell、宿主文件系统、网络或包安装。
- `src/codeRunner/dockerRunner.ts`：可选 Docker Python runtime，仅在用户显式选择 Docker Code 时启用；通过固定 `docker run` 参数限制网络、CPU、内存、PID 和容器权限。
- `src/codeRunner/routes.ts`：提供 `GET /api/code-runner/status`，用于前端判断 Docker 是否可用、镜像是否已准备。
- Code Runner tool 的实现细节、触发规则和安全边界见 [`docs/llm-run-code-tool.md`](llm-run-code-tool.md)。

`src/llmChat/sessions.ts` 是协议无关的 AG-UI 持久化层：

- `ensureLlmChatSession` 按 `threadId` 保证会话存在。
- `agUiMessagesFromSession` 从 SQLite 恢复 AG-UI 消息。
- `replaceLlmChatSessionMessages` 原子替换当前 session 的消息快照并更新标题、计数和时间戳。
- `textFromAgUiMessage` 只派生列表预览文本，不参与模型协议拼接。

## 数据迁移

schema v18 会删除并重建：

- `llm_chat_sessions`
- `llm_chat_messages`

这是一次有意的破坏性迁移，用来彻底移除 assistant-ui 历史结构，避免旧 `UIMessage.parts` 与 CopilotKit / AG-UI 消息混用。

## 关键测试

- `test/llmChat.sessions.test.ts`：AG-UI session 创建、列表、详情、持久化和 schema v18。
- `test/llmChat.chatRoutes.test.ts`：`GET /api/llm-chat/status`。
- `test/sessionMemory.test.ts`：Session Memory evidence envelope、AI Chat 命中、坏输入和局部来源失败降级。
- `test/codeRunner.test.ts`：Pyodide/WASM Python 执行、MEMFS 文件、路径校验、JS bridge/import block、timeout。
- `test/dockerRunner.test.ts`：Docker runtime 默认禁用、docker run 安全参数、spawn 参数化执行。
- `test/llmChat.copilotRuntime.run.test.ts`：server-side tools 注册、Web/Search final-answer 兜底、拒绝 client-provided CopilotKit tools/context/state。
- `test/aiChat.sessionApi.test.ts`：前端 session CRUD API 映射。
- `test/App.test.tsx`：AI 对话页固定高度工作台和 CopilotKit 外壳。
- `e2e/ai-chat-history.spec.ts`：浏览器级工作台、会话创建/删除、跨会话 runtime 隔离。
