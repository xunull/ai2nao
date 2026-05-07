# AI 对话架构

本文记录 `/ai-chat` 的当前实现边界。AI 对话已经从 assistant-ui 切换为 CopilotKit，历史协议统一为 CopilotKit / AG-UI，旧 assistant-ui 数据在 schema v18 迁移中被主动清空。

## 目标

- 前端只使用 CopilotKit 的运行时和 `CopilotChat` 组件，不再维护影子消息、前端 sync 或 assistant-ui codec。
- SQLite 保存 AG-UI 原始消息，后端按 `threadId` 做会话隔离、恢复和持久化。
- 模型调用由 `/api/copilotkit` 承担，旧 `POST /api/llm-chat` 流式接口已删除。
- 当前版本只支持普通 system/user/assistant 文本消息；工具调用、前端 actions 和生成式 UI 显式拒绝。
- 输入框固定在对话工作台底部，长回答只滚动消息区，不推动页面布局。

## 前端边界

`web/src/pages/AiChat.tsx` 是唯一的 AI 对话页面：

- 通过 `/api/llm-chat/status` 和 `/api/rag/status` 展示本地模型与 RAG 状态。
- 通过 `/api/llm-chat/sessions` 做会话列表、创建、详情和删除。
- 使用 `CopilotKit runtimeUrl="/api/copilotkit"` 和 `CopilotChat threadId={activeSessionId}` 绑定当前会话。
- 切换会话时用 `key={activeSessionId}` 重建 CopilotKit chat，避免旧 thread 状态泄漏。
- 页面根容器固定 PC 桌面高度，`ai-chat-thread-shell` 承载滚动消息区和底部 composer。

`web/src/aiChat/sessionApi.ts` 只保留 session CRUD。不存在前端消息同步接口，消息持久化由 CopilotKit runtime 的 runner 在后端完成。

## 后端边界

`src/llmChat/routes.ts` 负责聚合路由：

- `src/llmChat/chatRoutes.ts`：只保留 `GET /api/llm-chat/status`。
- `src/llmChat/sessionRoutes.ts`：session CRUD。
- `src/llmChat/copilotRuntime.ts`：注册 `/api/copilotkit`，桥接 CopilotKit runtime、AI SDK 模型调用、RAG 上下文和 SQLite 持久化。

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
- `test/aiChat.sessionApi.test.ts`：前端 session CRUD API 映射。
- `test/App.test.tsx`：AI 对话页固定高度工作台和 CopilotKit 外壳。
- `e2e/ai-chat-history.spec.ts`：浏览器级工作台、会话创建/删除、跨会话 runtime 隔离。
