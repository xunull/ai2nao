---
title: opencode「我的输入」抽屉：斜杠命令折叠与注入清洗
category: 数据源与同步
order: 67
---
# opencode「我的输入」抽屉：斜杠命令折叠与注入清洗

> opencode-history 的每个 session 有个「我的输入（已过滤注入）」抽屉，尽量只列
> **真人手打**的输入。opencode/oh-my-opencode 的注入**没有单一干净信号**，清洗只能
> best-effort。本文记录斜杠命令（slash command）展开的**折叠**，以及它所处的整条
> 注入清洗管线。
>
> 核心原则：**误删 > 漏删**——过度 strip 删掉真人内容，比漏掉注入更糟。边界不明确
> 一律保留原文，绝不静默删。
>
> 实现：Phase 3B（`211c774` 折叠 + `1aa0fea` OMO 过滤）。落地代码见
> `src/opencodeHistory/myMessages.ts`。

---

## 1. 为什么需要折叠

用户在 opencode 里打一个斜杠命令（如 `/graphify`、`/agents`），oh-my-opencode 会把它
**展开成一段 ~2000 字的模板 prompt**（命令定义、用法、约束……），作为该 user 轮的正文。
这段展开不是"我说的"，但整段塞进抽屉会把真实输入淹掉。

实测：`~/.local/share/opencode/opencode.db` 里 **52 / 1786** 条 user 文本 part 含斜杠命令
展开标记 `<auto-slash-command>`。

**折叠** = 把这类展开收成一行「命令 /name」，点击可展开看全文——既不删（可展开），
又不占屏。

## 2. 数据形态（实测）

斜杠命令展开在**经过 mode 前导剥离之后**（见 §4）的正文**开头**，结构固定：

```
<auto-slash-command>
# /graphify Command

**Description**: (opencode – Skill) any input (code, docs, …) → knowledge graph …
**User Arguments**: …
…（约 2000 字模板）
```

- `<auto-slash-command>` 是**结构标记**，紧跟 `# /<name> Command` 头。
- `<name>` 可含 `-` `:` `.`（如 `foo-bar`、`foo:bar`、`ns.cmd`）。

## 3. 折叠的识别规则（服务端）

折叠判定放**服务端**（清洗产物的一部分），前端只按 tag 渲染——不让前端重解析正文，
避免清洗规则与 UI 判定分叉。

`src/opencodeHistory/myMessages.ts` 的 `detectSlashCommand(cleanedText)`：

```
清洗后 text ──▶ 命中锚?  ^<auto-slash-command>\s*#\s*/([A-Za-z0-9][A-Za-z0-9._:-]*)\s+Command
                  │是                             （NAME = 命令名，支持 - : .）
                  ▼
             { name: NAME }   →  前端折叠成「命令 /NAME」+ 可展开
                  │否
                  ▼
             null   →  普通消息，正常显示（不折叠）
```

保守 + prefer-preserve（承 mode 剥的原则）：

- **只在开头触发**：正则用 `^`（anchored），**不是** `includes`。正文中段偶然出现
  `<auto-slash-command>`（用户引用它）不折叠。
- **提取失败 → 不折叠**：有 marker 但取不到合法 `# /<name> Command` 头 → 返回 null，
  当普通文本显示（不藏内容）。
- **空白容忍**：marker 与 header 之间容 CRLF / 一个空行（`\s*`），但 marker 必须在
  char 0（不容任意前缀空白，保住"开头"语义）。
- **只认第一个块**：一条消息只标第一个合法命令、折叠整条；不拆一条消息里的多个块
  （无可靠边界）。
- **版本漂移**：`<auto-slash-command>` / header 格式是当前 oh-my-opencode 形态，将来
  变了 → 失配 → null → 普通显示，不崩。

## 4. 折叠在整条清洗管线里的位置

折叠是**最后一步**，作用在已清洗（去注入 + 剥 mode 前导）的正文上。完整管线
（`cleanOpencodeUserMessageParts` 逐 part + `loadOpencodeMyMessages` 逐 message）：

```
一条 user message 的每个 part
   │
   ├─ 非 text part                          → 跳过（不进抽屉）
   ├─ 结构注入(有标记)                       → 整条丢
   │     · part.metadata.kind==="editor_context"   （IDE 文件打开注入）
   │     · part.metadata.compaction_continue===true（compaction 续写）
   │     · part.synthetic===true                    （ultrawork-mode 等插件块）
   ├─ OMO 背景任务注入(§5)                    → 整条丢
   │     · 含 OMO_INTERNAL_INITIATOR
   │     · 或完整 <system-reminder>…</system-reminder> 块
   ├─ mode 前导(oh-my-opencode)              → 保守锚定前缀剥
   │     · 文本以 [xxx-mode] 开头 → 按 --- 分段，逐块吃掉命中
   │       [xxx-mode] / MANDATORY delegate_task 的前导块，
   │       遇第一个非前导块即停、保留其及其后全部（含正文里的 ---/HR）
   │     · 不明确 → 保留原文
   └─ 剩余真实文本
         │
         ▼
   message 级：多个保留 text part 按原序空行 join
         │
         ▼
   detectSlashCommand(joined)  →  命中则打 slashCommand={name}（§3）
         │
         ▼
   { id, timestamp, text, slashCommand? }   →  /my-messages 返回，前端渲染
```

## 5. 连带修复：OMO 背景任务 `<system-reminder>` 注入

折叠上线时 browse 实测发现另一种注入漏进抽屉：oh-my-opencode 的**背景任务通知**
（`<system-reminder> [BACKGROUND TASK COMPLETED] … OMO_INTERNAL_INITIATOR`）冒充 user 轮，
**且无 synthetic 标记**。

实测占比惊人：**1266 / 1786 ≈ 71%** 的 user 文本 part 含 `OMO_INTERNAL_INITIATOR`。抽屉此前
大部分是这种噪音。

修复（`isOmoInjection`，整条 part 丢）：

- 含 `OMO_INTERNAL_INITIATOR`（oh-my-opencode 内部标记，真人绝不会打）→ 丢。
- 或完整 `<system-reminder>…</system-reminder>` 块（需开+闭标签；prefer-preserve：真人
  只提到 `<system-reminder>` 而无闭合 → 保留，不误伤）。

效果：某 graphify 会话「我的输入」**86 → 44 条**，残留 OMO/system-reminder = 0。

## 6. 架构与文件

| 层 | 文件 | 职责 |
|---|---|---|
| 清洗（纯函数） | `src/opencodeHistory/myMessages.ts` | `isStructuralInjection` / `isOmoInjection` / `stripModePreamble` / `cleanOpencodeUserMessageParts` / `detectSlashCommand` |
| 取数（projection） | `src/opencodeHistory/load.ts` | `loadOpencodeMyMessages` —— 复用 Phase 1 `loadSessionMessagesAndParts`（同只读快照，part.data 带 metadata/synthetic），逐 user message 清洗 + 打 `slashCommand` |
| 路由 | `src/serve/app.ts` | `GET /api/opencode-history/sessions/:id/my-messages` → `{ ok, messages: [{id,timestamp,text,slashCommand?}] }` |
| 前端 | `web/src/components/OpencodeMyMessagesSheet.tsx` | 有 `slashCommand` 的条目默认折叠（`<details>`「命令 /name」+ 展开全文）；普通消息不折叠 |

- **API additive**：`slashCommand?: { name: string }` 是可选字段；普通消息响应**不带**该键
  （不是 `slashCommand: null`），兼容旧前端。
- **诚实文案**：抽屉标题「我的输入（已过滤注入）」、副标「best-effort，可能含斜杠命令展开」、
  空态「未检测到可安全归类为手动输入的文本；已过滤 opencode / 编辑器 / 插件注入内容。」
  ——不假装是"纯手打"。

## 7. 边界 / 局限

- **best-effort，非数据真相**：标记/格式是当前 oh-my-opencode 形态，版本变可能失配 →
  退化为普通显示（不误折、不删）。
- **残留**：不带 `<auto-slash-command>` 标记的其它模板展开（如某些 AGENTS.md 模板）仍会
  以普通消息显示——诚实文案兜底。
- **mode 白名单**：mode 前导按 `[xxx-mode]` 头识别，新 mode 会漏（漏删可接受）。

## 8. 相关

- 上游：`docs/`（无独立文件）+ 计划
  `~/.gstack/projects/xunull-ai2nao/20260630-design-opencode-my-messages-drawer.md`（Phase 2 清洗）、
  `20260701-design-opencode-phase3.md`（Phase 3B 折叠 + A token 延后）。
- 测试：`test/opencodeMyMessages.test.ts`（清洗 + `detectSlashCommand` + OMO 边界）、
  `test/opencodeHistory.routes.test.ts`（`/my-messages` 端到端）、
  `test/OpencodeHistory.test.tsx`（抽屉折叠渲染）。
- 未做：A —— opencode token/cost 接工作看板（跨 ~10 文件的 `DashboardSource` 联合扩张，
  独立一轮）。
