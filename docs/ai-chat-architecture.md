# AI 对话架构

本文记录 `/ai-chat` 的当前实现边界，重点防止会话串线、历史恢复清空、以及发送给 AI SDK 的消息协议退化。

## 目标

- UI 运行时只交给 assistant-ui / AI SDK 管理，不在页面组件里拼接影子消息。
- 本地历史保存 assistant-ui `UIMessage` 原始结构，恢复时优先使用 `raw_json`。
- 每次会话切换必须是原子的：恢复成功后才 reset 当前 thread；恢复失败时保留当前对话。
- 前后端都做严格消息校验，缺少 `parts` 的消息不能进入模型调用或本地存储。
- 输入框固定在 thread workbench 底部，长回答只滚动消息区，不推动整个页面。

## 前端边界

`web/src/pages/AiChat.tsx` 只负责创建 `AssistantChatTransport` 和页面布局。`prepareSendMessagesRequest` 直接转发 AI SDK 提供的 `options.messages`，只附加 `useRag`、`ragTopK` 等请求配置。

`web/src/aiChat/useAiChatThreads.ts` 是会话适配层：

- 读取 assistant-ui runtime messages。
- 600ms debounce 自动保存，切换、新建、删除前主动 flush。
- 用 generation token 和 `AbortController` 避免过期请求回写状态。
- `selectSession` 先请求详情、校验并恢复消息，成功后才切换到 fresh runtime 并设置 restored base。
- 由于 assistant-ui 的 AI SDK runtime 不能稳定同步重灌本地历史，`runtimeBridge` 会保存当前会话的 restored base；展示、后续模型请求、自动保存都会把 restored base 与新 runtime 消息合并，保证会话上下文不丢也不串线。
- 暴露 `idle/loading/restoring/saving/saved/save_error/restore_error` 给 UI 展示。

`web/src/aiChat/messageCodec.ts` 是前端消息 codec：

- `encodeMessageForSync` 只接受合法 assistant-ui `parts` 消息。
- `restoreSessionMessages` 从 `raw_json` 恢复完整消息；只有 raw json 解析失败时才用 `plain_text` 兜底。
- 如果 raw json 结构存在但协议非法，恢复返回错误，hook 不切换当前 thread。

## 后端边界

`src/llmChat/routes.ts` 只是聚合器：

- `src/llmChat/chatRoutes.ts`：`/api/llm-chat/status` 和 `/api/llm-chat`。
- `src/llmChat/sessionRoutes.ts`：session CRUD 与 sync。

`src/llmChat/messageCodec.ts` 是后端消息 codec：

- `validateLlmChatUiMessages` 校验 `id`、`role`、`parts`、text/file/reasoning part 的必要字段。
- chat route 在调用 `convertToModelMessages` 和 `streamText` 前先校验消息。
- session sync 在落库前校验消息，`raw_json` 保存完整 UIMessage，`plain_text` 只作为列表和标题展示派生值。

## 关键测试

- `test/llmChat.messageCodec.test.ts`：后端 codec。
- `test/aiChat.messageCodec.test.ts`：前端恢复与编码。
- `test/llmChat.chatRoutes.test.ts`：协议级 route 测试，非法消息不会调用模型。
- `test/aiChat.useAiChatThreads.test.tsx`：hook harness，覆盖原子恢复、非法恢复不清空当前 thread、自动保存只发送 `parts`。
- `e2e/ai-chat-history.spec.ts`：浏览器级保存、恢复、删除和跨会话隔离。
