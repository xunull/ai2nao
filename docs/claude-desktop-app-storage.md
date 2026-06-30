---
title: Claude 桌面 app 对话存储调查（为何标准聊天无法本地索引）
category: 数据源与同步
order: 65
---
# Claude 桌面 app 对话存储调查（为何标准聊天无法本地索引）

> 调查目的：能不能像索引 Claude Code **CLI** 的 JSONL 那样，把 **Claude 桌面 app**
> （不是 CLI，是那个能开很多 chat 的桌面客户端）里的"标准聊天"也纳入 ai2nao？
>
> 结论：**不能直接做——标准聊天不存本地，在 claude.ai 服务器端。** 本地只有
> 草稿状态和另一类东西（app 内置 agent/cowork 模式）。功能已搁置。
>
> 调查时间：2026-06-30（/office-hours）。本文记录证据，避免以后重复扒。

---

## 1. 桌面 app 在哪、存储长什么样

Claude 桌面 app 是个 **Electron 应用**（bundle id `com.anthropic.claudefordesktop`，
**未沙盒**，没有 `~/Library/Containers/` 目录）。它在 webview 里加载 `https://claude.ai`。

数据目录：`~/Library/Application Support/Claude/`

```
~/Library/Application Support/Claude/
├── IndexedDB/
│   ├── https_claude.ai_0.indexeddb.leveldb/   ← claude.ai 这个 origin 的 IndexedDB
│   └── https_claude.ai_0.indexeddb.blob/
├── Local Storage/leveldb/
├── Session Storage/ · WebStorage/ · shared_proto_db/ · blob_storage/
├── Cache/ · Code Cache/ · GPUCache/           ← Electron/Chromium 各类缓存
├── claude-code-sessions/                      ← app 内置 agent 模式（见 §3）
├── local-agent-mode-sessions/                 ← 同上
├── claude_desktop_config.json                 ← MCP 等配置，不含对话
└── ...（Cookies / Preferences / sentry 等）
```

辅助目录（也无对话历史）：`~/Library/Caches/com.anthropic.claudefordesktop`、
`~/Library/HTTPStorages/com.anthropic.claudefordesktop`、`~/Library/Logs/Claude`。

---

## 2. 实测：标准聊天**不在本地**

把所有本地存储（IndexedDB / Local Storage / Session Storage / WebStorage /
shared_proto_db / HTTP Cache）全扫了一遍找对话内容：

| 找什么 | 结果 |
|---|---|
| assistant 回复 / human 消息正文 | **0 命中** |
| `conversations/<uuid>` / 会话标题 / `chat_conversations` | **0 命中** |
| claude.ai 的 IndexedDB（668K leveldb）里实际有什么 | **只有未发送的草稿** |

claude.ai 的 IndexedDB 里唯一像样的内容是**输入框草稿**（TipTap 编辑器状态），
不是对话历史：

```json
{"state":{"tipTapEditorState":{"type":"doc","content":[{"type":"paragraph",
"content":[{"type":"text","text":"wo"}]}]},"attachments":[],"files":[],
"syncSourceUuids":[],"queuedMessages":[]},"version":1,"updatedAt":1782633953480}
```

（`"text":"wo"` 就是当时输到一半还没发的字。）

**结论：桌面 app 是个薄客户端，对话历史实时从 claude.ai 的 API 拉取渲染，本地几乎
不落盘。标准聊天的真身在 Anthropic 服务器端（你的 claude.ai 账号里）。**

这跟 ai2nao 现有**所有**数据源的根本假设冲突——CLI JSONL、Cursor、VS Code、Codex、
Cherry Studio 全是**本地文件**，ai2nao 是"只读本地文件"的 local-first 设计。

---

## 3. 本地**确实有**的：app 内置 agent / cowork 模式

桌面 app 里的"写代码 / agent / cowork"模式（不是标准聊天）会**落本地**：

```
~/Library/Application Support/Claude/claude-code-sessions/<acct>/<ws>/local_*.json
~/Library/Application Support/Claude/local-agent-mode-sessions/<acct>/<ws>/
    ├── local_<id>/audit.jsonl        ← 含 user/assistant 逐条消息
    ├── spaces.json · cowork-*-cache.json
```

`audit.jsonl` 格式跟 CLI transcript 很像（`type` / `uuid` / `session_id` /
`message.role` / `message.content`），带 `client_platform: "desktop_app"`：

```json
{"type":"user","uuid":"7ad9...","session_id":"9c0e...","parent_tool_use_id":null,
"client_platform":"desktop_app","message":{"role":"user","content":"耕地流转合同..."}}
```

**这是 app 里的 agent/cowork 会话，不是用户要的"标准聊天"。** 但若将来想做，它是
本地可拿、格式接近 CLI、可复用现有解析的一类数据。

---

## 4. 要纳入标准聊天，只有三条路（都各有硬代价）

| 路线 | 怎么拿 | 代价 / 风险 |
|---|---|---|
| **A. 官方 data export** | claude.ai 手动「导出数据」→ 邮件收到 zip（`conversations.json`：每个会话含 human/assistant 消息、时间、附件）→ 放进某目录，ai2nao 解析入库 | 唯一既拿到标准聊天、又守住 local-first 的路；但**手动触发、是周期性快照、非实时** |
| **B. 只纳入本地 agent 模式数据** | 直接索引 §3 的 `claude-code-sessions` / `local-agent-mode` | 实时、零授权、复用 CLI 解析；但**不是标准聊天**，范围不同 |
| **C. claude.ai API 实时拉** | 用 app 登录态/token 打 claude.ai 内部 API | 拿实时全量；但依赖**非公开 API（随时变）**、要处理账号鉴权、**彻底打破"只读本地文件"模型**，维护风险最高 |

---

## 5. 决定：搁置

当前不做。原因：标准聊天本地不可得，三条路里 A 最稳但只是手动快照、B 不是用户要的
东西、C 破坏架构原则且依赖非公开 API。投入产出此刻不划算。

**将来重启的触发条件**（任一）：
- 你愿意接受"手动周期导出"的体验 → 走 A，按 `conversations.json` 写一个 import 解析器
  （新增 source = `claude-desktop`，落到现有 chat session 模型里）。
- 你想要的其实是"桌面 app 的 agent/cowork 历史" → 走 B，比 A 简单得多。
- Anthropic 出了官方本地导出/同步或稳定 API → 重新评估 A/C。

---

## 6. 复用：怎么再验一次"桌面 app 到底存没存对话"

```bash
APP=~/Library/Application\ Support/Claude

# 1. claude.ai 的 IndexedDB 里有没有对话(只读 strings,期望只看到草稿 tipTapEditorState)
cat "$APP"/IndexedDB/https_claude.ai_0.indexeddb.leveldb/*.log 2>/dev/null \
  | strings | awk 'length>80' | head

# 2. 全存储扫 assistant/human 消息、会话 uuid(期望 0 命中 = 本地无对话历史)
LC_ALL=C find "$APP"/IndexedDB "$APP"/Local\ Storage "$APP"/Session\ Storage \
  "$APP"/WebStorage "$APP"/shared_proto_db -type f 2>/dev/null \
  | xargs cat 2>/dev/null | strings \
  | grep -aoiE "\"(role|sender)\":\"(assistant|human)\"|conversations/[0-9a-f-]{36}" | sort -u

# 3. 本地 agent 模式数据(期望能看到 user/assistant 逐条)
find "$APP"/claude-code-sessions "$APP"/local-agent-mode-sessions -name '*.jsonl' 2>/dev/null
```

---

## 7. 相关

- [`cursor-chat-storage.md`](cursor-chat-storage.md) — Cursor 本地对话存储（对照：那个是本地的）
- [`vscode-state-vscdb.md`](vscode-state-vscdb.md) — VS Code `state.vscdb`
- ai2nao 现有数据源都是本地文件型：`src/claudeCodeHistory`（CLI）、`src/codexHistory`、
  `src/cursorHistory`、Cherry Studio 等。
