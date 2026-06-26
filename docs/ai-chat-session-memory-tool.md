---
title: AI Chat Session Memory Tool
category: 架构与 AI 对话
order: 20
---
# AI Chat Session Memory Tool

本文说明 `ai2nao_search_session_memory` 的实现原理、查询范围、触发方式和安全边界。它是 AI Chat 里的后端只读工具，用来让模型在回答“之前我们怎么决定的”“上次 Codex/Claude/Cursor 里做过什么”这类问题时，可以检索本机已有会话记录，而不是凭记忆猜。

## 目标

`ai2nao_search_session_memory` 解决的是“跨 AI 工具的本机会话记忆”问题：

- AI Chat 自己的历史在 `llm_chat_sessions` / `llm_chat_messages` 里。
- Codex、Claude Code、Cursor 都已经有各自的本地历史读取模块。
- 用户问到过往决策、实现方案、排查过程时，模型应该先查本机记录，再综合回答。

这个工具刻意选择轻量方案：不新增数据库、不新增 FTS 表、不把所有 transcript 预先灌进统一索引。它直接复用现有 history readers，在一次工具调用里按来源扫描最近一小批会话，返回短 evidence snippets。

## 架构位置

核心文件：

- `src/sessionMemory/types.ts`：定义来源、输入、限制、命中结构和 service 接口。
- `src/sessionMemory/service.ts`：实现跨来源搜索、打分、排序、snippet 截断和 evidence envelope。
- `src/sessionMemory/index.ts`：导出 service 和类型。
- `src/llmTools/sessionMemoryTool.ts`：把 service 包装成 AI SDK server-side tool。
- `src/llmTools/registry.ts`：根据 `forwardedProps` 统一注册本轮启用的 LLM tools。
- `src/llmTools/evidence.ts`：定义统一 evidence envelope，包含 `source: "session"`。
- `src/llmChat/copilotRuntime.ts`：把工具加入 system prompt 触发策略，并把 tool result 继续综合为最终回答。
- `web/src/pages/AiChat.tsx`：提供 `Memory` 开关，只传能力开关，不执行工具。
- `src/aiEvidence.ts`：兼容 re-export，旧 import 仍可使用。

数据流：

```text
AI Chat UI
  -> CopilotKit properties: { sessionMemoryEnabled, sessionMemoryTopK }
  -> /api/copilotkit
  -> ai2nao runAi2NaoTurnEvents
  -> buildAi2NaoServerTools
  -> ai2nao_search_session_memory
  -> createSessionMemoryService().search()
  -> AI Chat / Codex / Claude Code / Cursor readers
  -> AiEvidenceToolResult(source="session")
  -> streamText 后续步骤综合最终回答
```

关键边界：CopilotKit 只作为 UI 和 transport shell。前端没有注册业务 tools，也不能提供 client-side tools/page context/shared state；这些在 `validateAi2NaoCopilotInput` 中会被拒绝。`ai2nao_search_session_memory` 只在后端构建和执行。

## Tool 名称和输入

工具名：

```text
ai2nao_search_session_memory
```

输入 schema 在 `src/llmTools/sessionMemoryTool.ts`：

```ts
{
  query: string;
  reason?: string;
  count?: number;
  sources?: ("ai-chat" | "codex" | "claude-code" | "cursor")[];
}
```

字段含义：

- `query`：本机会话搜索关键词。service 会 trim、压缩空白，并限制到 400 字符。
- `reason`：模型说明为什么需要查会话记忆，仅用于 evidence envelope。
- `count`：最多返回多少条证据。默认 8，最大 12。
- `sources`：可选来源列表。不传时查全部来源：`ai-chat`、`codex`、`claude-code`、`cursor`。

## 如何触发

触发分两层：能力开关和模型决策。

### 1. UI 能力开关

`web/src/pages/AiChat.tsx` 顶栏有 `Memory` checkbox，默认开启：

```ts
const [useSessionMemory, setUseSessionMemory] = useState(true);
```

它传给 CopilotKit 的只是普通 properties：

```ts
properties={{
  useRag,
  ragTopK: 8,
  webSearchEnabled: effectiveWebSearch,
  sessionMemoryEnabled: useSessionMemory,
  sessionMemoryTopK: 8,
}}
```

后端 `parseForwardedToolProps` 只认布尔值：

```ts
sessionMemoryEnabled: props.sessionMemoryEnabled === true
```

如果 `sessionMemoryEnabled` 不是 `true`，`buildAi2NaoServerTools` 不会注册 `ai2nao_search_session_memory`。也就是说关闭 Memory 后，这个 tool 在该 turn 里根本不存在。

### 2. 模型触发策略

当 Memory 开启时，`ai2NaoSystemPrompt` 会加入触发提示：

```text
When the user asks about previous ai2nao, Codex, Claude Code, or Cursor conversations or decisions,
call ai2nao_search_session_memory before answering.
```

适合触发的用户问题：

- “之前我们怎么设计 web search 的？”
- “上次 Codex 里为什么选 B 方案？”
- “Claude Code 那边有没有做过这个 bug 的排查？”
- “Cursor 里我之前是不是改过这个页面？”
- “帮我找一下上次讨论 session memory 的结论。”

不适合触发的情况：

- 用户问当前实时信息，应走 `ai2nao_web_search`。
- 用户问已入库文档、笔记、项目资料，应走 `ai2nao_search_rag_evidence`。
- 用户只是普通聊天，没有引用历史上下文，不需要查。

## 查询了哪些内容

Session Memory 目前查询四类本机来源。

### AI Chat

入口：

- `listLlmChatSessions(db, limits.aiChatSessions)`
- `getLlmChatSession(db, summary.id)`

读取内容：

- `llm_chat_sessions.title`
- `llm_chat_sessions.last_message_at` / `updated_at`
- `llm_chat_messages.plain_text`
- `llm_chat_messages.preview`
- `llm_chat_messages.role`

限制：

- 最多扫描最近 100 个 AI Chat session。
- 每个 session 会读取详情消息，但只保留当前 session 中分数最高的一条命中。

### Codex

入口：

- `listCodexSessionSummaries(undefined, { archived: false, limit, maxFiles })`
- `loadCodexSessionDetail(undefined, summary.id)`

读取内容：

- Codex state DB 里的 thread summary：title、cwd、branch、model、first user message 等。
- Codex JSONL transcript 解析后的 normalized messages。
- workspace path / cwd 作为 evidence path。

限制：

- 只查未归档会话。
- 最多扫描 40 个 Codex sessions。
- fallback transcript 文件最多扫描 300 个。
- 单个 detail 读取失败时降级到 summary 搜索，不让整个工具失败。

### Claude Code

入口：

- `resolveClaudeProjectsRoot()`，默认 `~/.claude/projects`
- `listProjects(root)`
- `listSessionSummaries(root, project.id)`
- `loadSessionDetail(root, project.id, summary.id)`

读取内容：

- Claude Code project slug / workspace path。
- 每个 project 的 session summary。
- Claude JSONL transcript 解析后的 normalized messages。

限制：

- 最多扫描 20 个 Claude projects。
- 每个 project 最多扫描 20 个 sessions。
- 单个 project/session 读取失败会跳过或降级，不影响其他来源。

### Cursor

入口：

- `searchCursorSessions(request.query, { limit, contextChars })`
- `getCursorSession(result.index)`

读取内容：

- Cursor 的 chat summaries。
- Cursor 的 message snippets。
- session title、workspace path、last updated time。

限制：

- 最多返回 20 个 Cursor search results。
- snippet context 大约是 service snippet 预算的一半。
- Cursor 搜索复用现有 `cursorHistory` 模块，不直接读 SQLite 表细节。

## 搜索和排序原理

这个工具不是 FTS，也不是 embedding search。它是一个有预算的关键词扫描器。

### 输入归一化

`normalizeInput` 做几件事：

- `query.trim().replace(/\s+/g, " ")`
- query 最大 400 字符。
- `count` 默认 8，最大 12。
- `sources` 只允许四个已知枚举。
- 把 query 拆成最多 8 个 token，用于宽松匹配。

token 规则：

```ts
queryLower.split(/[^\p{L}\p{N}_-]+/u)
```

这允许中英文、数字、下划线、连字符参与匹配。

### 每个来源产出统一 hit

不同来源最终都会转成：

```ts
type SessionMemoryHit = {
  source: "ai-chat" | "codex" | "claude-code" | "cursor";
  sessionId: string;
  title: string;
  snippet: string;
  score: number;
  workspacePath?: string;
  role?: string;
  updatedAt?: string;
};
```

这样后续排序和 evidence 封装不用关心来源差异。

### 打分规则

`scoreText` 的逻辑很直接：

- 如果文本包含完整 `queryLower`，加 24 分。
- 每个 token 命中再加分：
  - token 长度大于等于 4，加 5 分。
  - 否则加 3 分。

消息角色还有轻微 boost：

- `user`: +2
- `assistant`: +1

最终排序：

1. `score` 高的在前。
2. 分数相同，`updatedAt` 更新的在前。

### snippet 截取

`snippetAround` 会优先围绕完整 query 截取；如果找不到完整 query，就围绕第一个命中的 token 截取。返回文本会压缩空白，最大约 700 字符。

目的不是展示完整聊天记录，而是给模型一个可引用、可综合的局部证据。

## Tool 返回格式

成功时返回统一 evidence envelope：

```ts
{
  ok: true,
  kind: "evidence",
  source: "session",
  query,
  reason,
  generatedAt,
  evidence: [
    {
      id,
      source: "session",
      title,
      path,
      snippet,
      rank,
      provider,
      fetchedAt,
      matchedBy: ["session-memory", provider]
    }
  ],
  meta: {
    provider: "session-memory",
    durationMs,
    warnings?
  }
}
```

字段说明：

- `source: "session"`：区分于 RAG 的 `local` 和 Web Search 的 `web`。
- `provider`：具体来源，可能是 `ai-chat`、`codex`、`claude-code`、`cursor`。
- `title`：带来源前缀，例如 `Codex: Session memory plan`。
- `path`：优先用 workspace path；没有时用 `${source}:${sessionId}`。
- `snippet`：短证据片段，可能带 `user:` / `assistant:` 角色前缀。
- `warnings`：某些来源失败时记录，例如 Cursor SQLite locked，但只要其他来源有结果，整体仍返回 `ok: true`。

失败时返回：

```ts
{
  ok: false,
  kind: "evidence_error",
  source: "session",
  code,
  message,
  recoverable
}
```

典型错误：

- `invalid_query`：query 为空。
- `invalid_sources`：sources 为空或全被过滤。
- `aborted`：请求被取消。
- `session_memory_unavailable`：所有被请求的来源都搜索失败。

## 安全和隐私边界

这个工具只读本机文件和本机 SQLite，不访问网络。

关键约束：

- 不新增统一索引，不复制 transcript 到新库。
- 不返回完整会话，只返回短 snippets。
- 默认每次只查有限数量的最近 session。
- 单个来源失败不暴露敏感堆栈，只进入 `meta.warnings`。
- system prompt 明确要求模型不要引用或重建完整 transcript。
- 前端只传开关，不上传页面 context、shared state 或 frontend tools。

注意：它仍然会读取本机 AI 会话历史，因此 UI 上保留了 `Memory` 开关。关闭后 tool 不会注册，模型无法调用它。

## 和 RAG / Web Search 的区别

| Tool | Evidence source | 适用问题 | 是否联网 | 是否预建索引 |
|------|-----------------|----------|----------|--------------|
| `ai2nao_search_rag_evidence` | `~/.ai2nao/rag.db` | 已入库文档、笔记、项目资料 | 否 | 是 |
| `ai2nao_web_search` | Public web provider | 当前外部信息、互联网事实 | 是 | 否 |
| `ai2nao_search_session_memory` | AI Chat / Codex / Claude Code / Cursor histories | 过往会话、决策、排查记录 | 否 | 否 |

Session Memory 不是 RAG 的替代品。它更像“最近 AI 工作痕迹的只读检索器”。如果某类历史需要长期、高召回、语义检索，后续可以再考虑把它纳入 RAG ingest，而不是让这个 tool 变重。

## 测试覆盖

当前测试重点：

- `test/sessionMemory.test.ts`
  - 能搜索持久化的 AI Chat session。
  - 空 query 返回 `invalid_query`。
  - 一个来源失败时，其他来源命中仍能返回，并在 `meta.warnings` 记录失败来源。
- `test/llmChat.copilotRuntime.run.test.ts`
  - `forwardedProps.sessionMemoryEnabled = true` 时注册 `ai2nao_search_session_memory`。
  - 未启用 Web Search 时不会顺手注册 `ai2nao_web_search`。
- `test/App.test.tsx`
  - AI Chat 工作台外壳仍然稳定渲染。

## 当前限制

- 关键词扫描，不支持语义检索。
- Cursor 目前复用既有 `searchSessions`，它的匹配行为由 Cursor history 模块决定。
- Claude Code projects 是按 project 目录枚举，不做全量排序优化。
- 默认只扫最近一批 session，查不到很旧内容是预期行为。
- evidence path 不是统一可点击 URL；部分来源只能提供 workspace path 或 `source:sessionId`。

## 后续可选增强

- 增加 `/api/session-memory/status`，显示各来源是否可读、最近扫描预算和错误摘要。
- 给 tool result 增加 `sessionId` / `source` 结构化字段，便于 UI 做“打开原会话”。
- 支持按 workspace path 过滤，例如只查当前仓库相关 Codex/Claude/Cursor 记录。
- 支持更稳的 tokenization 和中文分词。
- 当某类 session memory 成为高频需求时，设计增量索引或接入 RAG，而不是继续扩大本工具的扫描预算。
